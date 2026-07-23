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

export const PROTECTED_MEMORY_TYPES = new Set([
  "identity",
  "relationship_moment",
  "diary",
  "layla_diary",
  "auto_diary"
]);
export const COLD_MEMORY_DAYS = 90;
export const COLD_MEMORY_MAX_IMPORTANCE = 0.35;
export const COLD_MEMORY_MAX_CONFIDENCE = 0.6;

function dateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

interface QueuedCandidates {
  count: number;
  candidateExternalKeys: string[];
}

async function queueArchiveCandidates(
  env: { DB: D1Database },
  namespace: string,
  memoryIds: string[] = [],
  dryRun = false
): Promise<QueuedCandidates> {
  const now = new Date().toISOString();
  const coldBefore = new Date(Date.now() - COLD_MEMORY_DAYS * 86_400_000).toISOString();
  const ids = [...new Set(memoryIds.map((id) => id.trim()).filter(Boolean))].slice(0, 20);
  const idClause = ids.length > 0 ? ` AND id IN (${ids.map(() => "?").join(", ")})` : "";
  const rows = await env.DB.prepare(
    `SELECT * FROM memories
     WHERE namespace = ? AND status = 'active' AND pinned = 0
       AND (
         (type = 'project_state' AND expires_at IS NOT NULL AND expires_at < ?)
         OR (
           type NOT IN ('identity','relationship_moment','diary','layla_diary','auto_diary')
           AND created_at < ?
           AND COALESCE(last_recalled_at, created_at) < ?
           AND recall_count = 0
           AND importance <= ? AND confidence <= ?
           AND NOT EXISTS (
             SELECT 1 FROM memory_relations r
             WHERE r.namespace = memories.namespace
               AND (r.source_memory_id = memories.id OR r.target_memory_id = memories.id)
           )
         )
       )
       ${idClause}
     ORDER BY COALESCE(last_recalled_at, created_at) ASC
     LIMIT 50`
  ).bind(
    namespace,
    now,
    coldBefore,
    coldBefore,
    COLD_MEMORY_MAX_IMPORTANCE,
    COLD_MEMORY_MAX_CONFIDENCE,
    ...ids
  ).all<MemoryRecord>();

  let queued = 0;
  const candidateExternalKeys: string[] = [];
  for (const memory of rows.results ?? []) {
    if (PROTECTED_MEMORY_TYPES.has(memory.type)) continue;
    const policy = memory.type === "project_state" && memory.expires_at && memory.expires_at < now
      ? "expired_project_state"
      : "cold_low_signal";
    const candidateExternalKey = `m-review:archive:${policy}:${memory.id}:${memory.updated_at}`;
    if (!dryRun) await upsertMemoryCandidate(env.DB, namespace, {
      externalKey: candidateExternalKey,
      dreamDate: dateKey(),
      action: "m_archive",
      subject: "system",
      targetId: memory.id,
      payload: {
        _kind: "metabolism_archive",
        policy,
        reason: policy === "expired_project_state"
          ? "project_state 已超过 expires_at，建议退出默认召回"
          : `超过 ${COLD_MEMORY_DAYS} 天未被召回、低重要度且没有关系边，建议进入可回滚归档`,
        cold_before: coldBefore,
        before: memory
      },
      sourceChunkIds: [],
      status: "pending"
    });
    if (!dryRun) candidateExternalKeys.push(candidateExternalKey);
    queued += 1;
  }
  return { count: queued, candidateExternalKeys };
}

async function relationCleanupRows(
  env: { DB: D1Database },
  namespace: string,
  memoryIds: string[] = []
): Promise<Array<{ issue: string; relation: RelationSnapshot }>> {
  const symmetricTypes = [...SYMMETRIC_RELATION_TYPES];
  const symmetricPlaceholders = symmetricTypes.map(() => "?").join(", ");
  const ids = [...new Set(memoryIds.map((id) => id.trim()).filter(Boolean))].slice(0, 20);
  const relationFilter = ids.length > 0
    ? ` AND (r.source_memory_id IN (${ids.map(() => "?").join(", ")}) OR r.target_memory_id IN (${ids.map(() => "?").join(", ")}))`
    : "";
  const symmetricFilter = ids.length > 0
    ? ` AND (a.source_memory_id IN (${ids.map(() => "?").join(", ")}) OR a.target_memory_id IN (${ids.map(() => "?").join(", ")}))`
    : "";
  const [selfLoops, orphans, symmetricDuplicates] = await Promise.all([
    env.DB.prepare(
      `SELECT r.* FROM memory_relations r
       WHERE r.namespace = ? AND r.source_memory_id = r.target_memory_id
         ${relationFilter}
         AND NOT EXISTS (
           SELECT 1 FROM memory_candidates c
           WHERE c.namespace = r.namespace AND c.external_key = 'm-review:relation:' || r.id
         )
       LIMIT 50`
    ).bind(namespace, ...ids, ...ids).all<RelationSnapshot>(),
    env.DB.prepare(
      `SELECT r.* FROM memory_relations r
       LEFT JOIN memories m1 ON m1.namespace = r.namespace AND m1.id = r.source_memory_id
       LEFT JOIN memories m2 ON m2.namespace = r.namespace AND m2.id = r.target_memory_id
       WHERE r.namespace = ? AND (
         m1.id IS NULL OR m2.id IS NULL
         OR m1.status NOT IN ('active','review') OR m2.status NOT IN ('active','review')
       )
         ${relationFilter}
         AND NOT EXISTS (
           SELECT 1 FROM memory_candidates c
           WHERE c.namespace = r.namespace AND c.external_key = 'm-review:relation:' || r.id
         )
       LIMIT 50`
    ).bind(namespace, ...ids, ...ids).all<RelationSnapshot>(),
    env.DB.prepare(
      `SELECT b.* FROM memory_relations a
       JOIN memory_relations b
         ON b.namespace = a.namespace AND b.relation_type = a.relation_type
        AND b.source_memory_id = a.target_memory_id AND b.target_memory_id = a.source_memory_id
        AND b.id > a.id
       WHERE a.namespace = ? AND a.relation_type IN (${symmetricPlaceholders})
         ${symmetricFilter}
         AND NOT EXISTS (
           SELECT 1 FROM memory_candidates c
           WHERE c.namespace = b.namespace AND c.external_key = 'm-review:relation:' || b.id
         )
       LIMIT 50`
    ).bind(namespace, ...symmetricTypes, ...ids, ...ids).all<RelationSnapshot>()
  ]);

  const byId = new Map<string, { issue: string; relation: RelationSnapshot }>();
  for (const relation of selfLoops.results ?? []) byId.set(relation.id, { issue: "关系边连接了同一条记忆（self-loop）", relation });
  for (const relation of orphans.results ?? []) byId.set(relation.id, { issue: "关系边连接了缺失或非 active 的记忆", relation });
  for (const relation of symmetricDuplicates.results ?? []) {
    if (!byId.has(relation.id)) byId.set(relation.id, { issue: "同一种对称关系同时存在 A→B 与 B→A", relation });
  }
  return [...byId.values()].slice(0, 100);
}

async function queueRelationCandidates(
  env: { DB: D1Database },
  namespace: string,
  memoryIds: string[] = [],
  dryRun = false
): Promise<QueuedCandidates> {
  const rows = await relationCleanupRows(env, namespace, memoryIds);
  if (dryRun) return { count: rows.length, candidateExternalKeys: [] };
  const candidateExternalKeys: string[] = [];
  for (const row of rows) {
    const candidateExternalKey = `m-review:relation:${row.relation.id}`;
    await upsertMemoryCandidate(env.DB, namespace, {
      externalKey: candidateExternalKey,
      dreamDate: dateKey(),
      action: "m_relation_cleanup",
      subject: "system",
      payload: { _kind: "metabolism_relation_cleanup", reason: row.issue, before: row.relation },
      sourceChunkIds: [],
      status: "pending",
      dependencies: [
        { memoryId: row.relation.source_memory_id, role: "source" },
        { memoryId: row.relation.target_memory_id, role: "target" }
      ]
    });
    candidateExternalKeys.push(candidateExternalKey);
  }
  return { count: rows.length, candidateExternalKeys };
}

export async function scanMetabolismReviewCandidates(
  env: { DB: D1Database },
  namespace = "default",
  options: { memoryIds?: string[]; dryRun?: boolean } = {}
): Promise<{ archive: number; relations: number; candidateExternalKeys?: string[] }> {
  const [archive, relations] = await Promise.all([
    queueArchiveCandidates(env, namespace, options.memoryIds, options.dryRun === true),
    queueRelationCandidates(env, namespace, options.memoryIds, options.dryRun === true)
  ]);
  const candidateExternalKeys = [...archive.candidateExternalKeys, ...relations.candidateExternalKeys];
  return {
    archive: archive.count,
    relations: relations.count,
    ...(candidateExternalKeys.length > 0 ? { candidateExternalKeys } : {})
  };
}
