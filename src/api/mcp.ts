import { authenticate } from "../auth/apiKey";
import { createMemory, listMemories, softDeleteMemory } from "../db/memories";
import { deleteMemoryEmbedding, upsertMemoryEmbedding } from "../memory/embedding";
import { searchMemories, toMemoryApiRecord } from "../memory/search";
import { buildStartupContext } from "../memory/startupContext";
import type { Env, KeyProfile, Scope } from "../types";
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

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
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

function getTools(): Array<Record<string, unknown>> {
  const searchSchema = {
    type: "object",
    properties: {
      query: { type: "string" },
      top_k: { type: "number", minimum: 1, maximum: 50 },
      n_results: { type: "number", minimum: 1, maximum: 50 },
      types: { type: "array", items: { type: "string" } },
      namespace: { type: "string" }
    },
    required: ["query"]
  };
  const createSchema = {
    type: "object",
    properties: {
      content: { type: "string" },
      memory: { type: "string" },
      type: { type: "string" },
      memory_type: { type: "string" },
      summary: { type: "string" },
      importance: { type: "number" },
      confidence: { type: "number" },
      pinned: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
      namespace: { type: "string" }
    }
  };
  const listSchema = {
    type: "object",
    properties: {
      limit: { type: "number", minimum: 1, maximum: 100 },
      type: { type: "string" },
      status: { type: "string" },
      namespace: { type: "string" }
    }
  };
  const deleteSchema = {
    type: "object",
    properties: {
      id: { type: "string" },
      memory_id: { type: "string" },
      namespace: { type: "string" }
    }
  };

  return [
    { name: "memory_search", description: "Search the user's long-term memory library.", inputSchema: searchSchema },
    { name: "retrieve_memory", description: "Compatibility alias for memory_search.", inputSchema: searchSchema },
    { name: "memory_create", description: "Create one long-term memory.", inputSchema: createSchema },
    { name: "store_memory", description: "Compatibility alias for memory_create.", inputSchema: createSchema },
    { name: "memory_list", description: "List memories from the user's memory library.", inputSchema: listSchema },
    { name: "list_memories", description: "Compatibility alias for memory_list.", inputSchema: listSchema },
    { name: "memory_delete", description: "Soft-delete one memory by id.", inputSchema: deleteSchema },
    { name: "delete_memory", description: "Compatibility alias for memory_delete.", inputSchema: deleteSchema },
    { name: "get_startup_context", description: "Return startup context v2 with required warmth anchor checks.", inputSchema: { type: "object", properties: { namespace: { type: "string" } } } }
  ];
}

async function callTool(env: Env, ctx: ExecutionContext, profile: KeyProfile, params: ToolCallParams): Promise<Record<string, unknown>> {
  const args = isRecord(params.arguments) ? params.arguments : {};

  if (params.name === "memory_search" || params.name === "retrieve_memory") {
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

  if (params.name === "memory_create" || params.name === "store_memory") {
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
      tags: readStringArray(args.tags),
      source: "mcp",
      sourceMessageIds: [],
      expiresAt: null
    });
    ctx.waitUntil(upsertMemoryEmbedding(env, memory));
    return textToolResult({ data: toMemoryApiRecord(memory) });
  }

  if (params.name === "memory_list" || params.name === "list_memories") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    const records = await listMemories(env.DB, {
      namespace: resolveNamespace(profile, args.namespace),
      type: readString(args.type),
      status: readString(args.status) || "active",
      limit: Math.min(Math.max(Math.floor(readNumber(args.limit, 50)), 1), 100)
    });
    return textToolResult({ data: records.map((record) => toMemoryApiRecord(record)) });
  }

  if (params.name === "memory_delete" || params.name === "delete_memory") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    const id = readString(args.id) || readString(args.memory_id);
    if (!id) return toolError("id is required");
    const deleted = await softDeleteMemory(env.DB, { namespace: resolveNamespace(profile, args.namespace), id });
    if (!deleted) return toolError("Memory not found");
    ctx.waitUntil(deleteMemoryEmbedding(env, deleted));
    return textToolResult({ data: toMemoryApiRecord(deleted) });
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
