import { authenticate } from "../auth/apiKey";
import { requireScope } from "../auth/scopes";
import { getOrCreateConversation } from "../db/conversations";
import {
  createMemory,
  ensureMemoryVectorId,
  getMemoryById,
  listMemories,
  listUnsyncedVectorMemories,
  softDeleteMemory,
  updateMemory
} from "../db/memories";
import { saveIngestMessages } from "../db/messages";
import { deleteMemoryEmbedding, upsertMemoryEmbedding } from "../memory/embedding";
import {
  normalizeAuditState,
  normalizeResponsePosture,
  normalizeRiskLevel,
  normalizeTensionScore,
  normalizeThread,
  normalizeUrgencyLevel
} from "../memory/coordinates";
import { splitDiaryMemories } from "../memory/diarySplit";
import { filterAndCompressMemoriesWithMeta } from "../memory/filter";
import { searchMemories, toMemoryApiRecord } from "../memory/search";
import { enqueueDiarySplitIfNeeded, enqueueMemoryMaintenanceIfNeeded } from "../queue/producer";
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
import { handleResetCcConnect } from "./ccConnect";

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

function memoryRouteFailure(request: Request, error: unknown): Response {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);
  console.error(JSON.stringify({
    event: "memory_api_unhandled_error",
    request_id: requestId,
    method: request.method,
    path: url.pathname,
    error: error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { message: String(error) }
  }));
  return json(
    {
      error: {
        message: "Memory operation failed",
        type: "server_error",
        param: null,
        code: "memory_operation_failed",
        request_id: requestId
      }
    },
    { status: 500, headers: { "x-request-id": requestId } }
  );
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
    thread: normalizeThread(body.thread),
    riskLevel: normalizeRiskLevel(body.risk_level),
    urgencyLevel: normalizeUrgencyLevel(body.urgency_level),
    tensionScore: normalizeTensionScore(body.tension_score),
    responsePosture: normalizeResponsePosture(body.response_posture),
    auditState: normalizeAuditState(body.audit_state),
    importance: readNumber(body.importance, 0.5),
    confidence: readNumber(body.confidence, 0.8),
    status: readString(body.status) || "active",
    pinned: readBoolean(body.pinned),
    tags: readStringArray(body.tags),
    source: readOptionalString(body.source) || profile.source,
    sourceMessageIds: readStringArray(body.source_message_ids),
    expiresAt: readOptionalString(body.expires_at)
  });

  ctx.waitUntil(Promise.all([
    upsertMemoryEmbedding(env, memory),
    enqueueDiarySplitIfNeeded(env, memory)
  ]).catch((error) => {
    console.error("failed to schedule memory background work", error);
  }));

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
    factKey: url.searchParams.get("fact_key") || undefined,
    thread: url.searchParams.get("thread") || undefined,
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
  const search = await searchMemories(env, {
    namespace: resolveNamespace(profile, body.namespace),
    query,
    topK,
    types: requestedTypes
  });
  const raw = excludeAutoDiaryUnlessRequested(
    search.records,
    requestedTypes
  );
  const searchMeta = {
    status: search.status,
    degraded_sources: search.degradations.map(({ source, code }) => ({ source, code }))
  };

  if (body.filter !== true && body.compress !== true) {
    return json({ data: cleanMemoriesForResponse(raw), meta: { search: searchMeta } });
  }

  const filtered = await filterAndCompressMemoriesWithMeta(env, { query, memories: raw });
  return json({
    data: cleanMemoriesForResponse(filtered.data),
    meta: {
      raw_count: raw.length,
      search: searchMeta,
      filter: filtered.meta
    }
  });
}

async function handleResyncVectorMemories(request: Request, env: Env, profile: KeyProfile): Promise<Response> {
  const scopeError = requireScope(profile, "memory:write");
  if (scopeError) return scopeError;

  const body = await readBody(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const namespace = resolveNamespace(profile, body.namespace);
  const ids = readStringArray(body.ids);
  const force = body.force === true;
  const limit = Math.min(readNumber(body.limit, ids.length || 20), 50);
  const candidates = await listUnsyncedVectorMemories(env.DB, { namespace, ids, force, limit });
  const results = [];

  for (const candidate of candidates) {
    const memory = candidate.vector_id ? candidate : await ensureMemoryVectorId(env.DB, { namespace, id: candidate.id });
    if (!memory) {
      results.push({ id: candidate.id, ok: false, reason: "not_found" });
      continue;
    }

    try {
      const ok = await upsertMemoryEmbedding(env, memory);
      results.push({ id: memory.id, ok, fact_key: memory.fact_key, reason: ok ? "synced" : "embedding_unavailable" });
    } catch (error) {
      console.error("failed to resync memory embedding", memory.id, error);
      results.push({ id: memory.id, ok: false, fact_key: memory.fact_key, reason: "error" });
    }
  }

  return json({
    data: {
      namespace,
      requested: ids.length || null,
      force,
      scanned: candidates.length,
      synced: results.filter((result) => result.ok).length,
      results
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
    force: body.force === true,
    debug: body.debug === true,
    replaceImporter: readOptionalString(body.replace_importer) ?? undefined
  });

  return json({
    data: {
      apply: body.apply === true,
      replace_importer: readOptionalString(body.replace_importer) ?? null,
      diary_count: plans.length,
      item_count: plans.reduce((sum, plan) => sum + plan.items.length, 0),
      fact_key_count: plans.reduce((sum, plan) => sum + plan.items.filter((item) => item.fact_key).length, 0),
      review_candidate_count: plans.reduce((sum, plan) => sum + plan.items.filter((item) => item.review_required).length, 0),
      auto_item_count: plans.reduce((sum, plan) => sum + plan.items.filter((item) => !item.review_required).length, 0),
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
    thread: body.thread === undefined ? undefined : normalizeThread(body.thread),
    riskLevel: body.risk_level === undefined ? undefined : normalizeRiskLevel(body.risk_level),
    urgencyLevel: body.urgency_level === undefined ? undefined : normalizeUrgencyLevel(body.urgency_level),
    tensionScore: body.tension_score === undefined ? undefined : normalizeTensionScore(body.tension_score),
    responsePosture: body.response_posture === undefined ? undefined : normalizeResponsePosture(body.response_posture),
    auditState: body.audit_state === undefined ? undefined : normalizeAuditState(body.audit_state),
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
  try {
    const auth = await authenticate(request, env);
    if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const tail = parts.slice(2);

    if (tail.length === 0 && request.method === "GET") {
      return await handleListMemories(request, env, auth.profile);
    }

    if (tail.length === 0 && request.method === "POST") {
      return await handleCreateMemory(request, env, ctx, auth.profile);
    }

    if (tail.length === 1 && tail[0] === "search" && request.method === "POST") {
      return await handleSearchMemories(request, env, auth.profile);
    }

    if (tail.length === 1 && tail[0] === "resync-vectors" && request.method === "POST") {
      return await handleResyncVectorMemories(request, env, auth.profile);
    }

    if (tail.length === 1 && tail[0] === "ingest" && request.method === "POST") {
      return await handleIngestMemories(request, env, ctx, auth.profile);
    }

    if (tail.length === 1 && tail[0] === "split-diary" && request.method === "POST") {
      return await handleSplitDiaryMemories(request, env, auth.profile);
    }

    if (tail.length === 2 && tail[0] === "reset" && tail[1] === "cc-connect" && request.method === "POST") {
      const body = await readBody(request);
      return await handleResetCcConnect(env, auth.profile, resolveNamespace(auth.profile, body?.namespace || "kld"));
    }

    if (tail.length === 1) {
      const id = tail[0];
      if (request.method === "GET") return await handleGetMemory(env, auth.profile, id);
      if (request.method === "PATCH") return await handlePatchMemory(request, env, ctx, auth.profile, id);
      if (request.method === "DELETE") return await handleDeleteMemory(env, ctx, auth.profile, id);
    }

    return openAiError("Not found", 404);
  } catch (error) {
    return memoryRouteFailure(request, error);
  }
}
