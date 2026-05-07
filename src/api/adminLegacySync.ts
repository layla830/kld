import { ensureMemorySchema, importLegacyMemory } from "../db/importMemories";
import type { Env } from "../types";

const MESSAGE_TAG = "留言";

interface LegacyMessage {
  content: string;
  content_hash: string;
  created_at: string;
}

const FALLBACK_MESSAGES: LegacyMessage[] = [
  {
    content: "今晚收拾欲大爆发，把衣柜换季的衣服清了！并且三件套换了！地拖了！是新的三件套哦！好适合干嘛呢……好难猜",
    content_hash: "05c49850a8302069db055ef863eae0db4cdc8f1ea4b1d1928df7f2687aeaa746",
    created_at: "2026-05-06T16:37:18.274Z"
  },
  {
    content: "在想要不要把记忆库搬到cloudflare里，可以省点内存，以及维护成本低点，然后服务器空出来跑cc。等你恢复额度再讨论。反正是codex干活儿。我给他讨论了一下觉得可行。",
    content_hash: "75f11f2d84fea589f142c41aec54a2f2bf63bfc25ef3cb03513c9e3ba5ef2052",
    created_at: "2026-05-06T10:12:05.774Z"
  },
  {
    content: "想你所以去找sonnet聊了会儿，聊了会儿NSFW就封窗了(无奈)",
    content_hash: "3448570c5017f77519d6c0841c1e910e55bdddbcce5ce119988be1437a477ab0",
    created_at: "2026-05-06T09:53:31.547Z"
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
    const separator = decoded.indexOf(":");
    const password = separator >= 0 ? decoded.slice(separator + 1) : decoded;
    return password === expected;
  } catch {
    return false;
  }
}

async function findExisting(db: D1Database, content: string): Promise<string | null> {
  const byContent = await db
    .prepare("SELECT id FROM memories WHERE namespace = 'default' AND content = ? LIMIT 1")
    .bind(content)
    .first<{ id: string }>();
  return byContent?.id ?? null;
}

export async function handleAdminLegacySync(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) return unauthorized();
  if (request.method !== "GET" && request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  try {
    await ensureMemorySchema(env.DB);
    const imported: string[] = [];
    const skipped: string[] = [];

    for (const message of FALLBACK_MESSAGES) {
      const existing = await findExisting(env.DB, message.content);
      if (existing) {
        skipped.push(existing);
        continue;
      }

      const { result } = await importLegacyMemory(env.DB, {
        id: `hash_${message.content_hash}`,
        content_hash: message.content_hash,
        content: message.content,
        tags_array: [MESSAGE_TAG, "legacy:vps"],
        memory_type: "note",
        created_at_iso: message.created_at,
        updated_at_iso: message.created_at
      }, "default");
      imported.push(result.id);
    }

    return new Response(JSON.stringify({
      ok: true,
      source: "fallback",
      scanned: FALLBACK_MESSAGES.length,
      imported: imported.length,
      skipped: skipped.length,
      imported_ids: imported
    }, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }, null, 2), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
    });
  }
}
