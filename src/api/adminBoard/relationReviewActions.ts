import { loadDreamConfig } from "../../config/runtime";
import { getMemoryCandidate, resolveMemoryCandidate, type MemoryCandidateRecord } from "../../db/memoryCandidates";
import {
  getMemoryRelationById,
  normalizeRelationPair,
  REVIEW_RELATION_TYPES,
  type MemoryRelationRecord
} from "../../db/memoryRelations";
import { getMemoryById } from "../../db/memories";
import { prepareCandidateAxisRunReconciliation } from "../../db/memoryFiveAxisRuns";
import {
  fiveAxisMemoryEligibilityPredicate,
  isFiveAxisMemoryEligible
} from "../../memory/fiveAxis/eligibility";
import type { Env } from "../../types";
import { newId } from "../../utils/ids";
import { nowIso } from "../../utils/time";
import { payloadOf, readFormText } from "./utils";

export interface RelationReviewResult {
  axis: "Y";
  action: "approve" | "rollback";
  relationId: string;
  changed: boolean;
}

interface RelationProposal {
  relationType: string;
  sourceId: string;
  targetId: string;
  sourceUpdatedAt: string;
  targetUpdatedAt: string;
  sourceRevision: number | null;
  targetRevision: number | null;
  strength: number;
  reason: string | null;
}

function revisionOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function proposalOf(payload: Record<string, unknown>): RelationProposal | null {
  const relationType = typeof payload.relation_type === "string" ? payload.relation_type.trim() : "";
  const sourceId = typeof payload.source_id === "string" ? payload.source_id.trim() : "";
  const targetId = typeof payload.target_id === "string" ? payload.target_id.trim() : "";
  const sourceUpdatedAt = typeof payload.source_updated_at === "string" ? payload.source_updated_at : "";
  const targetUpdatedAt = typeof payload.target_updated_at === "string" ? payload.target_updated_at : "";
  if (!REVIEW_RELATION_TYPES.has(relationType) || !sourceId || !targetId || sourceId === targetId
    || !sourceUpdatedAt || !targetUpdatedAt) return null;
  const pair = normalizeRelationPair(sourceId, targetId, relationType);
  if (pair.sourceMemoryId !== sourceId || pair.targetMemoryId !== targetId) return null;
  return {
    relationType: pair.relationType,
    sourceId: pair.sourceMemoryId,
    targetId: pair.targetMemoryId,
    sourceUpdatedAt,
    targetUpdatedAt,
    sourceRevision: revisionOf(payload.source_revision),
    targetRevision: revisionOf(payload.target_revision),
    strength: typeof payload.strength === "number" && Number.isFinite(payload.strength)
      ? Math.min(Math.max(payload.strength, 0), 1)
      : 0.6,
    reason: typeof payload.reason === "string" ? payload.reason : null
  };
}

async function findProposalRelation(
  db: D1Database,
  namespace: string,
  proposal: RelationProposal
): Promise<MemoryRelationRecord | null> {
  return (await db.prepare(
    `SELECT * FROM memory_relations
     WHERE namespace = ? AND source_memory_id = ? AND target_memory_id = ? AND relation_type = ?`
  ).bind(namespace, proposal.sourceId, proposal.targetId, proposal.relationType)
    .first<MemoryRelationRecord>()) ?? null;
}

async function commitApproval(
  env: Env,
  candidate: MemoryCandidateRecord,
  proposal: RelationProposal,
  relationId: string,
  inserted: boolean
): Promise<boolean> {
  const now = nowIso();
  const approvalToken = newId("approval");
  const approvedPayload = JSON.stringify({
    ...payloadOf(candidate.payload_json),
    approval: { relation_id: relationId, inserted, token: approvalToken }
  });
  const eventId = newId("ev");
  const eventPayload = JSON.stringify({
    candidate_id: candidate.id,
    relation_id: relationId,
    inserted,
    proposal
  });
  const statements: D1PreparedStatement[] = [];
  const endpointGuard = (memoryId: string, revision: number | null, updatedAt: string) => {
    const eligibility = fiveAxisMemoryEligibilityPredicate("memory");
    return {
      sql: `memory.namespace = ? AND memory.id = ? AND ${eligibility.sql}
        AND ((? IS NOT NULL AND memory.five_axis_revision = ?)
          OR (? IS NULL AND memory.updated_at = ?))`,
      binds: [
        candidate.namespace,
        memoryId,
        ...eligibility.binds,
        revision,
        revision,
        revision,
        updatedAt
      ]
    };
  };
  const sourceGuard = endpointGuard(proposal.sourceId, proposal.sourceRevision, proposal.sourceUpdatedAt);
  const targetGuard = endpointGuard(proposal.targetId, proposal.targetRevision, proposal.targetUpdatedAt);
  if (inserted) {
    statements.push(env.DB.prepare(
      `INSERT INTO memory_relations (
         id, namespace, source_memory_id, target_memory_id, relation_type, strength, reason, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM memory_candidates
         WHERE namespace = ? AND id = ? AND status = 'pending' AND action = 'y_relation_review'
       )
       AND EXISTS (
         SELECT 1 FROM memories AS memory
         WHERE ${sourceGuard.sql}
       )
       AND EXISTS (
         SELECT 1 FROM memories AS memory
         WHERE ${targetGuard.sql}
       )`
    ).bind(
      relationId,
      candidate.namespace,
      proposal.sourceId,
      proposal.targetId,
      proposal.relationType,
      proposal.strength,
      proposal.reason,
      now,
      candidate.namespace,
      candidate.id,
      ...sourceGuard.binds,
      ...targetGuard.binds
    ));
  }
  const updateIndex = statements.length;
  statements.push(env.DB.prepare(
    `UPDATE memory_candidates
     SET payload_json = ?, status = 'approved', result_memory_id = ?,
         resolved_at = ?, updated_at = ?
     WHERE namespace = ? AND id = ? AND status = 'pending' AND action = 'y_relation_review'
       AND EXISTS (
         SELECT 1 FROM memories AS memory
         WHERE ${sourceGuard.sql}
       )
       AND EXISTS (
         SELECT 1 FROM memories AS memory
         WHERE ${targetGuard.sql}
       )
       AND EXISTS (
         SELECT 1 FROM memory_relations
         WHERE namespace = ? AND id = ? AND source_memory_id = ?
           AND target_memory_id = ? AND relation_type = ?
       )`
  ).bind(
    approvedPayload,
    relationId,
    now,
    now,
    candidate.namespace,
    candidate.id,
    ...sourceGuard.binds,
    ...targetGuard.binds,
    candidate.namespace,
    relationId,
    proposal.sourceId,
    proposal.targetId,
    proposal.relationType
  ));
  statements.push(env.DB.prepare(
    `INSERT INTO memory_events (id, namespace, event_type, memory_id, payload_json, created_at)
     SELECT ?, ?, 'y_relation_approved', ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM memory_candidates
       WHERE namespace = ? AND id = ? AND status = 'approved'
         AND result_memory_id = ? AND payload_json = ?
     )`
  ).bind(
    eventId,
    candidate.namespace,
    relationId,
    eventPayload,
    now,
    candidate.namespace,
    candidate.id,
    relationId,
    approvedPayload
  ));
  statements.push(prepareCandidateAxisRunReconciliation(
    env.DB,
    candidate.namespace,
    candidate.id,
    now
  ));
  const results = await env.DB.batch(statements);
  return (results[updateIndex]?.meta.changes ?? 0) === 1;
}

async function readApprovedResult(
  env: Env,
  namespace: string,
  candidateId: string
): Promise<RelationReviewResult | null> {
  const current = await getMemoryCandidate(env.DB, namespace, candidateId);
  if (current?.status !== "approved" || !current.result_memory_id) return null;
  const approval = payloadOf(current.payload_json).approval as Record<string, unknown> | undefined;
  return {
    axis: "Y",
    action: "approve",
    relationId: current.result_memory_id,
    changed: approval?.inserted === true
  };
}

async function legacyRevision(
  db: D1Database,
  candidate: MemoryCandidateRecord,
  memoryId: string,
  expectedUpdatedAt: string
): Promise<number | null> {
  const linked = await db.prepare(
    `SELECT memory_revision
     FROM memory_candidate_axis_runs
     WHERE namespace = ? AND candidate_external_key = ? AND axis = 'Y'
       AND memory_id = ?
     ORDER BY memory_revision DESC
     LIMIT 1`
  ).bind(
    candidate.namespace,
    candidate.external_key,
    memoryId
  ).first<{ memory_revision: number }>();
  if (linked?.memory_revision) return linked.memory_revision;

  const historical = await db.prepare(
    `SELECT memory_revision
     FROM memory_five_axis_outbox
     WHERE namespace = ? AND memory_id = ?
       AND memory_updated_at <= ? AND created_at <= ?
     ORDER BY memory_revision DESC
     LIMIT 1`
  ).bind(candidate.namespace, memoryId, expectedUpdatedAt, candidate.created_at)
    .first<{ memory_revision: number }>();
  return historical?.memory_revision ?? null;
}

async function resolveProposalRevisions(
  db: D1Database,
  candidate: MemoryCandidateRecord,
  proposal: RelationProposal
): Promise<RelationProposal> {
  const [sourceRevision, targetRevision] = await Promise.all([
    proposal.sourceRevision ?? legacyRevision(db, candidate, proposal.sourceId, proposal.sourceUpdatedAt),
    proposal.targetRevision ?? legacyRevision(db, candidate, proposal.targetId, proposal.targetUpdatedAt)
  ]);
  return { ...proposal, sourceRevision, targetRevision };
}

function endpointIsStale(
  memory: Awaited<ReturnType<typeof getMemoryById>>,
  expectedRevision: number | null,
  expectedUpdatedAt: string
): boolean {
  if (!memory || !isFiveAxisMemoryEligible(memory)) return true;
  return expectedRevision !== null
    ? (memory.five_axis_revision ?? 1) !== expectedRevision
    : memory.updated_at !== expectedUpdatedAt;
}

async function resolveApprovalFailure(
  env: Env,
  candidate: MemoryCandidateRecord,
  proposal: RelationProposal
): Promise<RelationReviewResult> {
  const approved = await readApprovedResult(env, candidate.namespace, candidate.id);
  if (approved) return approved;
  const [source, target] = await Promise.all([
    getMemoryById(env.DB, { namespace: candidate.namespace, id: proposal.sourceId }),
    getMemoryById(env.DB, { namespace: candidate.namespace, id: proposal.targetId })
  ]);
  if (endpointIsStale(source, proposal.sourceRevision, proposal.sourceUpdatedAt)
    || endpointIsStale(target, proposal.targetRevision, proposal.targetUpdatedAt)) {
    throw new Error("relation_review_candidate_is_stale");
  }
  throw new Error("relation_review_candidate_changed");
}

export async function approveRelationReviewCandidate(env: Env, form: FormData): Promise<RelationReviewResult | null> {
  const id = readFormText(form, "id");
  if (!id) return null;
  const namespace = loadDreamConfig(env).namespace;
  const candidate = await getMemoryCandidate(env.DB, namespace, id);
  if (!candidate || candidate.status !== "pending" || candidate.action !== "y_relation_review") return null;
  const proposal = proposalOf(payloadOf(candidate.payload_json));
  if (!proposal) return null;

  const resolvedProposal = await resolveProposalRevisions(env.DB, candidate, proposal);
  const [source, target] = await Promise.all([
    getMemoryById(env.DB, { namespace, id: proposal.sourceId }),
    getMemoryById(env.DB, { namespace, id: proposal.targetId })
  ]);
  if (endpointIsStale(source, resolvedProposal.sourceRevision, proposal.sourceUpdatedAt)
    || endpointIsStale(target, resolvedProposal.targetRevision, proposal.targetUpdatedAt)) {
    throw new Error("relation_review_candidate_is_stale");
  }

  let relation = await findProposalRelation(env.DB, namespace, proposal);
  let inserted = false;
  if (!relation) {
    const deterministicId = `rel_yreview_${candidate.id}`;
    try {
      const changed = await commitApproval(env, candidate, resolvedProposal, deterministicId, true);
      if (!changed) {
        return await resolveApprovalFailure(env, candidate, resolvedProposal);
      }
      return { axis: "Y", action: "approve", relationId: deterministicId, changed: true };
    } catch (error) {
      relation = await findProposalRelation(env.DB, namespace, proposal);
      if (!relation) throw error;
    }
  }

  if (!await commitApproval(env, candidate, resolvedProposal, relation.id, inserted)) {
    return await resolveApprovalFailure(env, candidate, resolvedProposal);
  }
  return { axis: "Y", action: "approve", relationId: relation.id, changed: false };
}

export async function rejectRelationReviewCandidate(env: Env, form: FormData): Promise<boolean> {
  const id = readFormText(form, "id");
  if (!id) return false;
  const namespace = loadDreamConfig(env).namespace;
  const candidate = await getMemoryCandidate(env.DB, namespace, id);
  return Boolean(candidate && candidate.status === "pending" && candidate.action === "y_relation_review"
    && await resolveMemoryCandidate(env.DB, namespace, id, "rejected"));
}

export async function rollbackRelationReviewCandidate(env: Env, form: FormData): Promise<RelationReviewResult | null> {
  const id = readFormText(form, "id");
  if (!id) return null;
  const namespace = loadDreamConfig(env).namespace;
  const candidate = await getMemoryCandidate(env.DB, namespace, id);
  if (!candidate || candidate.status !== "approved" || candidate.action !== "y_relation_review"
    || !candidate.result_memory_id) return null;
  const payload = payloadOf(candidate.payload_json);
  const proposal = proposalOf(payload);
  if (!proposal) return null;
  const approval = payload.approval && typeof payload.approval === "object" && !Array.isArray(payload.approval)
    ? payload.approval as Record<string, unknown>
    : {};
  if (approval.relation_id !== candidate.result_memory_id || typeof approval.inserted !== "boolean") {
    throw new Error("relation_review_rollback_metadata_missing");
  }
  const inserted = approval.inserted;
  if (inserted) {
    const relation = await getMemoryRelationById(env.DB, { namespace, id: candidate.result_memory_id });
    if (!relation || relation.source_memory_id !== proposal.sourceId || relation.target_memory_id !== proposal.targetId
      || relation.relation_type !== proposal.relationType) {
      throw new Error("relation_review_rollback_state_changed");
    }
  }

  const now = nowIso();
  const eventId = newId("ev");
  const rolledBackPayload = JSON.stringify({
    ...payload,
    rollback: { token: newId("rollback"), relation_id: candidate.result_memory_id }
  });
  const statements: D1PreparedStatement[] = [];
  if (inserted) {
    statements.push(env.DB.prepare(
      `DELETE FROM memory_relations
       WHERE namespace = ? AND id = ? AND source_memory_id = ? AND target_memory_id = ? AND relation_type = ?`
    ).bind(namespace, candidate.result_memory_id, proposal.sourceId, proposal.targetId, proposal.relationType));
  }
  const updateIndex = statements.length;
  statements.push(env.DB.prepare(
    `UPDATE memory_candidates SET payload_json = ?, status = 'rolled_back', resolved_at = ?, updated_at = ?
     WHERE namespace = ? AND id = ? AND status = 'approved' AND result_memory_id = ?`
  ).bind(rolledBackPayload, now, now, namespace, candidate.id, candidate.result_memory_id));
  statements.push(env.DB.prepare(
    `INSERT INTO memory_events (id, namespace, event_type, memory_id, payload_json, created_at)
     SELECT ?, ?, 'y_relation_rollback', ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM memory_candidates
       WHERE namespace = ? AND id = ? AND status = 'rolled_back'
         AND result_memory_id = ? AND payload_json = ?
     )`
  ).bind(
    eventId,
    namespace,
    candidate.result_memory_id,
    JSON.stringify({ candidate_id: candidate.id, relation_id: candidate.result_memory_id, changed: inserted }),
    now,
    namespace,
    candidate.id,
    candidate.result_memory_id,
    rolledBackPayload
  ));
  statements.push(prepareCandidateAxisRunReconciliation(
    env.DB,
    namespace,
    candidate.id,
    now
  ));
  const results = await env.DB.batch(statements);
  if ((results[updateIndex]?.meta.changes ?? 0) !== 1) {
    throw new Error("relation_review_rollback_candidate_changed");
  }
  const changed = inserted && (results[0]?.meta.changes ?? 0) === 1;
  return { axis: "Y", action: "rollback", relationId: candidate.result_memory_id, changed };
}
