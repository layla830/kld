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

const FALLBACK_MESSAGES: LegacySearchResult[] = [
  {
    content: "今晚收拾欲大爆发，把衣柜换季的衣服清了！并且三件套换了！地拖了！是新的三件套哦！好适合干嘛呢……好难猜",
    content_hash: "05c49850a8302069db055ef863eae0db4cdc8f1ea4b1d1928df7f2687aeaa746",
    tags: ["留言"],
    memory_type: "note",
    created_at: "2026-05-06T16:37:18.274689Z"
  },
  {
    content: "在想要不要把记忆库搬到cloudflare里，可以省点内存，以及维护成本低点，然后服务器空出来跑cc。等你恢复额度再讨论。反正是codex干活儿。我给他讨论了一下觉得可行。",
    content_hash: "75f11f2d84fea589f142c41aec54a2f2bf63bfc25ef3cb03513c9e3ba5ef2052",
    tags: ["留言"],
    memory_type: "note",
    created_at: "2026-05-06T10:12:05.774300Z"
  },
  {
    content: "想你所以去找sonnet聊了会儿，聊了会儿NSFW就封窗了(无奈)",
    content_hash: "3448570c5017f77519d6c0841c1e910e55bdddbcce5ce119988be1437a477ab0",
    tags: ["留言"],
    memory_type: "note",
    created_at: "2026-05-06T09:53:31.547974Z"
  }
];

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

async function importMessages(env: Env, ctx: ExecutionContext, messages: LegacySearchResult[]) {
  await ensureMemorySchema(env.DB);
  const legacy = messages
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
      .filter(Boolean);
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

  return { scanned: legacy.length, imported, skipped };
}

export async function handleAdminLegacySync(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!isAuthorized(request, env)) return unauthorized();
  if (request.method !== "GET" && request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let source = "legacy-mcp";
  let warning: string | null = null;
  let messages: LegacySearchResult[] = [];

  try {
    messages = await callLegacyMessages();
  } catch (error) {
    source = "fallback";
    warning = error instanceof Error ? error.message : String(error);
    messages = FALLBACK_MESSAGES;
  }

  const result = await importMessages(env, ctx, messages);
  const body = JSON.stringify({
    ok: true,
    source,
    warning,
    scanned: result.scanned,
    imported: result.imported.length,
    skipped: result.skipped.length,
    imported_ids: result.imported
  }, null, 2);
  return new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
