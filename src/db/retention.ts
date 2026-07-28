import { nowIso } from "../utils/time";
import { PENDING_MEMORY_CANDIDATE_STATUSES } from "./memoryCandidateDependencies";

// ---------------------------------------------------------------------------
// Batch size for SQL IN clauses and Vectorize deleteByIds
// ---------------------------------------------------------------------------

export const RETENTION_BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// messages: delete rows older than cutoff
// ---------------------------------------------------------------------------

export async function deleteOldMessages(
  db: D1Database,
  namespace: string,
  cutoff: string
): Promise<number> {
  const result = await db
    .prepare("DELETE FROM messages WHERE namespace = ? AND created_at < ?")
    .bind(namespace, cutoff)
    .run();
  return result.meta.changes ?? 0;
}

// ---------------------------------------------------------------------------
// usage_logs: delete rows older than cutoff
// ---------------------------------------------------------------------------

export async function deleteOldUsageLogs(
  db: D1Database,
  namespace: string,
  cutoff: string
): Promise<number> {
  const result = await db
    .prepare("DELETE FROM usage_logs WHERE namespace = ? AND created_at < ?")
    .bind(namespace, cutoff)
    .run();
  return result.meta.changes ?? 0;
}

// ---------------------------------------------------------------------------
// memory_events: delete rows older than cutoff
// ---------------------------------------------------------------------------

export async function deleteOldMemoryEvents(
  db: D1Database,
  namespace: string,
  cutoff: string
): Promise<number> {
  const result = await db
    .prepare("DELETE FROM memory_events WHERE namespace = ? AND created_at < ?")
    .bind(namespace, cutoff)
    .run();
  return result.meta.changes ?? 0;
}

// ---------------------------------------------------------------------------
// idempotency_keys: delete rows older than cutoff (namespace-agnostic)
// ---------------------------------------------------------------------------

export async function deleteOldIdempotencyKeys(
  db: D1Database,
  cutoff: string
): Promise<number> {
  const result = await db
    .prepare("DELETE FROM idempotency_keys WHERE created_at < ?")
    .bind(cutoff)
    .run();
  return result.meta.changes ?? 0;
}

export async function deleteOldRecallReceipts(
  db: D1Database,
  namespace: string,
  cutoff: string
): Promise<number> {
  const result = await db
    .prepare("DELETE FROM memory_recall_receipts WHERE namespace = ? AND created_at < ?")
    .bind(namespace, cutoff)
    .run();
  return result.meta.changes ?? 0;
}

export async function deleteOldRecallDailyRows(
  db: D1Database,
  namespace: string,
  cutoffDay: string
): Promise<number> {
  const result = await db
    .prepare("DELETE FROM memory_recall_daily WHERE namespace = ? AND recall_day < ?")
    .bind(namespace, cutoffDay.slice(0, 10))
    .run();
  return result.meta.changes ?? 0;
}

// ---------------------------------------------------------------------------
// memories: list hard-deletable rows, status in (deleted, superseded, expired)
//           and updated_at older than cutoff
// ---------------------------------------------------------------------------

export interface HardDeletableMemory {
  id: string;
  vector_id: string | null;
}

function sqlStringList(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
}

const TERMINAL_MEMORY_STATUSES = ["deleted", "superseded", "expired"] as const;

function hardDeleteEligibilitySql(alias: string): string {
  const pendingCandidateStatuses = sqlStringList(PENDING_MEMORY_CANDIDATE_STATUSES);
  return `${alias}.status IN (${sqlStringList(TERMINAL_MEMORY_STATUSES)})
    AND ${alias}.updated_at < ?
    AND NOT EXISTS (
      SELECT 1
      FROM memory_deprojections AS operation
      WHERE operation.namespace = ${alias}.namespace
        AND operation.memory_id = ${alias}.id
        AND operation.completed_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM memory_diary_timeline_memberships AS membership
      WHERE membership.namespace = ${alias}.namespace
        AND (
          membership.memory_id = ${alias}.id
          OR membership.origin_diary_id = ${alias}.id
          OR membership.day_memory_id = ${alias}.id
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM memory_candidate_dependencies AS dependency
      JOIN memory_candidates AS candidate
        ON candidate.namespace = dependency.namespace
       AND candidate.external_key = dependency.candidate_external_key
      WHERE dependency.namespace = ${alias}.namespace
        AND dependency.memory_id = ${alias}.id
        AND candidate.status IN (${pendingCandidateStatuses})
    )
    AND NOT EXISTS (
      SELECT 1
      FROM memory_candidates AS candidate
      WHERE candidate.namespace = ${alias}.namespace
        AND candidate.status IN (${pendingCandidateStatuses})
        AND (
          candidate.target_id = ${alias}.id
          OR candidate.result_memory_id = ${alias}.id
        )
    )`;
}

export async function listHardDeletableMemories(
  db: D1Database,
  namespace: string,
  cutoff: string
): Promise<HardDeletableMemory[]> {
  const result = await db
    .prepare(
      `SELECT id, vector_id
       FROM memories AS memory
       WHERE memory.namespace = ?
         AND ${hardDeleteEligibilitySql("memory")}`
    )
    .bind(namespace, cutoff)
    .all<HardDeletableMemory>();
  return result.results ?? [];
}

// ---------------------------------------------------------------------------
// memories: hard delete one guarded batch with structural/runtime-owned rows.
//           Historical records (events, terminal candidates, completed
//           deprojections) keep their own retention policy. Every statement
//           resolves the same current targets, and D1 executes batch()
//           transactionally. Diary groups are lifecycle-owned: a remaining
//           membership blocks hard deletion instead of being hidden here.
// ---------------------------------------------------------------------------

function retentionTargetsCte(idCount: number): string {
  const placeholders = Array.from({ length: idCount }, () => "?").join(", ");
  return `WITH retention_targets AS (
    SELECT memory.id
    FROM memories AS memory
    WHERE memory.namespace = ?
      AND memory.id IN (${placeholders})
      AND ${hardDeleteEligibilitySql("memory")}
  )`;
}

async function hardDeleteMemoriesBatch(
  db: D1Database,
  namespace: string,
  ids: string[],
  cutoff: string
): Promise<number> {
  if (ids.length === 0) return 0;
  const targets = retentionTargetsCte(ids.length);
  const targetBinds = [namespace, ...ids, cutoff];
  const statement = (sql: string, ...binds: unknown[]): D1PreparedStatement =>
    db.prepare(`${targets}\n${sql}`).bind(...targetBinds, ...binds);

  const results = await db.batch([
    statement(
      `DELETE FROM memory_candidate_axis_runs
       WHERE namespace = ?
         AND memory_id IN (SELECT id FROM retention_targets)`,
      namespace
    ),
    statement(
      `DELETE FROM memory_candidate_dependencies
       WHERE namespace = ?
         AND memory_id IN (SELECT id FROM retention_targets)`,
      namespace
    ),
    statement(
      `DELETE FROM memory_relations
       WHERE namespace = ?
         AND (
           source_memory_id IN (SELECT id FROM retention_targets)
           OR target_memory_id IN (SELECT id FROM retention_targets)
         )`,
      namespace
    ),
    statement(
      `DELETE FROM memory_timeline_memberships
       WHERE namespace = ?
         AND memory_id IN (SELECT id FROM retention_targets)`,
      namespace
    ),
    statement(
      `DELETE FROM memory_five_axis_outbox
       WHERE namespace = ?
         AND memory_id IN (SELECT id FROM retention_targets)`,
      namespace
    ),
    statement(
      `DELETE FROM memory_five_axis_runs
       WHERE namespace = ?
         AND memory_id IN (SELECT id FROM retention_targets)`,
      namespace
    ),
    statement(
      `DELETE FROM memory_metabolism_signal_state
       WHERE namespace = ?
         AND memory_id IN (SELECT id FROM retention_targets)`,
      namespace
    ),
    statement(
      `DELETE FROM memory_recall_daily
       WHERE namespace = ?
         AND memory_id IN (SELECT id FROM retention_targets)`,
      namespace
    ),
    statement(
      `DELETE FROM memory_recall_receipts
       WHERE namespace = ?
         AND memory_id IN (SELECT id FROM retention_targets)`,
      namespace
    ),
    statement(
      `DELETE FROM memories
       WHERE namespace = ?
         AND id IN (SELECT id FROM retention_targets)`,
      namespace
    )
  ]);
  return results.at(-1)?.meta.changes ?? 0;
}

// ---------------------------------------------------------------------------
// memories: hard delete in batches of RETENTION_BATCH_SIZE
// ---------------------------------------------------------------------------

export async function hardDeleteMemoriesBatched(
  db: D1Database,
  namespace: string,
  ids: string[],
  cutoff: string
): Promise<number> {
  let total = 0;
  for (let i = 0; i < ids.length; i += RETENTION_BATCH_SIZE) {
    const batch = ids.slice(i, i + RETENTION_BATCH_SIZE);
    total += await hardDeleteMemoriesBatch(db, namespace, batch, cutoff);
  }
  return total;
}

// ---------------------------------------------------------------------------
// processing_cursors: read cursor value (returns null if not set)
// ---------------------------------------------------------------------------

export async function readCursor(
  db: D1Database,
  name: string
): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM processing_cursors WHERE name = ?")
    .bind(name)
    .first<{ value: string }>();
  return row?.value ?? null;
}

// ---------------------------------------------------------------------------
// processing_cursors: upsert cursor value
// ---------------------------------------------------------------------------

export async function writeCursor(
  db: D1Database,
  name: string,
  value: string
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO processing_cursors (name, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(name, value, now)
    .run();
}
