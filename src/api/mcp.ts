import { authenticate } from "../auth/apiKey";
import { createMemory, listMemories, softDeleteMemory, updateMemory } from "../db/memories";
import { deleteMemoryEmbedding, upsertMemoryEmbedding } from "../memory/embedding";
import { searchMemories, toMemoryApiRecord } from "../memory/search";
import { buildStartupContext } from "../memory/startupContext";
import type { Env, KeyProfile, MemoryRecord, Scope } from "../types";
import { json } from "../utils/json";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

interface ToolCallParams {
  name?: unknown;
  arguments?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function readFlexibleStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return readStringArray(value);
  if (typeof value === "string") return value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function readOptionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  return readStringArray(value);
}

function resolveNamespace(profile: KeyProfile, requested: unknown): string {
  return profile.debug && typeof requested === "string" && requested.trim() ? requested.trim() : profile.namespace;
}

function hasScope(profile: KeyProfile, scope: Scope): boolean {
  return profile.scopes.includes(scope);
}

function rpcResult(id: JsonRpcId | undefined, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: JsonRpcId | undefined, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function textToolResult(data: unknown): Record<string, unknown> {
  return {
    content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
    structuredContent: data
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: "text", text: message }], isError: true };
}

function waitForBackground(ctx: ExecutionContext, task: Promise<unknown>): void {
  ctx.waitUntil(task.catch((error) => console.error("background memory task failed", error)));
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

function getTools(): Array<Record<string, unknown>> {
  const searchSchema = {
    type: "object",
    properties: {
      query: { type: "string" },
      top_k: { type: "number", minimum: 1, maximum: 50 },
      types: { type: "array", items: { type: "string" } }
    },
    required: ["query"]
  };
  const tagSearchSchema = {
    type: "object",
    properties: {
      tags: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
      match_all: { type: "boolean" },
      limit: { type: "number", minimum: 1, maximum: 100 }
    },
    required: ["tags"]
  };
  const createSchema = {
    type: "object",
    properties: {
      content: { type: "string" },
      type: { type: "string" },
      tags: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] },
      importance: { type: "number", minimum: 0, maximum: 1 },
      pinned: { type: "boolean" }
    },
    required: ["content"]
  };
  const updateSchema = {
    type: "object",
    properties: {
      id: { type: "string" },
      content: { type: "string" },
      type: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      importance: { type: "number", minimum: 0, maximum: 1 },
      pinned: { type: "boolean" }
    },
    required: ["id"]
  };
  const listSchema = {
    type: "object",
    properties: {
      page: { type: "number", minimum: 1 },
      page_size: { type: "number", minimum: 1, maximum: 100 },
      type: { type: "string" },
      tag: { type: "string" },
      status: { type: "string" }
    }
  };
  const deleteSchema = {
    type: "object",
    properties: {
      id: { type: "string" }
    },
    required: ["id"]
  };

  return [
    { name: "retrieve_memory", description: "Search long-term memories.", inputSchema: searchSchema },
    { name: "search_by_tag", description: "Find active memories by tag.", inputSchema: tagSearchSchema },
    { name: "store_memory", description: "Save one memory.", inputSchema: createSchema },
    { name: "update_memory", description: "Edit one memory by id.", inputSchema: updateSchema },
    { name: "list_memories", description: "List memories with simple filters.", inputSchema: listSchema },
    { name: "delete_memory", description: "Soft-delete one memory by id.", inputSchema: deleteSchema },
    { name: "check_database_health", description: "Show memory database counts.", inputSchema: { type: "object", properties: {} } },
    { name: "get_startup_context", description: "Get compact startup context.", inputSchema: { type: "object", properties: {} } }
  ];
}

async function findMemoryByContentHash(db: D1Database, namespace: string, hash: string): Promise<MemoryRecord | null> {
  const row = await db
    .prepare("SELECT * FROM memories WHERE namespace = ? AND instr(source_message_ids, ?) > 0 LIMIT 1")
    .bind(namespace, `hash:${hash}`)
    .first<MemoryRecord>();
  return row ?? null;
}

async function listMemoriesCompat(db: D1Database, args: Record<string, unknown>, namespace: string): Promise<{ memories: ReturnType<typeof toMemoryApiRecord>[]; total: number; page: number; page_size: number }> {
  const page = Math.max(1, Math.floor(readNumber(args.page, 1)));
  const pageSize = Math.min(Math.max(Math.floor(readNumber(args.page_size, readNumber(args.limit, 50))), 1), 100);
  const offset = (page - 1) * pageSize;
  const status = readString(args.status) || "active";
  const type = readString(args.type) || readString(args.memory_type);
  const tag = readString(args.tag);

  let where = "WHERE namespace = ?";
  const binds: unknown[] = [namespace];
  if (status !== "all") {
    where += " AND status = ?";
    binds.push(status);
  }
  if (type) {
    where += " AND type = ?";
    binds.push(type);
  }
  if (tag) {
    where += " AND tags LIKE ? ESCAPE '\\'";
    binds.push(likePattern(tag));
  }

  const total = await db.prepare(`SELECT COUNT(*) AS count FROM memories ${where}`).bind(...binds).first<{ count: number }>();
  const rows = await db
    .prepare(`SELECT * FROM memories ${where} ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ? OFFSET ?`)
    .bind(...binds, pageSize, offset)
    .all<MemoryRecord>();

  return {
    memories: (rows.results ?? []).map((record) => toMemoryApiRecord(record)),
    total: total?.count ?? 0,
    page,
    page_size: pageSize
  };
}

async function searchByTag(db: D1Database, args: Record<string, unknown>, namespace: string): Promise<{ results: ReturnType<typeof toMemoryApiRecord>[]; total: number }> {
  const tags = readFlexibleStringArray(args.tags);
  if (tags.length === 0) return { results: [], total: 0 };
  const matchAll = readBoolean(args.match_all, false);
  const limit = Math.min(Math.max(Math.floor(readNumber(args.limit, 50)), 1), 100);
  const clauses = tags.map(() => "tags LIKE ? ESCAPE '\\'");
  const where = `WHERE namespace = ? AND status = 'active' AND (${clauses.join(matchAll ? " AND " : " OR ")})`;
  const binds = [namespace, ...tags.map((tag) => likePattern(tag))];
  const rows = await db.prepare(`SELECT * FROM memories ${where} ORDER BY created_at DESC, updated_at DESC LIMIT ?`).bind(...binds, limit).all<MemoryRecord>();
  return { results: (rows.results ?? []).map((record) => toMemoryApiRecord(record)), total: rows.results?.length ?? 0 };
}

async function databaseHealth(db: D1Database, namespace: string): Promise<Record<string, unknown>> {
  const counts = await db.prepare(
    `SELECT
      COUNT(*) AS total_memories,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_memories,
      SUM(CASE WHEN status = 'deleted' THEN 1 ELSE 0 END) AS deleted_memories,
      SUM(CASE WHEN vector_id IS NOT NULL AND vector_id != '' THEN 1 ELSE 0 END) AS memories_with_embeddings
     FROM memories WHERE namespace = ?`
  ).bind(namespace).first<Record<string, number>>();
  const byType = await db.prepare(
    "SELECT type, COUNT(*) AS count FROM memories WHERE namespace = ? AND status = 'active' GROUP BY type ORDER BY count DESC"
  ).bind(namespace).all<{ type: string; count: number }>();
  return {
    status: "healthy",
    backend: "cloudflare-d1-vectorize",
    namespace,
    statistics: counts ?? {},
    types: byType.results ?? []
  };
}

async function callTool(env: Env, ctx: ExecutionContext, profile: KeyProfile, params: ToolCallParams): Promise<Record<string, unknown>> {
  const args = isRecord(params.arguments) ? params.arguments : {};

  if (params.name === "retrieve_memory" || params.name === "memory_search") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    const query = readString(args.query);
    if (!query) return toolError("query is required");
    const data = await searchMemories(env, {
      namespace: resolveNamespace(profile, args.namespace),
      query,
      topK: readNumber(args.top_k, readNumber(args.n_results, Number(env.MEMORY_TOP_K || 8))),
      types: readStringArray(args.types)
    });
    return textToolResult({ data });
  }

  if (params.name === "search_by_tag") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    return textToolResult(await searchByTag(env.DB, args, resolveNamespace(profile, args.namespace)));
  }

  if (params.name === "store_memory" || params.name === "memory_create") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    const content = readString(args.content) || readString(args.memory);
    if (!content) return toolError("content is required");
    const memory = await createMemory(env.DB, {
      namespace: resolveNamespace(profile, args.namespace),
      type: readString(args.type) || readString(args.memory_type) || "note",
      content,
      summary: readString(args.summary) || null,
      importance: readNumber(args.importance, 0.5),
      confidence: readNumber(args.confidence, 0.8),
      status: "active",
      pinned: readBoolean(args.pinned),
      tags: readFlexibleStringArray(args.tags),
      source: "mcp",
      sourceMessageIds: [],
      expiresAt: null
    });
    waitForBackground(ctx, upsertMemoryEmbedding(env, memory));
    const apiRecord = toMemoryApiRecord(memory);
    return textToolResult({ data: apiRecord, success: true, message: "Memory stored", id: memory.id, content_hash: memory.id });
  }

  if (params.name === "update_memory" || params.name === "memory_update") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    const id = readString(args.id) || readString(args.memory_id);
    if (!id) return toolError("id is required");

    const patch: Parameters<typeof updateMemory>[1]["patch"] = {};
    const content = readOptionalString(args.content) ?? readOptionalString(args.memory);
    const type = readString(args.type) || readString(args.memory_type);
    const tags = readOptionalStringArray(args.tags);
    const summary = readOptionalString(args.summary);
    const importance = readOptionalNumber(args.importance);
    const confidence = readOptionalNumber(args.confidence);
    const pinned = readOptionalBoolean(args.pinned);

    if (content !== undefined) patch.content = content;
    if (type !== undefined) patch.type = type;
    if (tags !== undefined) patch.tags = tags;
    if (summary !== undefined) patch.summary = summary;
    if (importance !== undefined) patch.importance = Math.max(0, Math.min(1, importance));
    if (confidence !== undefined) patch.confidence = Math.max(0, Math.min(1, confidence));
    if (pinned !== undefined) patch.pinned = pinned;

    if (Object.keys(patch).length === 0) return toolError("No update fields provided");

    const updated = await updateMemory(env.DB, { namespace: resolveNamespace(profile, args.namespace), id, patch });
    if (!updated) return toolError("Memory not found");
    if (patch.content !== undefined) waitForBackground(ctx, upsertMemoryEmbedding(env, updated));
    return textToolResult({ data: toMemoryApiRecord(updated) });
  }

  if (params.name === "list_memories" || params.name === "memory_list") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    if (args.page !== undefined || args.page_size !== undefined || args.tag !== undefined || args.memory_type !== undefined) {
      return textToolResult(await listMemoriesCompat(env.DB, args, resolveNamespace(profile, args.namespace)));
    }
    const records = await listMemories(env.DB, {
      namespace: resolveNamespace(profile, args.namespace),
      type: readString(args.type),
      status: readString(args.status) || "active",
      limit: Math.min(Math.max(Math.floor(readNumber(args.limit, 50)), 1), 100)
    });
    return textToolResult({ data: records.map((record) => toMemoryApiRecord(record)), memories: records.map((record) => toMemoryApiRecord(record)) });
  }

  if (params.name === "delete_memory" || params.name === "memory_delete") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    const namespace = resolveNamespace(profile, args.namespace);
    let id = readString(args.id) || readString(args.memory_id);
    const contentHash = readString(args.content_hash);
    if (!id && contentHash) {
      const found = await findMemoryByContentHash(env.DB, namespace, contentHash);
      id = found?.id;
    }
    if (!id) return toolError("id or content_hash is required");
    const deleted = await softDeleteMemory(env.DB, { namespace, id });
    if (!deleted) return toolError("Memory not found");
    waitForBackground(ctx, deleteMemoryEmbedding(env, deleted));
    return textToolResult({ data: toMemoryApiRecord(deleted), success: true, message: "Memory deleted" });
  }

  if (params.name === "check_database_health") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    return textToolResult(await databaseHealth(env.DB, resolveNamespace(profile, args.namespace)));
  }

  if (params.name === "get_startup_context") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    return textToolResult(await buildStartupContext(env.DB, resolveNamespace(profile, args.namespace)));
  }

  return toolError(`Unknown tool: ${String(params.name || "")}`);
}

async function handleRpc(request: JsonRpcRequest, env: Env, ctx: ExecutionContext, profile: KeyProfile): Promise<Record<string, unknown> | null> {
  if (!request.id && request.method?.startsWith("notifications/")) return null;
  if (request.method === "initialize") {
    return rpcResult(request.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "companion-memory-mcp", version: "0.1.0" }
    });
  }
  if (request.method === "tools/list") return rpcResult(request.id, { tools: getTools() });
  if (request.method === "resources/list") return rpcResult(request.id, { resources: [] });
  if (request.method === "prompts/list") return rpcResult(request.id, { prompts: [] });
  if (request.method === "tools/call") {
    const params = isRecord(request.params) ? (request.params as ToolCallParams) : {};
    return rpcResult(request.id, await callTool(env, ctx, profile, params));
  }
  if (request.method === "ping") return rpcResult(request.id, {});
  return rpcError(request.id, -32601, "Method not found");
}

export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method === "GET") {
    return json({
      name: "companion-memory-mcp",
      transport: "streamable-http",
      endpoint: new URL(request.url).pathname,
      tools: getTools().map((tool) => tool.name)
    });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });

  const auth = await authenticate(request, env);
  if (!auth.ok) return json(rpcError(null, -32001, "Unauthorized"), { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }

  if (Array.isArray(body)) {
    const results = (await Promise.all(body.filter((item): item is JsonRpcRequest => isRecord(item)).map((item) => handleRpc(item, env, ctx, auth.profile)))).filter((item): item is Record<string, unknown> => item !== null);
    return results.length > 0 ? json(results) : new Response(null, { status: 202 });
  }

  if (!isRecord(body)) return json(rpcError(null, -32600, "Invalid Request"), { status: 400 });
  const result = await handleRpc(body, env, ctx, auth.profile);
  return result ? json(result) : new Response(null, { status: 202 });
}
