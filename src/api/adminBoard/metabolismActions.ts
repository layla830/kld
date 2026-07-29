import { prepareMemoryEventInsert } from "../../db/memoryEvents";
import { loadDreamConfig } from "../../config/runtime";
import {
  commitMemoryCandidateApproval,
  commitMemoryCandidateRollback,
  getMemoryCandidate,
  resolveMemoryCandidate
} from "../../db/memoryCandidates";
import {
  getMemoryById,
  prepareMemoryUpdate,
  type MemoryMutationGuard
} from "../../db/memories";
import type { Env, MemoryRecord } from "../../types";
import {
  COLD_MEMORY_MAX_CONFIDENCE,
  COLD_MEMORY_MAX_IMPORTANCE,
  PROTECTED_MEMORY_TYPES
} from "../../memory/metabolismReview";
import { newId } from "../../utils/ids";
import { nowIso } from "../../utils/time";
import { payloadOf, readFormText } from "./utils";
import {
  finishPreparedMemoryDeprojection,
  prepareMemoryDeprojection
} from "../../memory/deprojection";
import { reconcileMemoryVector } from "../../memory/state";
import {
  combineMutationGuards,
  memoryCandidateStatusGuard,
  memoryEventExistsGuard
} from "../../db/mutationGuards";

export type MetabolismAction = "m_archive" | "m_relation_cleanup";
type MetabolismResult = { memory: MemoryRecord | null; action: MetabolismAction | "rollback" };
type MetabolismBatchDecision = "approve" | "reject";

export interface MetabolismBatchResult {
  decision: MetabolismBatchDecision;
  selected: number;
  processed: number;
  skipped: number;
}

const MAX_METABOLISM_BATCH_SIZE = 30;

function beforeOf(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.before && typeof payload.before === "object" ? payload.before as Record<string, unknown> : {};
}

function relationSnapshotStatement(
  db: D1Database,
  input: {
    namespace: string;
    candidateId: string;
    relationId: string;
    sourceMemoryId: string;
    targetMemoryId: string;
    relationType: string;
    before: Record<string, unknown>;
    relationWasPresent: boolean;
  }
): D1PreparedStatement {
  const now = nowIso();
  return db.prepare(
    `INSERT INTO memory_events (id, namespace, event_type, memory_id, payload_json, created_at)
     SELECT ?, ?, 'm_snapshot', NULL, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM memory_candidates
       WHERE namespace = ? AND id = ? AND status = 'pending' AND action = 'm_relation_cleanup'
     )
       AND (
         NOT EXISTS (
           SELECT 1 FROM memory_relations WHERE namespace = ? AND id = ?
         )
         OR EXISTS (
           SELECT 1 FROM memory_relations
           WHERE namespace = ? AND id = ?
             AND source_memory_id = ? AND target_memory_id = ? AND relation_type = ?
         )
       )`
  ).bind(
    newId("ev"),
    input.namespace,
    JSON.stringify({
      candidate_id: input.candidateId,
      action: "m_relation_cleanup",
      before: input.before,
      relation_was_present: input.relationWasPresent
    }),
    now,
    input.namespace,
    input.candidateId,
    input.namespace,
    input.relationId,
    input.namespace,
    input.relationId,
    input.sourceMemoryId,
    input.targetMemoryId,
    input.relationType
  );
}

export async function approveMetabolismCandidate(
  env: Env,
  form: FormData,
  options: { relationOnly?: boolean } = {}
): Promise<MetabolismResult | null> {
  const id = readFormText(form, "id");
  if (!id) return null;
  const namespace = loadDreamConfig(env).namespace;
  const candidate = await getMemoryCandidate(env.DB, namespace, id);
  if (!candidate || candidate.status !== "pending" || !["m_archive", "m_relation_cleanup"].includes(candidate.action)) return null;
  if (options.relationOnly && candidate.action !== "m_relation_cleanup") return null;
  const action = candidate.action as MetabolismAction;
  const before = beforeOf(payloadOf(candidate.payload_json));

  if (action === "m_archive") {
    if (!candidate.target_id) return null;
    const target = await getMemoryById(env.DB, { namespace, id: candidate.target_id });
    if (!target || target.status !== "active" || target.pinned || PROTECTED_MEMORY_TYPES.has(target.type)) return null;
    if (typeof before.updated_at !== "string" || target.updated_at !== before.updated_at) {
      throw new Error("metabolism_candidate_is_stale");
    }
    const payload = payloadOf(candidate.payload_json);
    const policy = typeof payload.policy === "string" ? payload.policy : "expired_project_state";
    if (policy === "expired_project_state") {
      if (target.type !== "project_state" || !target.expires_at || new Date(target.expires_at).getTime() >= Date.now()) {
        throw new Error("metabolism_candidate_is_stale");
      }
    } else if (policy === "cold_low_signal") {
      const coldBefore = typeof payload.cold_before === "string" ? payload.cold_before : "";
      const lastSignalAt = target.last_recalled_at || target.created_at;
      const relation = await env.DB.prepare(
        `SELECT id FROM memory_relations
         WHERE namespace = ? AND (source_memory_id = ? OR target_memory_id = ?) LIMIT 1`
      ).bind(namespace, target.id, target.id).first<{ id: string }>();
      if (!coldBefore || target.created_at >= coldBefore || lastSignalAt >= coldBefore
        || target.recall_count !== 0 || target.importance > COLD_MEMORY_MAX_IMPORTANCE
        || target.confidence > COLD_MEMORY_MAX_CONFIDENCE || relation?.id) {
        throw new Error("metabolism_candidate_is_stale");
      }
    } else {
      return null;
    }
    const mutationAt = nowIso();
    const deprojection = await prepareMemoryDeprojection(env.DB, {
      namespace,
      memoryId: target.id,
      patch: { status: "archived", activeFact: false },
      expectedStatus: "active",
      expectedRevision: target.five_axis_revision ?? 1,
      requireUnpinned: true,
      source: "m_review",
      reason: "m_review_archive",
      candidateId: candidate.id,
      operationId: `deproj_${candidate.id}`,
      memory: target,
      guard: combineMutationGuards(
        memoryCandidateStatusGuard(namespace, candidate.id, "pending"),
        { sql: "memory.updated_at = ?", binds: [target.updated_at] }
      ),
      now: mutationAt
    });
    const snapshotEventId = `ev_m_snapshot_${candidate.id}`;
    const snapshotEvent = prepareMemoryEventInsert(env.DB, {
      namespace,
      eventType: "m_snapshot",
      memoryId: target.id,
      payload: { candidate_id: candidate.id, action, before }
    }, {
      id: snapshotEventId,
      now: mutationAt,
      guard: deprojection.successGuard
    });
    const committed = await commitMemoryCandidateApproval(env.DB, {
      namespace,
      id: candidate.id,
      expectedStatus: "pending",
      resultMemoryId: target.id,
      businessStatements: [...deprojection.statements, snapshotEvent],
      successGuard: combineMutationGuards(
        deprojection.successGuard,
        memoryEventExistsGuard(namespace, snapshotEventId)
      )
    });
    if (!committed) return null;
    const archived = await getMemoryById(env.DB, { namespace, id: target.id });
    if (!archived) throw new Error("metabolism_deprojection_target_missing");
    await finishPreparedMemoryDeprojection(env, deprojection);
    await reconcileMemoryVector(env, {
      namespace: archived.namespace,
      memoryId: archived.id
    });
    return { memory: archived, action };
  }

  const relationId = typeof before.id === "string" ? before.id : "";
  const sourceMemoryId = typeof before.source_memory_id === "string" ? before.source_memory_id : "";
  const targetMemoryId = typeof before.target_memory_id === "string" ? before.target_memory_id : "";
  const relationType = typeof before.relation_type === "string" ? before.relation_type : "";
  if (!relationId || !sourceMemoryId || !targetMemoryId || !relationType) {
    throw new Error("metabolism_relation_candidate_invalid");
  }

  const existing = await env.DB.prepare("SELECT * FROM memory_relations WHERE namespace = ? AND id = ?")
    .bind(namespace, relationId).first<Record<string, unknown>>();
  if (existing) {
    for (const key of ["source_memory_id", "target_memory_id", "relation_type"]) {
      if (existing[key] !== before[key]) throw new Error("metabolism_relation_candidate_changed");
    }
  }

  const deleteRelation = env.DB.prepare(
    `DELETE FROM memory_relations
     WHERE namespace = ? AND id = ?
       AND source_memory_id = ? AND target_memory_id = ? AND relation_type = ?
       AND EXISTS (
         SELECT 1 FROM memory_candidates
         WHERE namespace = ? AND id = ? AND status = 'pending' AND action = 'm_relation_cleanup'
       )`
  ).bind(
    namespace,
    relationId,
    sourceMemoryId,
    targetMemoryId,
    relationType,
    namespace,
    candidate.id
  );

  const committed = await commitMemoryCandidateApproval(env.DB, {
    namespace,
    id: candidate.id,
    expectedStatus: "pending",
    resultMemoryId: relationId,
    businessStatements: [
      relationSnapshotStatement(env.DB, {
        namespace,
        candidateId: candidate.id,
        relationId,
        sourceMemoryId,
        targetMemoryId,
        relationType,
        before,
        relationWasPresent: Boolean(existing)
      }),
      deleteRelation
    ],
    successGuard: {
      sql: "NOT EXISTS (SELECT 1 FROM memory_relations WHERE namespace = ? AND id = ?)",
      binds: [namespace, relationId]
    }
  });

  if (!committed) {
    const current = await env.DB.prepare("SELECT id FROM memory_relations WHERE namespace = ? AND id = ?")
      .bind(namespace, relationId).first<{ id: string }>();
    if (current) throw new Error("metabolism_relation_candidate_changed");
    return null;
  }
  return { memory: null, action };
}

export async function rejectMetabolismCandidate(
  env: Env,
  form: FormData,
  options: { relationOnly?: boolean } = {}
): Promise<boolean> {
  const id = readFormText(form, "id");
  if (!id) return false;
  const namespace = loadDreamConfig(env).namespace;
  const candidate = await getMemoryCandidate(env.DB, namespace, id);
  if (!candidate || candidate.status !== "pending" || !candidate.action.startsWith("m_")) return false;
  if (options.relationOnly && candidate.action !== "m_relation_cleanup") return false;
  return resolveMemoryCandidate(env.DB, namespace, id, "rejected");
}

export async function batchReviewMetabolismCandidates(env: Env, form: FormData): Promise<MetabolismBatchResult | null> {
  const decision = readFormText(form, "decision");
  if (decision !== "approve" && decision !== "reject") return null;
  const ids = Array.from(new Set(
    form.getAll("id")
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean)
  )).slice(0, MAX_METABOLISM_BATCH_SIZE);
  if (ids.length === 0) return { decision, selected: 0, processed: 0, skipped: 0 };

  let processed = 0;
  let skipped = 0;
  for (const id of ids) {
    const item = new FormData();
    item.set("id", id);
    try {
      const result = decision === "approve"
        ? await approveMetabolismCandidate(env, item, { relationOnly: true })
        : await rejectMetabolismCandidate(env, item, { relationOnly: true });
      if (result) processed += 1;
      else skipped += 1;
    } catch (error) {
      skipped += 1;
      console.error("admin metabolism batch item skipped", {
        candidateId: id,
        decision,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { decision, selected: ids.length, processed, skipped };
}

export async function rollbackMetabolismCandidate(env: Env, form: FormData): Promise<MetabolismResult | null> {
  const id = readFormText(form, "id");
  if (!id) return null;
  const namespace = loadDreamConfig(env).namespace;
  const candidate = await getMemoryCandidate(env.DB, namespace, id);
  if (!candidate || candidate.status !== "approved" || !["m_archive", "m_relation_cleanup"].includes(candidate.action)) return null;
  const before = beforeOf(payloadOf(candidate.payload_json));
  let memory: MemoryRecord | null = null;
  const mutationAt = nowIso();
  const candidateGuard = memoryCandidateStatusGuard(namespace, candidate.id, "approved");
  const rollbackEventId = `ev_m_rollback_${candidate.id}`;
  const businessStatements: D1PreparedStatement[] = [];
  let successGuard: MemoryMutationGuard;

  if (candidate.action === "m_archive") {
    if (!candidate.target_id) return null;
    const current = await getMemoryById(env.DB, { namespace, id: candidate.target_id });
    if (!current || current.status !== "archived") throw new Error("metabolism_rollback_target_changed");
    const restore = prepareMemoryUpdate(env.DB, {
      namespace,
      id: current.id,
      patch: {
        status: typeof before.status === "string" ? before.status : "active",
        activeFact: before.active_fact !== 0
      },
      expectedStatus: "archived",
      expectedRevision: current.five_axis_revision ?? 1,
      guard: candidateGuard,
      markVectorUnsynced: true,
      now: mutationAt
    });
    if (!restore) return null;
    const restoredStatus = typeof before.status === "string" ? before.status : "active";
    const restoredGuard = {
      sql: "EXISTS (SELECT 1 FROM memories WHERE namespace = ? AND id = ? AND status = ? AND updated_at = ?)",
      binds: [namespace, current.id, restoredStatus, mutationAt]
    };
    businessStatements.push(
      restore,
      prepareMemoryEventInsert(env.DB, {
        namespace,
        eventType: "m_rollback",
        memoryId: current.id,
        payload: { candidate_id: candidate.id, action: candidate.action, restored: before }
      }, {
        id: rollbackEventId,
        now: mutationAt,
        guard: combineMutationGuards(candidateGuard, restoredGuard)
      })
    );
    successGuard = combineMutationGuards(
      restoredGuard,
      memoryEventExistsGuard(namespace, rollbackEventId)
    );
  } else {
    const required = ["id", "source_memory_id", "target_memory_id", "relation_type", "strength", "created_at"];
    if (required.some((key) => before[key] === undefined || before[key] === null)) return null;
    const relationAbsentGuard = {
      sql: "NOT EXISTS (SELECT 1 FROM memory_relations WHERE namespace = ? AND id = ?)",
      binds: [namespace, before.id]
    };
    const rollbackEvent = prepareMemoryEventInsert(env.DB, {
      namespace,
      eventType: "m_rollback",
      payload: { candidate_id: candidate.id, action: candidate.action, restored: before }
    }, {
      id: rollbackEventId,
      now: mutationAt,
      guard: combineMutationGuards(candidateGuard, relationAbsentGuard)
    });
    const restoreRelation = env.DB.prepare(
      `INSERT INTO memory_relations
       (id, namespace, source_memory_id, target_memory_id, relation_type, strength, reason, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM memory_events WHERE namespace = ? AND id = ?
       )`
    ).bind(
      before.id, namespace, before.source_memory_id, before.target_memory_id,
      before.relation_type, before.strength, before.reason ?? null, before.created_at,
      namespace, rollbackEventId
    );
    const relationRestoredGuard = {
      sql: `EXISTS (
        SELECT 1 FROM memory_relations
        WHERE namespace = ? AND id = ?
          AND source_memory_id = ? AND target_memory_id = ? AND relation_type = ?
      )`,
      binds: [
        namespace,
        before.id,
        before.source_memory_id,
        before.target_memory_id,
        before.relation_type
      ]
    };
    businessStatements.push(rollbackEvent, restoreRelation);
    successGuard = combineMutationGuards(
      relationRestoredGuard,
      memoryEventExistsGuard(namespace, rollbackEventId)
    );
  }

  const committed = await commitMemoryCandidateRollback(env.DB, {
    namespace,
    id: candidate.id,
    expectedStatus: "approved",
    businessStatements,
    successGuard
  });
  if (!committed) {
    if (candidate.action === "m_relation_cleanup") {
      const current = await env.DB.prepare(
        "SELECT id FROM memory_relations WHERE namespace = ? AND id = ?"
      ).bind(namespace, before.id).first<{ id: string }>();
      if (current) throw new Error("metabolism_relation_rollback_conflict");
    }
    return null;
  }
  if (candidate.action === "m_archive" && candidate.target_id) {
    memory = await getMemoryById(env.DB, { namespace, id: candidate.target_id });
    if (!memory) throw new Error("metabolism_rollback_target_missing_after_commit");
  }
  return { memory, action: "rollback" };
}
