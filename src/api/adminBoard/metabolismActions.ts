import { createMemoryEvent } from "../../db/memoryEvents";
import { loadDreamConfig } from "../../config/runtime";
import { getMemoryCandidate, resolveMemoryCandidate, rollbackMemoryCandidate } from "../../db/memoryCandidates";
import { prepareCandidateAxisRunReconciliation } from "../../db/memoryFiveAxisRuns";
import { getMemoryById, updateMemory } from "../../db/memories";
import type { Env, MemoryRecord } from "../../types";
import { newId } from "../../utils/ids";
import { nowIso } from "../../utils/time";
import {
  COLD_MEMORY_MAX_CONFIDENCE,
  COLD_MEMORY_MAX_IMPORTANCE,
  PROTECTED_MEMORY_TYPES
} from "../../memory/metabolismReview";
import { payloadOf, readFormText } from "./utils";

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

async function snapshot(
  env: Env,
  namespace: string,
  candidateId: string,
  action: MetabolismAction,
  before: Record<string, unknown>
): Promise<void> {
  await createMemoryEvent(env.DB, {
    namespace,
    eventType: "m_snapshot",
    payload: { candidate_id: candidateId, action, before }
  });
}

async function hasCandidateAxisRunLinks(db: D1Database): Promise<boolean> {
  const row = await db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'memory_candidate_axis_runs' LIMIT 1"
  ).first<{ present: number }>();
  return row?.present === 1;
}

async function approveRelationCleanup(
  env: Env,
  namespace: string,
  candidateId: string,
  relationId: string,
  before: Record<string, unknown>,
  relationExists: boolean
): Promise<void> {
  const now = nowIso();
  const eventPayload = JSON.stringify({
    candidate_id: candidateId,
    action: "m_relation_cleanup",
    before
  });
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO memory_events (id, namespace, event_type, memory_id, payload_json, created_at)
       SELECT ?, ?, 'm_snapshot', NULL, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM memory_candidates
         WHERE namespace = ? AND id = ? AND status = 'pending'
       )
         AND NOT EXISTS (
           SELECT 1 FROM memory_events
           WHERE namespace = ? AND event_type = 'm_snapshot'
             AND json_extract(payload_json, '$.candidate_id') = ?
         )`
    ).bind(newId("ev"), namespace, eventPayload, now, namespace, candidateId, namespace, candidateId)
  ];

  if (relationExists) {
    statements.push(env.DB.prepare(
      `DELETE FROM memory_relations
       WHERE namespace = ? AND id = ?
         AND source_memory_id = ? AND target_memory_id = ? AND relation_type = ?
         AND EXISTS (
           SELECT 1 FROM memory_candidates
           WHERE namespace = ? AND id = ? AND status = 'pending'
         )`
    ).bind(
      namespace,
      relationId,
      before.source_memory_id,
      before.target_memory_id,
      before.relation_type,
      namespace,
      candidateId
    ));
  }

  const candidateUpdateIndex = statements.length;
  const candidateGuard = relationExists
    ? "AND changes() = 1"
    : `AND NOT EXISTS (
         SELECT 1 FROM memory_relations
         WHERE namespace = ? AND id = ?
       )`;
  const candidateBinds = relationExists ? [] : [namespace, relationId];
  statements.push(env.DB.prepare(
    `UPDATE memory_candidates
     SET status = 'approved', result_memory_id = NULL, resolved_at = ?, updated_at = ?
     WHERE namespace = ? AND id = ? AND status = 'pending'
       ${candidateGuard}`
  ).bind(now, now, namespace, candidateId, ...candidateBinds));

  const axisLinksReady = await hasCandidateAxisRunLinks(env.DB);
  if (axisLinksReady) {
    statements.push(prepareCandidateAxisRunReconciliation(env.DB, namespace, candidateId, now));
  }

  const results = await env.DB.batch(statements);
  if ((results[candidateUpdateIndex]?.meta.changes ?? 0) !== 1) {
    throw new Error("metabolism_relation_delete_conflict");
  }
  if (!axisLinksReady) {
    console.warn("M relation cleanup completed before candidate-axis migration was available", {
      candidateId,
      relationId
    });
  }
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
    await snapshot(env, namespace, candidate.id, action, before);
    const archived = await updateMemory(env.DB, {
      namespace,
      id: target.id,
      patch: { status: "archived", activeFact: false },
      expectedStatus: "active",
      requireUnpinned: true
    });
    if (!archived) return null;
    await resolveMemoryCandidate(env.DB, namespace, candidate.id, "approved", archived.id);
    return { memory: archived, action };
  }

  const relationId = typeof before.id === "string" ? before.id : "";
  const sourceId = typeof before.source_memory_id === "string" ? before.source_memory_id : "";
  const targetId = typeof before.target_memory_id === "string" ? before.target_memory_id : "";
  const relationType = typeof before.relation_type === "string" ? before.relation_type : "";
  if (!relationId || !sourceId || !targetId || !relationType) return null;
  const existing = await env.DB.prepare("SELECT * FROM memory_relations WHERE namespace = ? AND id = ?")
    .bind(namespace, relationId).first<Record<string, unknown>>();
  if (existing) {
    for (const key of ["source_memory_id", "target_memory_id", "relation_type"]) {
      if (existing[key] !== before[key]) throw new Error("metabolism_relation_candidate_changed");
    }
  }
  await approveRelationCleanup(env, namespace, candidate.id, relationId, before, Boolean(existing));
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

  if (candidate.action === "m_archive") {
    if (!candidate.target_id) return null;
    const current = await getMemoryById(env.DB, { namespace, id: candidate.target_id });
    if (!current || current.status !== "archived") throw new Error("metabolism_rollback_target_changed");
    memory = await updateMemory(env.DB, {
      namespace,
      id: current.id,
      patch: {
        status: typeof before.status === "string" ? before.status : "active",
        activeFact: before.active_fact !== 0
      },
      expectedStatus: "archived"
    });
    if (!memory) return null;
  } else {
    const required = ["id", "source_memory_id", "target_memory_id", "relation_type", "strength", "created_at"];
    if (required.some((key) => before[key] === undefined || before[key] === null)) return null;
    const restored = await env.DB.prepare(
      `INSERT OR IGNORE INTO memory_relations
       (id, namespace, source_memory_id, target_memory_id, relation_type, strength, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      before.id, namespace, before.source_memory_id, before.target_memory_id,
      before.relation_type, before.strength, before.reason ?? null, before.created_at
    ).run();
    if ((restored.meta.changes ?? 0) !== 1) throw new Error("metabolism_relation_rollback_conflict");
  }

  if (!await rollbackMemoryCandidate(env.DB, namespace, candidate.id)) {
    throw new Error("metabolism_rollback_state_conflict");
  }
  await createMemoryEvent(env.DB, {
    namespace,
    eventType: "m_rollback",
    payload: { candidate_id: candidate.id, action: candidate.action, restored: before }
  });
  return { memory, action: "rollback" };
}
