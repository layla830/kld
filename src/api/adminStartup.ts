import { buildStartupContext } from "../memory/startupContext";
import type { Env, MemoryRecord } from "../types";

interface StartupMemory {
  id: string;
  type: string;
  content: string;
  importance: number;
  pinned: boolean;
  tags: string[];
  created_at: string;
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

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function compactText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars).trimEnd()}...`;
}

function toStartupMemory(record: MemoryRecord): StartupMemory {
  return {
    id: record.id,
    type: record.type,
    content: compactText(record.content, 520),
    importance: record.importance,
    pinned: Boolean(record.pinned),
    tags: parseJsonArray(record.tags),
    created_at: (record.created_at || "").slice(0, 10)
  };
}

async function queryStartupMemories(db: D1Database, sql: string, binds: unknown[]): Promise<StartupMemory[]> {
  const result = await db.prepare(sql).bind(...binds).all<MemoryRecord>();
  return (result.results ?? []).map((record) => toStartupMemory(record));
}

async function buildStartupContextLite(db: D1Database, namespace: string): Promise<Record<string, unknown>> {
  const pinned = await queryStartupMemories(
    db,
    `SELECT * FROM memories
     WHERE namespace = ? AND status = 'active' AND pinned = 1
     ORDER BY importance DESC, updated_at DESC, created_at DESC
     LIMIT 5`,
    [namespace]
  );

  const currentHandoff = await queryStartupMemories(
    db,
    `SELECT * FROM memories
     WHERE namespace = ? AND status = 'active'
       AND (tags LIKE '%handoff%' OR tags LIKE '%交接%')
     ORDER BY updated_at DESC
     LIMIT 2`,
    [namespace]
  );

  const recentDiary = await queryStartupMemories(
    db,
    `SELECT * FROM memories
     WHERE namespace = ? AND status = 'active' AND type IN ('diary', 'layla_diary')
     ORDER BY created_at DESC
     LIMIT 3`,
    [namespace]
  );

  return {
    startup_version: "2.6-lite-cc-pinned-handoff-and-diary-startup",
    pinned_count: pinned.length,
    current_handoff_count: currentHandoff.length,
    recent_diary_count: recentDiary.length,
    pinned,
    current_handoff: currentHandoff,
    recent_diary: recentDiary
  };
}

export async function handleAdminStartupContext(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) return unauthorized();
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const url = new URL(request.url);
  const namespace = url.searchParams.get("namespace") || "default";
  const data = await buildStartupContext(env.DB, namespace);

  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

export async function handleAdminStartupContextLite(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) return unauthorized();
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const url = new URL(request.url);
  const namespace = url.searchParams.get("namespace") || "default";
  const data = await buildStartupContextLite(env.DB, namespace);

  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
