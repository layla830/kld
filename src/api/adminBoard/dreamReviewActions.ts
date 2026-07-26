import {
  buildMemoryRecord,
  getMemoryById,
  prepareMemoryInsert,
  prepareMemoryUpdate,
  type MemoryMutationGuard,
  type UpdateMemoryInput
} from "../../db/memories";
import {
  combineMutationGuards,
  memoryExistsGuard,
  memoryStatusGuard
} from "../../db/mutationGuards";
import {
  applyMemoryEligibilityPatch,
  classifyMemoryEligibilityTransition,
  prepareMemoryDeprojection,
  prepareMemoryDeprojectionCallerInvariant
} from "../../memory/deprojection";
import { patchSyncedMemory, reconcileMemoryVector } from "../../memory/state";
import type { Env, MemoryRecord } from "../../types";
import { cleanPinTags, parseTags, readFormText } from "./utils";

interface DreamReviewPayload {
  kind?: string;
  action?: "update" | "delete" | "supersede";
  target_id?: string;
  patch?: Record<string, unknown>;
  replacement?: Record<string, unknown>;
  reason?: string;
}

export interface DreamReviewResult {
  action: "update" | "delete" | "supersede" | "reject";
  proposal: MemoryRecord;
  target: MemoryRecord | null;
  previousTarget?: MemoryRecord | null;
}

interface DreamReviewApprovalPlan {
  proposal: MemoryRecord;
  target: MemoryRecord;
  targetPatch: UpdateMemoryInput;
  reason: string;
  requireUnpinned?: boolean;
  replacement?: MemoryRecord;
}

function parseDreamReview(record: MemoryRecord): DreamReviewPayload | null {
  if (record.type !== "dream_review" || record.status !== "active" || !record.summary) return null;
  try {
    const parsed = JSON.parse(record.summary) as DreamReviewPayload;
    if (parsed.kind !== "dream_review") return null;
    if (parsed.action !== "update" && parsed.action !== "delete" && parsed.action !== "supersede") return null;
    if (!parsed.target_id) return null;
    return parsed;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nullableStringValue(value: unknown): string | null | undefined {
  return typeof value === "string" ? value.trim() || null : undefined;
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : undefined;
}

function reviewPatchToMemoryPatch(raw: Record<string, unknown> | undefined): UpdateMemoryInput {
  const patch: UpdateMemoryInput = {};
  if (!raw) return patch;

  const content = stringValue(raw.content);
  if (content) patch.content = content;
  const type = stringValue(raw.type);
  if (type) patch.type = type;
  const summary = nullableStringValue(raw.summary);
  if (summary !== undefined) patch.summary = summary;
  const factKey = nullableStringValue(raw.fact_key ?? raw.factKey);
  if (factKey !== undefined) patch.factKey = factKey;
  const thread = nullableStringValue(raw.thread);
  if (thread !== undefined) patch.thread = thread;
  const riskLevel = nullableStringValue(raw.risk_level ?? raw.riskLevel);
  if (riskLevel !== undefined) patch.riskLevel = riskLevel;
  const urgencyLevel = nullableStringValue(raw.urgency_level ?? raw.urgencyLevel);
  if (urgencyLevel !== undefined) patch.urgencyLevel = urgencyLevel;
  const responsePosture = nullableStringValue(raw.response_posture ?? raw.responsePosture);
  if (responsePosture !== undefined) patch.responsePosture = responsePosture;
  const auditState = nullableStringValue(raw.audit_state ?? raw.auditState);
  if (auditState !== undefined) patch.auditState = auditState;
  const importance = numberValue(raw.importance);
  if (importance !== undefined) patch.importance = importance;
  const confidence = numberValue(raw.confidence);
  if (confidence !== undefined) patch.confidence = confidence;
  const tensionScore = numberValue(raw.tension_score ?? raw.tensionScore);
  if (tensionScore !== undefined) patch.tensionScore = tensionScore;
  if (Array.isArray(raw.tags)) {
    patch.tags = cleanPinTags(raw.tags.map((item) => String(item).trim()).filter(Boolean));
  }
  return patch;
}

function dreamProposalGuard(proposal: MemoryRecord): MemoryMutationGuard {
  return {
    sql: `EXISTS (
      SELECT 1 FROM memories
      WHERE namespace = ? AND id = ? AND type = 'dream_review'
        AND status = 'active' AND summary = ? AND five_axis_revision = ?
    )`,
    binds: [
      proposal.namespace,
      proposal.id,
      proposal.summary,
      proposal.five_axis_revision ?? 1
    ]
  };
}

function reviewResolutionPatch(
  proposal: MemoryRecord,
  resolution: "approved" | "rejected"
): UpdateMemoryInput {
  const tags = cleanPinTags(parseTags(proposal.tags).filter((tag) => tag !== "pending-review"));
  tags.push(resolution);
  return {
    status: "superseded",
    pinned: false,
    tags: cleanPinTags(tags)
  };
}

async function markReviewResolved(
  env: Env,
  proposal: MemoryRecord,
  resolution: "approved" | "rejected"
): Promise<MemoryRecord | null> {
  return patchSyncedMemory(
    env,
    "default",
    proposal.id,
    reviewResolutionPatch(proposal, resolution),
    {
      source: "dream_review",
      reason: `dream_review_${resolution}`
    }
  );
}

async function commitDreamReviewApproval(
  env: Env,
  plan: DreamReviewApprovalPlan
): Promise<{
  proposal: MemoryRecord;
  target: MemoryRecord;
  replacement: MemoryRecord | null;
} | null> {
  const prepared = await prepareMemoryDeprojection(env.DB, {
    namespace: plan.target.namespace,
    memoryId: plan.target.id,
    patch: plan.targetPatch,
    expectedStatus: plan.target.status,
    expectedRevision: plan.target.five_axis_revision ?? 1,
    requireUnpinned: plan.requireUnpinned,
    source: "dream_review",
    reason: plan.reason,
    operationId: `deproj_dream_review_${plan.proposal.id}`,
    memory: plan.target,
    guard: dreamProposalGuard(plan.proposal)
  });
  const proposalUpdate = prepareMemoryUpdate(env.DB, {
    namespace: plan.proposal.namespace,
    id: plan.proposal.id,
    patch: reviewResolutionPatch(plan.proposal, "approved"),
    expectedStatus: "active",
    expectedRevision: plan.proposal.five_axis_revision ?? 1,
    guard: prepared.successGuard,
    markVectorUnsynced: true
  });
  if (!proposalUpdate) throw new Error("dream_review_resolution_statement_missing");

  const callerInvariant = combineMutationGuards(
    memoryStatusGuard(plan.proposal.namespace, plan.proposal.id, "superseded"),
    ...(plan.replacement
      ? [memoryExistsGuard(plan.replacement.namespace, plan.replacement.id)]
      : [])
  );
  await env.DB.batch([
    ...prepared.statements,
    ...(plan.replacement
      ? [prepareMemoryInsert(env.DB, plan.replacement, prepared.successGuard)]
      : []),
    proposalUpdate,
    prepareMemoryDeprojectionCallerInvariant(env.DB, prepared, callerInvariant)
  ]);

  const [proposal, target, replacement] = await Promise.all([
    getMemoryById(env.DB, {
      namespace: plan.proposal.namespace,
      id: plan.proposal.id
    }),
    getMemoryById(env.DB, {
      namespace: plan.target.namespace,
      id: plan.target.id
    }),
    plan.replacement
      ? getMemoryById(env.DB, {
          namespace: plan.replacement.namespace,
          id: plan.replacement.id
        })
      : Promise.resolve(null)
  ]);
  if (!proposal || proposal.status !== "superseded" || !target
    || (plan.replacement && !replacement)) return null;

  await Promise.all([
    reconcileMemoryVector(env, { namespace: proposal.namespace, memoryId: proposal.id }),
    reconcileMemoryVector(env, { namespace: target.namespace, memoryId: target.id }),
    ...(replacement
      ? [reconcileMemoryVector(env, {
          namespace: replacement.namespace,
          memoryId: replacement.id
        })]
      : [])
  ]);
  return { proposal, target, replacement };
}

export async function approveDreamReview(
  env: Env,
  form: FormData
): Promise<DreamReviewResult | null> {
  const id = readFormText(form, "id");
  if (!id) return null;
  const proposal = await getMemoryById(env.DB, { namespace: "default", id });
  if (!proposal) return null;
  const review = parseDreamReview(proposal);
  if (!review) return null;

  const target = await getMemoryById(env.DB, {
    namespace: "default",
    id: review.target_id!
  });
  if (!target) return null;

  const action = review.action === "delete"
    ? "delete"
    : review.action === "supersede"
      ? "supersede"
      : "update";
  let updatedTarget: MemoryRecord | null = null;
  if (action === "delete") {
    const result = await commitDreamReviewApproval(env, {
      proposal,
      target,
      targetPatch: {
        status: "deleted",
        pinned: false,
        tags: cleanPinTags(parseTags(target.tags))
      },
      reason: "dream_review_delete"
    });
    if (!result) return null;
    return {
      action,
      proposal: result.proposal,
      target: result.target
    };
  } else if (action === "update") {
    const patch = reviewPatchToMemoryPatch(review.patch);
    if (Object.keys(patch).length === 0) return null;
    const transition = classifyMemoryEligibilityTransition(
      target,
      applyMemoryEligibilityPatch(target, patch)
    );
    if (transition === "eligible_to_ineligible") {
      const result = await commitDreamReviewApproval(env, {
        proposal,
        target,
        targetPatch: patch,
        reason: "dream_review_update"
      });
      if (!result) return null;
      return {
        action,
        proposal: result.proposal,
        target: result.target
      };
    }
    updatedTarget = await patchSyncedMemory(env, "default", target.id, patch, {
      source: "dream_review",
      reason: "dream_review_update",
      expectedStatus: target.status,
      expectedRevision: target.five_axis_revision ?? 1
    });
  } else {
    if (target.status !== "active" || target.pinned) return null;
    const replacement = review.replacement;
    const content = stringValue(replacement?.content);
    if (!content) return null;
    const replacementTags = Array.isArray(replacement?.tags)
      ? cleanPinTags(replacement.tags.map((item) => String(item).trim()).filter(Boolean))
      : [];
    const replacementRecord = buildMemoryRecord({
      namespace: "default",
      type: stringValue(replacement?.type) ?? target.type,
      content,
      summary: nullableStringValue(replacement?.summary) ?? null,
      importance: numberValue(replacement?.importance) ?? target.importance,
      confidence: numberValue(replacement?.confidence) ?? target.confidence,
      status: "active",
      pinned: false,
      tags: replacementTags,
      source: stringValue(replacement?.source) ?? "merge-review-approved",
      sourceMessageIds: Array.isArray(replacement?.source_message_ids)
        ? replacement.source_message_ids.map(String).map((item) => item.trim()).filter(Boolean)
        : [],
      factKey: nullableStringValue(replacement?.fact_key),
      expiresAt: null
    });
    const result = await commitDreamReviewApproval(env, {
      proposal,
      target,
      targetPatch: { status: "superseded", activeFact: false },
      reason: "dream_review_supersede",
      requireUnpinned: true,
      replacement: replacementRecord
    });
    if (!result?.replacement) return null;
    return {
      action,
      proposal: result.proposal,
      target: result.replacement,
      previousTarget: result.target
    };
  }

  if (!updatedTarget) return null;
  const resolvedProposal = await markReviewResolved(env, proposal, "approved");
  return {
    action,
    proposal: resolvedProposal ?? proposal,
    target: updatedTarget
  };
}

export async function rejectDreamReview(
  env: Env,
  form: FormData
): Promise<DreamReviewResult | null> {
  const id = readFormText(form, "id");
  if (!id) return null;
  const proposal = await getMemoryById(env.DB, { namespace: "default", id });
  if (!proposal) return null;
  const review = parseDreamReview(proposal);
  if (!review) return null;
  const resolvedProposal = await markReviewResolved(env, proposal, "rejected");
  return {
    action: "reject",
    proposal: resolvedProposal ?? proposal,
    target: null
  };
}
