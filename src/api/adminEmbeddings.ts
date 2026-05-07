import { authenticate } from "../auth/apiKey";
import { upsertMemoryEmbedding } from "../memory/embedding";
import type { Env, KeyProfile, MemoryRecord } from "../types";
import { json, openAiError } from "../utils/json";
import { buildVectorId } from "../utils/vectorId";

function canRebuildEmbeddings(profile: KeyProfile): boolean {
  return profile.scopes.includes("memory:read") && profile.scopes.includes("memory:write");
}

function readLimit(value: string | null): number {
  const parsed = Number(value || 10);
  if (!Number.isFinite(parsed)) return 10;
  return Math.min(Math.max(Math.floor(parsed), 1), 25);
}

async function normalizeVectorId(env: Env, record: MemoryRecord): Promise<MemoryRecord> {
  if (record.vector_id && record.vector_id.length <= 64) return record;
  const vectorId = buildVectorId(record.id);
  await env.DB.prepare("UPDATE memories SET vector_id = ? WHERE namespace = ? AND id = ?")
    .bind(vectorId, record.namespace, record.id)
    .run();
  return { ...record, vector_id: vectorId };
}

export async function handleAdminRebuildEmbeddings(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return openAiError("Method not allowed", 405);

  const auth = await authenticate(request, env);
  if (!auth.ok || !canRebuildEmbeddings(auth.profile)) return openAiError("Unauthorized", 401);
  if (!env.VECTORIZE) return openAiError("Missing VECTORIZE binding", 500);

  const url = new URL(request.url);
  const namespace = auth.profile.namespace;
  const limit = readLimit(url.searchParams.get("limit"));
  const after = (url.searchParams.get("after") || "").trim();

  let sql = "SELECT * FROM memories WHERE namespace = ? AND status = 'active'";
  const binds: unknown[] = [namespace];
  if (after) {
    sql += " AND id > ?";
    binds.push(after);
  }
  sql += " ORDER BY id ASC LIMIT ?";
  binds.push(limit);

  const rows = await env.DB.prepare(sql).bind(...binds).all<MemoryRecord>();
  const records = await Promise.all((rows.results ?? []).map((record) => normalizeVectorId(env, record)));
  const results = await Promise.allSettled(records.map((record) => upsertMemoryEmbedding(env, record)));

  const details = records.map((record, index) => {
    const result = results[index];
    if (result.status === "fulfilled") return { id: record.id, vector_id: record.vector_id, ok: result.value };
    return { id: record.id, vector_id: record.vector_id, ok: false, error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
  });

  const succeeded = details.filter((item) => item.ok).length;
  const failed = details.length - succeeded;
  const nextAfter = records.length > 0 ? records[records.length - 1].id : after || null;

  return json({
    ok: failed === 0,
    namespace,
    limit,
    processed: records.length,
    succeeded,
    failed,
    next_after: nextAfter,
    has_more: records.length === limit,
    details
  });
}
