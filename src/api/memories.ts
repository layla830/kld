import { authenticate } from "../auth/apiKey";
import { requireScope } from "../auth/scopes";
import { getOrCreateConversation } from "../db/conversations";
import {
  createMemory,
  ensureMemoryVectorId,
  getMemoryById,
  listMemories,
  softDeleteMemory,
  updateMemory
} from "../db/memories";
import { saveIngestMessages } from "../db/messages";
import { deleteMemoryEmbedding, upsertMemoryEmbedding } from "../memory/embedding";
import { splitDiaryMemories } from "../memory/diarySplit";
import { filterAndCompressMemoriesWithMeta } from "../memory/filter";
import { searchMemories, toMemoryApiRecord } from "../memory/search";
import { enqueueMemoryMaintenanceIfNeeded } from "../queue/producer";
import type { Env, KeyProfile, MemoryApiRecord, OpenAIChatMessage } from "../types";
import { json, openAiError } from "../utils/json";
import {
  readBody,
  readBoolean,
  readNumber,
  readOptionalString,
  readString,
  readStringArray,
  resolveNamespace
} from "./common";
import { handleExtractCcConnectLocalChunk, handleGenerateCcConnectDiaryFromMessages, handleResetCcConnect } from "./ccConnect";

const AUTO_DIARY_TYPE = "auto_diary";

type MemoryResponseRecord = MemoryApiRecord | Omit<
  MemoryApiRecord,
  "source" | "source_message_ids" | "vector_id" | "last_recalled_at" | "recall_count" | "expires_at"
>;

function normalizeLimit(value: string | null, fallback = 50): number {
  const parsed = Number(value || fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), 1), 100);
}

function cleanMemoryForResponse(record: MemoryApiRecord): MemoryResponseRecord {
  if (record.type !== AUTO_DIARY_TYPE) return record;

  const {
    source: _source,
    source_message_ids: _sourceMessageIds,
    vector_id: _vectorId,
    last_recalled_at: _lastRecalledAt,
    recall_count: _recallCount,
    expires_at: _expiresAt,
    ...clean
  } = record;
  return clean;
}

function cleanMemoriesForResponse(records: MemoryApiRecord[]): MemoryResponseRecord[] {
  return records.map((record) => cleanMemoryForResponse(record));
}

function excludeAutoDiaryUnlessRequested(records: MemoryApiRecord[], requestedTypes: string[]): MemoryApiRecord[] {
  if (requestedTypes.includes(AUTO_DIARY_TYPE)) return records;
  return records.filter((record) => record.type !== AUTO_DIARY_TYPE);
}

async function handleCreateMemory(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  profile: KeyProfile
): Promise<Response> {
  const scopeError = requireScope(profile, "memory:write");
  if (scopeError) return scopeError;

  const body = await readBody(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const content = readString(body.content);
  const type = readString(body.type) || "note";

  if (!content) {
    return openAiError("content is required", 400);
  }

  const memory = await createMemory(env.DB, {
    namespace: resolveNamespace(profile, body.namespace),
    type,
    content,
    summary: readOptionalString(body.summary),
    factKey: readOptionalString(body.fact_key),
    activeFact: typeof body.active_fact === "boolean" ? readBoolean(body.active_fact) : undefined,
    importance: readNumber(body.importance, 0.5),
    confidence: readNumber(body.confidence, 0.8),
    status: readString(body.status) || "active",
    pinned: readBoolean(body.pinned),
    tags: readStringArray(body.tags),
    source: readOptionalString(body.source) || profile.source,
    sourceMessageIds: readStringArray(body.source_message_ids),
    expiresAt: readOptionalString(body.expires_at)
  });

  ctx.waitUntil(
    upsertMemoryEmbedding(env, memory).catch((error) => {
      console.error("failed to upsert memory embedding", error);
    })
  );

  return json({ data: cleanMemoryForResponse(toMemoryApiRecord(memory)) }, { status: 201 });
}

async function handleListMemories(request: Request, env: Env, profile: KeyProfile): Promise<Response> {
  const scopeError = requireScope(profile, "memory:read");
  if (scopeError) return scopeError;

  const url = new URL(request.url);
  const namespace = resolveNamespace(profile, url.searchParams.get("namespace"));
  const type = url.searchParams.get("type") || undefined;
  const limit = normalizeLimit(url.searchParams.get("limit"), 50);
  const records = await listMemories(env.DB, {
    namespace,
    type,
    status: url.searchParams.get("status") || "active",
    limit: type ? limit : 100
  });
  const apiRecords = records.map((record) => toMemoryApiRecord(record));
  const visibleRecords = type ? apiRecords : excludeAutoDiaryUnlessRequested(apiRecords, []).slice(0, limit);

  return json({ data: cleanMemoriesForResponse(visibleRecords) });
}

async function handleSearchMemories(request: Request, env: Env, profile: KeyProfile): Promise<Response> {
  const scopeError = requireScope(profile, "memory:read");
  if (scopeError) return scopeError;

  const body = await readBody(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const query = readString(body.query) || "";
  const topK = readNumber(body.top_k, Number(env.MEMORY_TOP_K || 8));
  const requestedTypes = readStringArray(body.types);
  const raw = excludeAutoDiaryUnlessRequested(
    await searchMemories(env, {
      namespace: resolveNamespace(profile, body.namespace),
      query,
      topK,
      types: requestedTypes
    }),
    requestedTypes
  );

  if (body.filter !== true && body.compress !== true) {
    return json({ data: cleanMemoriesForResponse(raw) });
  }

  const filtered = await filterAndCompressMemoriesWithMeta(env, { query, memories: raw });
  return json({
    data: cleanMemoriesForResponse(filtered.data),
    meta: {
      raw_count: raw.length,
      filter: filtered.meta
    }
  });
}

function readMessages(value: unknown): OpenAIChatMessage[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item): OpenAIChatMessage[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as { role?: unknown; content?: unknown; created_at?: unknown; timestamp?: unknown };
    if (record.role !== "system" && record.role !== "user" && record.role !== "assistant") {
      return [];
    }

    if (typeof record.content !== "string" || !record.content.trim()) {
      return [];
    }

    return [
      {
        role: record.role,
        content: record.content,
        created_at: readString(record.created_at) || readString(record.timestamp)
      }
    ];
  });
}

async function handleIngestMemories(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  profile: KeyProfile
): Promise<Response> {
  const scopeError = requireScope(profile, "memory:write");
  if (scopeError) return scopeError;

  const body = await readBody(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const messages = readMessages(body.messages);
  if (messages.length === 0) return openAiError("messages must contain at least one message", 400);

  const namespace = resolveNamespace(profile, body.namespace);
  const conversation = await getOrCreateConversation(env.DB, {
    namespace,
    id: readString(body.conversation_id)
  });
  const source = readString(body.source) || profile.source;
  const ids = await saveIngestMessages(env.DB, {
    conversationId: conversation.id,
    namespace,
    source,
    messages
  });

  if (body.auto_extract !== false && ids.length > 0) {
    ctx.waitUntil(
      enqueueMemoryMaintenanceIfNeeded(env, {
        namespace,
        conversationId: conversation.id,
        fromMessageId: ids[0],
        toMessageId: ids[ids.length - 1],
        source
      })
    );
  }

  return json({
    data: {
      conversation_id: conversation.id,
      message_ids: ids,
      auto_extract: body.auto_extract !== false
    }
  });
}

async function handleSplitDiaryMemories(request: Request, env: Env, profile: KeyProfile): Promise<Response> {
  const scopeError = requireScope(profile, "memory:write");
  if (scopeError) return scopeError;

  const body = await readBody(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const plans = await splitDiaryMemories(env, {
    namespace: resolveNamespace(profile, body.namespace),
    ids: readStringArray(body.ids),
    dates: readStringArray(body.dates),
    apply: body.apply === true,
    force: body.force === true
  });

  return json({
    data: {
      apply: body.apply === true,
      diary_count: plans.length,
      item_count: plans.reduce((sum, plan) => sum + plan.items.length, 0),
      fact_key_count: plans.reduce((sum, plan) => sum + plan.items.filter((item) => item.fact_key).length, 0),
      plans
    }
  });
}

async function handlePatchMemory(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  profile: KeyProfile,
  id: string
): Promise<Response> {
  const scopeError = requireScope(profile, "memory:write");
  if (scopeError) return scopeError;

  const body = await readBody(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const namespace = resolveNamespace(profile, body.namespace);
  const patch = {
    type: readString(body.type),
    content: readString(body.content),
    summary: readOptionalString(body.summary),
    factKey: body.fact_key === undefined ? undefined : readOptionalString(body.fact_key),
    activeFact: typeof body.active_fact === "boolean" ? readBoolean(body.active_fact) : undefined,
    importance: typeof body.importance === "number" ? readNumber(body.importance, 0.5) : undefined,
    confidence: typeof body.confidence === "number" ? readNumber(body.confidence, 0.8) : undefined,
    status: readString(body.status),
    pinned: typeof body.pinned === "boolean" ? readBoolean(body.pinned) : undefined,
    tags: Array.isArray(body.tags) ? readStringArray(body.tags) : undefined,
    expiresAt: body.expires_at === undefined ? undefined : readOptionalString(body.expires_at)
  };

  const updated = await updateMemory(env.DB, {
    namespace,
    id,
    patch
  });

  if (!updated) return openAiError("Memory not found", 404);

  const embeddable = updated.status === "active" ? await ensureMemoryVectorId(env.DB, { namespace, id }) : updated;
  if (!embeddable) return openAiError("Memory not found", 404);

  ctx.waitUntil(
    (embeddable.status === "active" ? upsertMemoryEmbedding(env, embeddable) : deleteMemoryEmbedding(env, embeddable)).catch((error) => {
      console.error("failed to sync memory embedding", error);
    })
  );

  return json({ data: cleanMemoryForResponse(toMemoryApiRecord(embeddable)) });
}

async function handleDeleteMemory(
  env: Env,
  ctx: ExecutionContext,
  profile: KeyProfile,
  id: string
): Promise<Response> {
  const scopeError = requireScope(profile, "memory:write");
  if (scopeError) return scopeError;

  const deleted = await softDeleteMemory(env.DB, {
    namespace: profile.namespace,
    id
  });

  if (!deleted) return openAiError("Memory not found", 404);

  ctx.waitUntil(
    deleteMemoryEmbedding(env, deleted).catch((error) => {
      console.error("failed to delete memory embedding", error);
    })
  );

  return json({ data: cleanMemoryForResponse(toMemoryApiRecord(deleted)) });
}

async function handleGetMemory(env: Env, profile: KeyProfile, id: string): Promise<Response> {
  const scopeError = requireScope(profile, "memory:read");
  if (scopeError) return scopeError;

  const memory = await getMemoryById(env.DB, {
    namespace: profile.namespace,
    id
  });

  if (!memory) return openAiError("Memory not found", 404);
  return json({ data: cleanMemoryForResponse(toMemoryApiRecord(memory)) });
}

export async function handleMemories(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const tail = parts.slice(2);

  if (tail.length === 0 && request.method === "GET") {
    return handleListMemories(request, env, auth.profile);
  }

  if (tail.length === 0 && request.method === "POST") {
    return handleCreateMemory(request, env, ctx, auth.profile);
  }

  if (tail.length === 1 && tail[0] === "search" && request.method === "POST") {
    return handleSearchMemories(request, env, auth.profile);
  }

  if (tail.length === 1 && tail[0] === "ingest" && request.method === "POST") {
    return handleIngestMemories(request, env, ctx, auth.profile);
  }

  if (tail.length === 1 && tail[0] === "split-diary" && request.method === "POST") {
    return handleSplitDiaryMemories(request, env, auth.profile);
  }

  if (tail.length === 2 && tail[0] === "auto-diary" && tail[1] === "cc-connect-local" && request.method === "POST") {
    return handleGenerateCcConnectDiaryFromMessages(request, env, ctx, auth.profile);
  }

  if (tail.length === 2 && tail[0] === "chunk-extract" && tail[1] === "cc-connect-local" && request.method === "POST") {
    return handleExtractCcConnectLocalChunk(request, env, auth.profile);
  }

  if (tail.length === 2 && tail[0] === "reset" && tail[1] === "cc-connect" && request.method === "POST") {
    const body = await readBody(request);
    return handleResetCcConnect(env, auth.profile, resolveNamespace(auth.profile, body?.namespace || "kld"));
  }

  if (tail.length === 1) {
    const id = tail[0];
    if (request.method === "GET") return handleGetMemory(env, auth.profile, id);
    if (request.method === "PATCH") return handlePatchMemory(request, env, ctx, auth.profile, id);
    if (request.method === "DELETE") return handleDeleteMemory(env, ctx, auth.profile, id);
  }

  return openAiError("Not found", 404);
}
