import { createMemoryEvent } from "../../db/memoryEvents";
import { listFactKeyConflicts } from "../../db/memories";
import type { Env } from "../../types";

export async function runMetabolismPatrol(
  env: Env,
  namespace: string,
  options: { dryRun?: boolean } = {}
): Promise<{ suggestions: number; events: number }> {
  const dryRun = options.dryRun ?? false;
  const suggestions: Array<Record<string, unknown>> = [];

  const duplicateFacts = await listFactKeyConflicts(env.DB, { namespace, limit: 100 });
  for (const conflict of duplicateFacts) {
    suggestions.push({
      action: "review",
      severity: "critical",
      reason: "fact_key has multiple active/review memories",
      fact_key: conflict.fact_key,
      memory_ids: conflict.ids.split(",").map((id) => id.trim()).filter(Boolean)
    });
  }

  const reviewRows = await env.DB
    .prepare(
      `SELECT id FROM memories
       WHERE namespace = ?
         AND status = 'review'
       ORDER BY updated_at DESC
       LIMIT 50`
    )
    .bind(namespace)
    .all<{ id: string }>();
  if ((reviewRows.results ?? []).length > 0) {
    suggestions.push({
      action: "review",
      severity: "warning",
      reason: "memories waiting for review",
      memory_ids: (reviewRows.results ?? []).map((row) => row.id)
    });
  }

  const staleRows = await env.DB
    .prepare(
      `SELECT id FROM memories
       WHERE namespace = ?
         AND status = 'active'
         AND pinned = 0
         AND expires_at IS NOT NULL
         AND expires_at < ?
       ORDER BY expires_at ASC
       LIMIT 50`
    )
    .bind(namespace, new Date().toISOString())
    .all<{ id: string }>();
  if ((staleRows.results ?? []).length > 0) {
    suggestions.push({
      action: "archive_or_review",
      severity: "warning",
      reason: "active memories past expires_at",
      memory_ids: (staleRows.results ?? []).map((row) => row.id)
    });
  }

  const selfLoopRows = await env.DB
    .prepare(
      `SELECT id, source_memory_id FROM memory_relations
       WHERE namespace = ? AND source_memory_id = target_memory_id
       LIMIT 50`
    )
    .bind(namespace)
    .all<{ id: string; source_memory_id: string }>();
  if ((selfLoopRows.results ?? []).length > 0) {
    suggestions.push({
      action: "delete_relation",
      severity: "critical",
      reason: "relation self-loop",
      relation_ids: (selfLoopRows.results ?? []).map((row) => row.id),
      memory_ids: [...new Set((selfLoopRows.results ?? []).map((row) => row.source_memory_id))]
    });
  }

  const orphanRows = await env.DB
    .prepare(
      `SELECT r.id AS relation_id, r.source_memory_id, r.target_memory_id
       FROM memory_relations r
       LEFT JOIN memories m1 ON m1.namespace = r.namespace AND m1.id = r.source_memory_id
       LEFT JOIN memories m2 ON m2.namespace = r.namespace AND m2.id = r.target_memory_id
       WHERE r.namespace = ?
         AND (m1.id IS NULL OR m2.id IS NULL
              OR m1.status NOT IN ('active','review')
              OR m2.status NOT IN ('active','review'))
       LIMIT 50`
    )
    .bind(namespace)
    .all<{ relation_id: string; source_memory_id: string; target_memory_id: string }>();
  if ((orphanRows.results ?? []).length > 0) {
    suggestions.push({
      action: "delete_relation_or_relink",
      severity: "warning",
      reason: "relation touches missing or non-live memory",
      relation_ids: (orphanRows.results ?? []).map((row) => row.relation_id)
    });
  }

  const symmetricDupRows = await env.DB
    .prepare(
      `SELECT a.id AS keep_id, b.id AS dup_id, a.source_memory_id, a.target_memory_id, a.relation_type
       FROM memory_relations a
       JOIN memory_relations b
         ON b.namespace = a.namespace
        AND b.relation_type = a.relation_type
        AND b.source_memory_id = a.target_memory_id
        AND b.target_memory_id = a.source_memory_id
        AND b.id > a.id
       WHERE a.namespace = ?
       LIMIT 50`
    )
    .bind(namespace)
    .all<{ keep_id: string; dup_id: string; relation_type: string }>();
  if ((symmetricDupRows.results ?? []).length > 0) {
    suggestions.push({
      action: "delete_relation",
      severity: "info",
      reason: "duplicate symmetric relation (A->B and B->A)",
      relation_ids: (symmetricDupRows.results ?? []).map((row) => row.dup_id)
    });
  }

  const oversizedThreadRows = await env.DB
    .prepare(
      `SELECT thread, COUNT(*) AS cnt
       FROM memories
       WHERE namespace = ?
         AND status = 'active'
         AND thread IS NOT NULL
       GROUP BY thread
       HAVING cnt > 30
       ORDER BY cnt DESC
       LIMIT 20`
    )
    .bind(namespace)
    .all<{ thread: string; cnt: number }>();
  if ((oversizedThreadRows.results ?? []).length > 0) {
    suggestions.push({
      action: "split_thread",
      severity: "info",
      reason: "thread has more than 30 active memories; consider splitting by sub-topic or time period",
      threads: (oversizedThreadRows.results ?? []).map((row) => ({ thread: row.thread, count: row.cnt }))
    });
  }

  if (suggestions.length > 0 && !dryRun) {
    await createMemoryEvent(env.DB, {
      namespace,
      eventType: "m_patrol",
      payload: { suggestions }
    });
    return { suggestions: suggestions.length, events: 1 };
  }

  return { suggestions: 0, events: 0 };
}
