import { ensureMemorySchema, importLegacyMemory } from "../db/importMemories";
import { upsertMemoryEmbedding } from "../memory/embedding";
import type { Env, MemoryRecord } from "../types";

const LEGACY_MCP_ENDPOINT = "https://laylakld.xyz/board/mcp";
const MESSAGE_TAG = "留言";
const MAX_IMPORTS = 200;

interface LegacySearchResult {
  content?: string;
  content_hash?: string;
  hash?: string;
  tags?: string[] | string;
  memory_type?: string;
  type?: string;
  created_at?: string | number;
  updated_at?: string | number;
}

function unauthorized(): Response {
  return new Response("Authentication required", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="Aelios memories"' }
  });
}

function adminPassword(env: Env): string | null {
  return env.ADMIN_PASSWORD || env.MEMORY_MCP_API_KEY || null;
}

function isAuthorized(request: Request, env: Env): boolean {
  const expected = adminPassword(env);
  if (!expected) return false;
  const header = request.headers.get("authorization") || "";
  if (!header.toLowerCase().startsWith("basic ")) return false;
  try {
    const decoded = atob(header.slice(6));
    const password = decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : decoded;
    return password === expected;
  } catch {
    return false;
  }
}

function toIso(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  return null;
}

function readTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim()).map((item) => item.trim());
  if (typeof value === "string") return value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

async function callLegacyMessages(): Promise<LegacySearchResult[]> {
  const payload = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name: "search_by_tag", arguments: { tags: [MESSAGE_TAG] } }
  };
  const response = await fetch(LEGACY_MCP_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`legacy MCP returned ${response.status}`);
  const data = (await response.json()) as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
  if (data.error) throw new Error(data.error.message || "legacy MCP error");
  const text = data.result?.content?.[0]?.text;
  if (!text) return [];
  const parsed = JSON.parse(text) as { results?: LegacySearchResult[]; memories?: LegacySearchResult[] };
  return Array.isArray(parsed.results) ? parsed.results : Array.isArray(parsed.memories) ? parsed.memories : [];
}

async function findExisting(db: D1Database, content: string, hash: string | null): Promise<string | null> {
  if (hash) {
    const byHash = await db
      .prepare("SELECT id FROM memories WHERE namespace = 'default' AND source_message_ids LIKE ? LIMIT 1")
      .bind(`%hash:${hash}%`)
      .first<{ id: string }>();
    if (byHash?.id) return byHash.id;
  }
  const byContent = await db
    .prepare("SELECT id FROM memories WHERE namespace = 'default' AND content = ? LIMIT 1")
    .bind(content)
    .first<{ id: string }>();
  return byContent?.id ?? null;
}

export async function handleAdminLegacySync(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!isAuthorized(request, env)) return unauthorized();
  if (request.method !== "GET" && request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  await ensureMemorySchema(env.DB);
  const legacy = (await callLegacyMessages())
    .filter((item) => typeof item.content === "string" && item.content.trim())
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .slice(0, MAX_IMPORTS);

  const imported: string[] = [];
  const skipped: string[] = [];
  const embedded: MemoryRecord[] = [];

  for (const item of legacy) {
    const content = item.content!.trim();
    const hash = typeof item.content_hash === "string" ? item.content_hash : typeof item.hash === "string" ? item.hash : null;
    const existing = await findExisting(env.DB, content, hash);
    if (existing) {
      skipped.push(existing);
      continue;
    }

    const tags = [...new Set([MESSAGE_TAG, ...readTags(item.tags), "legacy:vps"])]
      .filter((tag) => tag !== "read" && tag !== "unread" ? true : true);
    const { record, result } = await importLegacyMemory(env.DB, {
      id: hash ? `hash_${hash}` : undefined,
      content_hash: hash || undefined,
      content,
      tags_array: tags,
      memory_type: item.memory_type || item.type || "note",
      created_at_iso: toIso(item.created_at),
      updated_at_iso: toIso(item.updated_at) || toIso(item.created_at)
    }, "default");
    imported.push(result.id);
    embedded.push(record);
  }

  if (embedded.length > 0) {
    ctx.waitUntil(Promise.allSettled(embedded.map((record) => upsertMemoryEmbedding(env, record))).then(() => undefined));
  }

  const body = JSON.stringify({ ok: true, scanned: legacy.length, imported: imported.length, skipped: skipped.length, imported_ids: imported }, null, 2);
  return new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
