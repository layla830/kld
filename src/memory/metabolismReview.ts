import { upsertMemoryCandidate } from "../db/memoryCandidates";
import { SYMMETRIC_RELATION_TYPES } from "../db/memoryRelations";
import type { MemoryRecord } from "../types";

interface RelationSnapshot {
  id: string;
  namespace: string;
  source_memory_id: string;
  target_memory_id: string;
  relation_type: string;
  strength: number;
  reason: string | null;
  created_at: string;
}

const PROTECTED_MEMORY_TYPES = new Set(["identity", "relationship_moment", "diary", "layla_diary", "auto_diary"]);

function dateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

async function queueArchiveCandidates(env: { DB: D1Database }, namespace: string): Promise<number> {
  const now = new Date().toISOString();
  const rows = await env.DB
    .prepare(
      `SELECT * FROM memories
       WHERE namespace = ? AND status = 'active' AND pinned = 0
         AND type = 'project_state' AND expires_at IS NOT NULL AND expires_at < ?
       ORDER BY expires_at ASC LIMIT 50`
    )
    .bind(namespace, now)
    .all<MemoryRecord>();
  let queued = 0;
  for (const memory of rows.results ?? []) {
    if (PROTECTED_MEMORY_TYPES.has(memory.type)) continue;
    await upsertMemoryCandidate(env.DB, namespace, {
      externalKey: `m-review:archive:${memory.id}:${memory.updated_at}`,
      dreamDate: dateKey(),
      action: "m_archive",
      subject: "system",
      targetId: memory.id,
      payload: {
        reason: "project_state 已超过 expires_at；建议退出默认召回，但保留完整记录和回滚能力",
        before: memory
      },
      sourceChunkIds: [],
      status: "pending"
    });
    queued += 1;
  }
  return queued;
}

async function relationCleanupRows(env: { DB: D1Database }, namespace: string): Promise<Array<{ issue: string; relation: RelationSnapshot }>> {
  const symmetricTypes = [...SYMMETRIC_RELATION_TYPES];
  const symmetricPlaceholders = symmetricTypes.map(() => "?").join(", ");
  const [selfLoops, orphans, symmetricDuplicates] = await Promise.all([
    env.DB.prepare(
      `SELECT r.* FROM memory_relations r
       WHERE r.namespace = ? AND r.source_memory_id = r.target_memory_id
         AND NOT EXISTS (
           SELECT 1 FROM memory_candidates c
           WHERE c.namespace = r.namespace
             AND c.external_key = 'm-review:relation:' || r.id
         )
       LIMIT 50`
    ).bind(namespace).all<RelationSnapshot>(),
    env.DB.prepare(
      `SELECT r.* FROM memory_relations r
       LEFT JOIN memories m1 ON m1.namespace = r.namespace AND m1.id = r.source_memory_id
       LEFT JOIN memories m2 ON m2.namespace = r.namespace AND m2.id = r.target_memory_id
       WHERE r.namespace = ? AND (
         m1.id IS NULL OR m2.id IS NULL
         OR m1.status NOT IN ('active','review') OR m2.status NOT IN ('active','review')
       )
         AND NOT EXISTS (
           SELECT 1 FROM memory_candidates c
           WHERE c.namespace = r.namespace
             AND c.external_key = 'm-review:relation:' || r.id
         )
       LIMIT 50`
    ).bind(namespace).all<RelationSnapshot>(),
    env.DB.prepare(
      `SELECT b.* FROM memory_relations a
       JOIN memory_relations b
         ON b.namespace = a.namespace AND b.relation_type = a.relation_type
        AND b.source_memory_id = a.target_memory_id AND b.target_memory_id = a.source_memory_id
        AND b.id > a.id
       WHERE a.namespace = ? AND a.relation_type IN (${symmetricPlaceholders})
         AND NOT EXISTS (
           SELECT 1 FROM memory_candidates c
           WHERE c.namespace = b.namespace
             AND c.external_key = 'm-review:relation:' || b.id
         )
       LIMIT 50`
    ).bind(namespace, ...symmetricTypes).all<RelationSnapshot>()
  ]);

  const byId = new Map<string, { issue: string; relation: RelationSnapshot }>();
  for (const relation of selfLoops.results ?? []) byId.set(relation.id, { issue: "关系边连接了同一条记忆（self-loop）", relation });
  for (const relation of orphans.results ?? []) byId.set(relation.id, { issue: "关系边连接了缺失或非 active 的记忆", relation });
  for (const relation of symmetricDuplicates.results ?? []) {
    if (!byId.has(relation.id)) byId.set(relation.id, { issue: "同一种对称关系同时存在 A→B 与 B→A", relation });
  }
  return [...byId.values()].slice(0, 100);
}

async function queueRelationCandidates(env: { DB: D1Database }, namespace: string): Promise<number> {
  const rows = await relationCleanupRows(env, namespace);
  for (const row of rows) {
    await upsertMemoryCandidate(env.DB, namespace, {
      externalKey: `m-review:relation:${row.relation.id}`,
      dreamDate: dateKey(),
      action: "m_relation_cleanup",
      subject: "system",
      payload: { reason: row.issue, before: row.relation },
      sourceChunkIds: [],
      status: "pending"
    });
  }
  return rows.length;
}

export async function scanMetabolismReviewCandidates(
  env: { DB: D1Database },
  namespace = "default"
): Promise<{ archive: number; relations: number }> {
  const [archive, relations] = await Promise.all([
    queueArchiveCandidates(env, namespace),
    queueRelationCandidates(env, namespace)
  ]);
  return { archive, relations };
}

export { PROTECTED_MEMORY_TYPES };
