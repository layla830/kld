import { loadDreamConfig } from "../../config/runtime";
import { createMemoryEvent } from "../../db/memoryEvents";
import { getMemoryCandidate, resolveMemoryCandidate } from "../../db/memoryCandidates";
import {
  createReviewedMemoryRelation,
  deleteMemoryRelation,
  getMemoryRelationById,
  normalizeRelationPair,
  REVIEW_RELATION_TYPES
} from "../../db/memoryRelations";
import { getMemoryById } from "../../db/memories";
import type { Env } from "../../types";
import { nowIso } from "../../utils/time";
import { readFormText } from "./utils";

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
  strength: number;
  reason: string | null;
}

function payloadOf(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
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
    strength: typeof payload.strength === "number" && Number.isFinite(payload.strength)
      ? Math.min(Math.max(payload.strength, 0), 1)
      : 0.6,
    reason: typeof payload.reason === "string" ? payload.reason : null
  };
}

export async function approveRelationReviewCandidate(env: Env, form: FormData): Promise<RelationReviewResult | null> {
  const id = readFormText(form, "id");
  if (!id) return null;
  const namespace = loadDreamConfig(env).namespace;
  const candidate = await getMemoryCandidate(env.DB, namespace, id);
  if (!candidate || candidate.status !== "pending" || candidate.action !== "y_relation_review") return null;
  const candidatePayload = payloadOf(candidate.payload_json);
  const proposal = proposalOf(candidatePayload);
  if (!proposal) return null;

  const [source, target] = await Promise.all([
    getMemoryById(env.DB, { namespace, id: proposal.sourceId }),
    getMemoryById(env.DB, { namespace, id: proposal.targetId })
  ]);
  if (!source || source.status !== "active" || source.updated_at !== proposal.sourceUpdatedAt
    || !target || target.status !== "active" || target.updated_at !== proposal.targetUpdatedAt) {
    throw new Error("relation_review_candidate_is_stale");
  }

  const storedApproval = candidatePayload.approval && typeof candidatePayload.approval === "object"
    && !Array.isArray(candidatePayload.approval)
    ? candidatePayload.approval as Record<string, unknown>
    : null;
  let created: NonNullable<Awaited<ReturnType<typeof createReviewedMemoryRelation>>>;
  if (storedApproval && typeof storedApproval.relation_id === "string"
    && typeof storedApproval.inserted === "boolean") {
    const relation = await getMemoryRelationById(env.DB, { namespace, id: storedApproval.relation_id });
    if (!relation || relation.source_memory_id !== proposal.sourceId || relation.target_memory_id !== proposal.targetId
      || relation.relation_type !== proposal.relationType) {
      throw new Error("relation_review_approval_resume_state_changed");
    }
    created = { relation, inserted: storedApproval.inserted };
  } else {
    const proposed = await createReviewedMemoryRelation(env.DB, {
      namespace,
      sourceMemoryId: proposal.sourceId,
      targetMemoryId: proposal.targetId,
      relationType: proposal.relationType,
      strength: proposal.strength,
      reason: proposal.reason
    });
    if (!proposed) return null;
    created = proposed;
    const approvedPayload = {
      ...candidatePayload,
      approval: {
        relation_id: created.relation.id,
        inserted: created.inserted
      }
    };
    const payloadUpdated = await env.DB.prepare(
      `UPDATE memory_candidates SET payload_json = ?, updated_at = ?
       WHERE namespace = ? AND id = ? AND status = 'pending'`
    ).bind(JSON.stringify(approvedPayload), nowIso(), namespace, candidate.id).run();
    if ((payloadUpdated.meta.changes ?? 0) !== 1) {
      if (created.inserted) await deleteMemoryRelation(env.DB, { namespace, id: created.relation.id });
      throw new Error("relation_review_candidate_changed");
    }
  }
  const resolved = await resolveMemoryCandidate(env.DB, namespace, candidate.id, "approved", created.relation.id);
  if (!resolved) {
    if (created.inserted) await deleteMemoryRelation(env.DB, { namespace, id: created.relation.id });
    throw new Error("relation_review_candidate_changed");
  }
  await createMemoryEvent(env.DB, {
    namespace,
    eventType: "y_relation_approved",
    memoryId: created.relation.id,
    payload: {
      candidate_id: candidate.id,
      relation_id: created.relation.id,
      inserted: created.inserted,
      proposal
    }
  });
  return { axis: "Y", action: "approve", relationId: created.relation.id, changed: created.inserted };
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
  const proposal = proposalOf(payloadOf(candidate.payload_json));
  if (!proposal) return null;

  const payload = payloadOf(candidate.payload_json);
  const approval = payload.approval && typeof payload.approval === "object" && !Array.isArray(payload.approval)
    ? payload.approval as Record<string, unknown>
    : {};
  if (approval.relation_id !== candidate.result_memory_id || typeof approval.inserted !== "boolean") {
    throw new Error("relation_review_rollback_metadata_missing");
  }
  const inserted = approval.inserted;
  let changed = false;

  if (inserted) {
    const relation = await getMemoryRelationById(env.DB, { namespace, id: candidate.result_memory_id });
    if (!relation || relation.source_memory_id !== proposal.sourceId || relation.target_memory_id !== proposal.targetId
      || relation.relation_type !== proposal.relationType) {
      throw new Error("relation_review_rollback_state_changed");
    }
    changed = await deleteMemoryRelation(env.DB, { namespace, id: relation.id });
    if (!changed) throw new Error("relation_review_rollback_delete_failed");
  }

  const now = nowIso();
  const updated = await env.DB.prepare(
    `UPDATE memory_candidates SET status = 'rolled_back', resolved_at = ?, updated_at = ?
     WHERE namespace = ? AND id = ? AND status = 'approved'`
  ).bind(now, now, namespace, candidate.id).run();
  if ((updated.meta.changes ?? 0) !== 1) throw new Error("relation_review_rollback_candidate_changed");
  await createMemoryEvent(env.DB, {
    namespace,
    eventType: "y_relation_rollback",
    memoryId: candidate.result_memory_id,
    payload: { candidate_id: candidate.id, relation_id: candidate.result_memory_id, changed }
  });
  return { axis: "Y", action: "rollback", relationId: candidate.result_memory_id, changed };
}
