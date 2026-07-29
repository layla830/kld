import { newId } from "../utils/ids";
import { nowIso } from "../utils/time";
import type { CandidateAction } from "../memory/candidateActionContract";
import {
  prepareCandidateAxisRunReconciliation,
  prepareCandidateAxisRunReconciliationByExternalKey
} from "./memoryFiveAxisRuns";
import {
  PENDING_MEMORY_CANDIDATE_STATUSES,
  RECONCILABLE_CANDIDATE_RUN_STATUSES,
  SUPERSEDED_CANDIDATE_SNAPSHOT_REASON,
  candidateReviewStatusSql,
  prepareMemoryCandidateDependencyReplacement,
  type MemoryCandidateDeclaredDependency
} from "./memoryCandidateDependencies";

export interface MemoryCandidateRecord {
  id: string;
  namespace: string;
  external_key: string;
  dream_date: string;
  action: string;
  subject: string | null;
  target_id: string | null;
  payload_json: string;
  source_chunk_ids_json: string;
  source_chunks_json: string;
  status: string;
  validation_error: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  result_memory_id: string | null;
  target_content?: string | null;
  target_type?: string | null;
  target_status?: string | null;
  source_memory_content?: string | null;
  source_memory_type?: string | null;
  source_memory_status?: string | null;
  source_memory_active_fact?: number | null;
  target_memory_content?: string | null;
  target_memory_type?: string | null;
  target_memory_status?: string | null;
  target_memory_active_fact?: number | null;
}

export interface CandidateInput {
  externalKey: string;
  dreamDate: string;
  action: CandidateAction;
  subject?: string | null;
  targetId?: string | null;
  payload: Record<string, unknown>;
  sourceChunkIds: number[];
  sourceChunks?: Array<Record<string, unknown>>;
  status: "pending" | "needs_subject_review" | "deferred_relation";
  validationError?: string | null;
  dependencies?: readonly MemoryCandidateDeclaredDependency[];
}

export type OperationalCandidateFamily =
  | {
      action: "y_relation_review";
      relationType: string;
      sourceMemoryId: string;
      targetMemoryId: string;
    }
  | {
      action: "m_archive";
      targetMemoryId: string;
    }
  | {
      action: "z_supersede";
      factKey: string;
    };

function sqlStringList(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
}

function operationalCandidateFamilySelection(
  family: OperationalCandidateFamily,
  candidateAlias: string
): { sql: string; binds: unknown[] } {
  if (family.action === "y_relation_review") {
    return {
      sql: `${candidateAlias}.action = 'y_relation_review'
        AND json_extract(${candidateAlias}.payload_json, '$.relation_type') = ?
        AND json_extract(${candidateAlias}.payload_json, '$.source_id') = ?
        AND json_extract(${candidateAlias}.payload_json, '$.target_id') = ?`,
      binds: [
        family.relationType,
        family.sourceMemoryId,
        family.targetMemoryId
      ]
    };
  }
  if (family.action === "m_archive") {
    return {
      sql: `${candidateAlias}.action = 'm_archive'
        AND ${candidateAlias}.target_id = ?`,
      binds: [family.targetMemoryId]
    };
  }
  return {
    sql: `${candidateAlias}.action = 'z_supersede'
      AND json_extract(${candidateAlias}.payload_json, '$.fact_key') = ?`,
    binds: [family.factKey]
  };
}

function prepareMemoryCandidateUpsert(
  db: D1Database,
  namespace: string,
  input: CandidateInput,
  now: string
): D1PreparedStatement[] {
  const candidateWrite = db.prepare(
    `INSERT INTO memory_candidates
      (id, namespace, external_key, dream_date, action, subject, target_id, payload_json,
       source_chunk_ids_json, source_chunks_json, status, validation_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(namespace, external_key) DO UPDATE SET
       payload_json=excluded.payload_json, source_chunk_ids_json=excluded.source_chunk_ids_json,
       source_chunks_json=excluded.source_chunks_json, subject=excluded.subject,
       validation_error=excluded.validation_error, updated_at=excluded.updated_at
     WHERE memory_candidates.status IN ('pending','needs_subject_review','deferred_relation')`
  ).bind(
    newId("cand"), namespace, input.externalKey, input.dreamDate, input.action,
    input.subject ?? null, input.targetId ?? null, JSON.stringify(input.payload),
    JSON.stringify(input.sourceChunkIds), JSON.stringify(input.sourceChunks ?? []),
    input.status, input.validationError ?? null, now, now
  );
  const dependencies = [
    ...(input.targetId ? [{ memoryId: input.targetId, role: "target" as const }] : []),
    ...(input.dependencies ?? [])
  ].filter(
    (dependency, index, all) => dependency.memoryId
      && all.findIndex((candidate) =>
        candidate.memoryId === dependency.memoryId && candidate.role === dependency.role
      ) === index
  );
  return [
    candidateWrite,
    ...prepareMemoryCandidateDependencyReplacement(
      db,
      namespace,
      input.externalKey,
      dependencies
    )
  ];
}

export async function upsertMemoryCandidate(db: D1Database, namespace: string, input: CandidateInput): Promise<void> {
  await db.batch(prepareMemoryCandidateUpsert(db, namespace, input, nowIso()));
}

export async function replacePendingOperationalCandidateFamily(
  db: D1Database,
  namespace: string,
  family: OperationalCandidateFamily,
  inputs: readonly CandidateInput[]
): Promise<{ candidateExternalKeys: string[]; superseded: number }> {
  if (inputs.some((input) => input.action !== family.action)) {
    throw new Error("operational_candidate_family_action_mismatch");
  }
  const now = nowIso();
  const candidateExternalKeys = [...new Set(
    inputs.map((input) => input.externalKey.trim()).filter(Boolean)
  )];
  const desiredKeysJson = JSON.stringify(candidateExternalKeys);
  const familySelection = operationalCandidateFamilySelection(family, "candidate");
  const pendingStatuses = sqlStringList(PENDING_MEMORY_CANDIDATE_STATUSES);
  const rejection = db.prepare(
    `UPDATE memory_candidates AS candidate
     SET status = 'rejected',
         validation_error = ?,
         resolved_at = ?,
         updated_at = ?
     WHERE candidate.namespace = ?
       AND candidate.status IN (${pendingStatuses})
       AND (${familySelection.sql})
       AND NOT EXISTS (
         SELECT 1 FROM json_each(?) AS desired
         WHERE desired.value = candidate.external_key
       )`
  ).bind(
    SUPERSEDED_CANDIDATE_SNAPSHOT_REASON,
    now,
    now,
    namespace,
    ...familySelection.binds,
    desiredKeysJson
  );
  const rejectedFamilySelection = operationalCandidateFamilySelection(family, "candidate");
  const reconcile = db.prepare(
    `UPDATE memory_five_axis_runs AS runs
     SET status = ${candidateReviewStatusSql("runs")},
         claim_token = NULL,
         lease_expires_at = NULL,
         completed_at = ?,
         updated_at = ?
     WHERE runs.status IN (${sqlStringList(RECONCILABLE_CANDIDATE_RUN_STATUSES)})
       AND EXISTS (
         SELECT 1
         FROM memory_candidate_axis_runs AS link
         JOIN memory_candidates AS candidate
           ON candidate.namespace = link.namespace
          AND candidate.external_key = link.candidate_external_key
         WHERE link.namespace = runs.namespace
           AND link.memory_id = runs.memory_id
           AND link.memory_revision = runs.memory_revision
           AND link.axis = runs.axis
           AND candidate.namespace = ?
           AND candidate.status = 'rejected'
           AND candidate.validation_error = ?
           AND candidate.resolved_at = ?
           AND (${rejectedFamilySelection.sql})
       )`
  ).bind(
    now,
    now,
    namespace,
    SUPERSEDED_CANDIDATE_SNAPSHOT_REASON,
    now,
    ...rejectedFamilySelection.binds
  );
  const candidateWrites = inputs.flatMap((input) =>
    prepareMemoryCandidateUpsert(db, namespace, input, now)
  );
  const results = await db.batch([
    ...candidateWrites,
    rejection,
    reconcile
  ]);
  return {
    candidateExternalKeys,
    superseded: results[candidateWrites.length]?.meta.changes ?? 0
  };
}

export async function listMemoryCandidates(db: D1Database, namespace: string, limit = 100): Promise<MemoryCandidateRecord[]> {
  const result = await db.prepare(
    `SELECT c.*, m.content AS target_content, m.type AS target_type, m.status AS target_status
     FROM memory_candidates c
     LEFT JOIN memories m ON m.namespace = c.namespace AND m.id = c.target_id
     WHERE c.namespace = ?
       AND c.action NOT IN ('timeline_date','z_supersede','y_relation_review','m_archive','m_relation_cleanup')
       AND c.status IN ('pending','needs_subject_review')
     ORDER BY c.dream_date DESC, c.created_at DESC LIMIT ?`
  ).bind(namespace, limit).all<MemoryCandidateRecord>();
  return result.results ?? [];
}

export async function listMemoryCandidatesByAction(db: D1Database, namespace: string, action: string, limit = 100, offset = 0): Promise<MemoryCandidateRecord[]> {
  const result = await db.prepare(
    `SELECT c.*, m.content AS target_content, m.type AS target_type, m.status AS target_status
     FROM memory_candidates c
     LEFT JOIN memories m ON m.namespace = c.namespace AND m.id = c.target_id
     WHERE c.namespace = ? AND c.action = ? AND c.status = 'pending'
     ORDER BY c.dream_date DESC, c.created_at DESC LIMIT ? OFFSET ?`
  ).bind(namespace, action, limit, offset).all<MemoryCandidateRecord>();
  return result.results ?? [];
}

export async function countMemoryCandidatesByAction(db: D1Database, namespace: string, action: string): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS count FROM memory_candidates WHERE namespace = ? AND action = ? AND status = 'pending'"
  ).bind(namespace, action).first<{ count: number }>();
  return row?.count ?? 0;
}

export async function listMetabolismCandidates(db: D1Database, namespace: string, limit = 100): Promise<MemoryCandidateRecord[]> {
  const result = await db.prepare(
    `SELECT c.*, m.content AS target_content, m.type AS target_type, m.status AS target_status
     FROM memory_candidates c
     LEFT JOIN memories m ON m.namespace = c.namespace AND m.id = c.target_id
     WHERE c.namespace = ?
       AND c.action IN ('m_archive','m_relation_cleanup')
       AND c.status = 'pending'
     ORDER BY c.created_at DESC
     LIMIT ?`
  ).bind(namespace, limit).all<MemoryCandidateRecord>();
  return enrichMetabolismRelationEndpoints(db, namespace, result.results ?? []);
}

const OPERATIONAL_REVIEW_ACTIONS = ["z_supersede", "y_relation_review", "m_archive", "m_relation_cleanup"] as const;

export async function listOperationalReviewCandidates(db: D1Database, namespace: string, limit = 100): Promise<MemoryCandidateRecord[]> {
  const placeholders = OPERATIONAL_REVIEW_ACTIONS.map(() => "?").join(", ");
  const result = await db.prepare(
    `SELECT c.*, m.content AS target_content, m.type AS target_type, m.status AS target_status
     FROM memory_candidates c
     LEFT JOIN memories m ON m.namespace = c.namespace AND m.id = c.target_id
     WHERE c.namespace = ? AND c.action IN (${placeholders}) AND c.status = 'pending'
     ORDER BY CASE c.action WHEN 'z_supersede' THEN 0 WHEN 'y_relation_review' THEN 1 ELSE 2 END, c.created_at DESC
     LIMIT ?`
  ).bind(namespace, ...OPERATIONAL_REVIEW_ACTIONS, limit).all<MemoryCandidateRecord>();
  return enrichMetabolismRelationEndpoints(db, namespace, result.results ?? []);
}

export async function listRecentApprovedOperationalReviewCandidates(db: D1Database, namespace: string, limit = 12): Promise<MemoryCandidateRecord[]> {
  const placeholders = OPERATIONAL_REVIEW_ACTIONS.map(() => "?").join(", ");
  const result = await db.prepare(
    `SELECT c.*, m.content AS target_content, m.type AS target_type, m.status AS target_status
     FROM memory_candidates c
     LEFT JOIN memories m ON m.namespace = c.namespace AND m.id = c.target_id
     WHERE c.namespace = ? AND c.action IN (${placeholders}) AND c.status = 'approved'
     ORDER BY c.resolved_at DESC LIMIT ?`
  ).bind(namespace, ...OPERATIONAL_REVIEW_ACTIONS, limit).all<MemoryCandidateRecord>();
  return enrichMetabolismRelationEndpoints(db, namespace, result.results ?? []);
}

async function enrichMetabolismRelationEndpoints(db: D1Database, namespace: string, rows: MemoryCandidateRecord[]): Promise<MemoryCandidateRecord[]> {
  const relationKeys = [...new Set(rows
    .filter((row) => row.action === "m_relation_cleanup" || row.action === "y_relation_review")
    .map((row) => row.external_key))];
  if (relationKeys.length === 0) return rows;
  const placeholders = relationKeys.map(() => "?").join(", ");
  const result = await db.prepare(
    `SELECT
       dependency.candidate_external_key,
       dependency.role,
       memory.content,
       memory.type,
       memory.status,
       memory.active_fact
     FROM memory_candidate_dependencies AS dependency
     LEFT JOIN memories AS memory
       ON memory.namespace = dependency.namespace
      AND memory.id = dependency.memory_id
     WHERE dependency.namespace = ?
       AND dependency.candidate_external_key IN (${placeholders})
       AND dependency.role IN ('source', 'target')`
  ).bind(namespace, ...relationKeys).all<{
    candidate_external_key: string;
    role: "source" | "target";
    content: string | null;
    type: string | null;
    status: string | null;
    active_fact: number | null;
  }>();
  const endpointByCandidate = new Map<string, {
    source?: { content: string | null; type: string | null; status: string | null; active_fact: number | null };
    target?: { content: string | null; type: string | null; status: string | null; active_fact: number | null };
  }>();
  for (const endpoint of result.results ?? []) {
    const candidate = endpointByCandidate.get(endpoint.candidate_external_key) ?? {};
    candidate[endpoint.role] = endpoint;
    endpointByCandidate.set(endpoint.candidate_external_key, candidate);
  }

  return rows.map((row) => {
    const endpoints = endpointByCandidate.get(row.external_key);
    if (!endpoints) return row;
    const source = endpoints.source;
    const target = endpoints.target;
    return {
      ...row,
      source_memory_content: source?.content ?? null,
      source_memory_type: source?.type ?? null,
      source_memory_status: source?.status ?? null,
      source_memory_active_fact: source?.active_fact ?? null,
      target_memory_content: target?.content ?? null,
      target_memory_type: target?.type ?? null,
      target_memory_status: target?.status ?? null,
      target_memory_active_fact: target?.active_fact ?? null
    };
  });
}

export async function countPendingMetabolismCandidates(db: D1Database, namespace: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count FROM memory_candidates
     WHERE namespace = ? AND action IN ('m_archive','m_relation_cleanup') AND status = 'pending'`
  ).bind(namespace).first<{ count: number }>();
  return row?.count ?? 0;
}

export async function countPendingOperationalReviewCandidates(db: D1Database, namespace: string): Promise<number> {
  const placeholders = OPERATIONAL_REVIEW_ACTIONS.map(() => "?").join(", ");
  const row = await db.prepare(
    `SELECT COUNT(*) AS count FROM memory_candidates
     WHERE namespace = ? AND action IN (${placeholders}) AND status = 'pending'`
  ).bind(namespace, ...OPERATIONAL_REVIEW_ACTIONS).first<{ count: number }>();
  return row?.count ?? 0;
}

export async function getMemoryCandidate(db: D1Database, namespace: string, id: string): Promise<MemoryCandidateRecord | null> {
  return (await db.prepare("SELECT * FROM memory_candidates WHERE namespace = ? AND id = ?")
    .bind(namespace, id).first<MemoryCandidateRecord>()) ?? null;
}

export async function updateMemoryCandidateEvidence(
  db: D1Database,
  namespace: string,
  id: string,
  payload: Record<string, unknown>,
  validationError: string | null
): Promise<boolean> {
  const now = nowIso();
  const status = validationError ? "needs_subject_review" : "pending";
  const result = await db.prepare(
    `UPDATE memory_candidates
     SET payload_json = ?, validation_error = ?, status = ?, updated_at = ?
     WHERE namespace = ? AND id = ? AND status IN ('pending','needs_subject_review')`
  ).bind(JSON.stringify(payload), validationError, status, now, namespace, id).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function resolveMemoryCandidate(db: D1Database, namespace: string, id: string, status: "approved" | "rejected", resultMemoryId?: string | null): Promise<boolean> {
  const now = nowIso();
  const update = db.prepare(
    "UPDATE memory_candidates SET status = ?, result_memory_id = ?, resolved_at = ?, updated_at = ? WHERE namespace = ? AND id = ? AND status IN ('pending','needs_subject_review')"
  ).bind(status, resultMemoryId ?? null, now, now, namespace, id);
  const results = await db.batch([
    update,
    prepareCandidateAxisRunReconciliation(db, namespace, id, now)
  ]);
  return (results[0]?.meta.changes ?? 0) > 0;
}

export async function commitMemoryCandidateApproval(
  db: D1Database,
  input: {
    namespace: string;
    id: string;
    expectedStatus: string;
    resultMemoryId: string;
    businessStatements: D1PreparedStatement[];
    successGuard?: { sql: string; binds: unknown[] };
  }
): Promise<boolean> {
  const now = nowIso();
  const successClause = input.successGuard ? ` AND (${input.successGuard.sql})` : "";
  const update = db.prepare(
    `UPDATE memory_candidates
     SET status = 'approved', result_memory_id = ?, resolved_at = ?, updated_at = ?
     WHERE namespace = ? AND id = ? AND status = ?${successClause}`
  ).bind(
    input.resultMemoryId,
    now,
    now,
    input.namespace,
    input.id,
    input.expectedStatus,
    ...(input.successGuard?.binds ?? [])
  );
  const updateIndex = input.businessStatements.length;
  const results = await db.batch([
    ...input.businessStatements,
    update,
    prepareCandidateAxisRunReconciliation(db, input.namespace, input.id, now)
  ]);
  return (results[updateIndex]?.meta.changes ?? 0) === 1;
}

export async function commitMemoryCandidateRollback(
  db: D1Database,
  input: {
    namespace: string;
    id: string;
    expectedStatus: "approved";
    businessStatements: D1PreparedStatement[];
    successGuard?: { sql: string; binds: unknown[] };
  }
): Promise<boolean> {
  const now = nowIso();
  const successClause = input.successGuard ? ` AND (${input.successGuard.sql})` : "";
  const update = db.prepare(
    `UPDATE memory_candidates
     SET status = 'rolled_back', resolved_at = ?, updated_at = ?
     WHERE namespace = ? AND id = ? AND status = ?${successClause}`
  ).bind(
    now,
    now,
    input.namespace,
    input.id,
    input.expectedStatus,
    ...(input.successGuard?.binds ?? [])
  );
  const updateIndex = input.businessStatements.length;
  const results = await db.batch([
    ...input.businessStatements,
    update,
    prepareCandidateAxisRunReconciliation(db, input.namespace, input.id, now)
  ]);
  return (results[updateIndex]?.meta.changes ?? 0) === 1;
}

export async function rollbackMemoryCandidate(db: D1Database, namespace: string, id: string): Promise<boolean> {
  return commitMemoryCandidateRollback(db, {
    namespace,
    id,
    expectedStatus: "approved",
    businessStatements: []
  });
}

export async function dismissPendingMemoryCandidateByExternalKey(db: D1Database, namespace: string, externalKey: string): Promise<boolean> {
  const now = nowIso();
  const update = db.prepare(
    "UPDATE memory_candidates SET status = 'rejected', resolved_at = ?, updated_at = ? WHERE namespace = ? AND external_key = ? AND status IN ('pending','needs_subject_review')"
  ).bind(now, now, namespace, externalKey);
  const results = await db.batch([
    update,
    prepareCandidateAxisRunReconciliationByExternalKey(db, namespace, externalKey, now)
  ]);
  return (results[0]?.meta.changes ?? 0) > 0;
}
