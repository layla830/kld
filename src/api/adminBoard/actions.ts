import {
  buildMemoryRecord,
  createMemory,
  getMemoryById,
  prepareMemoryInsert,
  prepareMemoryUpdate,
  type MemoryMutationGuard,
  type UpdateMemoryInput
} from "../../db/memories";
import {
  applyMemoryEligibilityPatch,
  classifyMemoryEligibilityTransition,
  prepareMemoryDeprojection,
  prepareMemoryDeprojectionCallerInvariant
} from "../../memory/deprojection";
import { patchSyncedMemory, syncMemoryVector } from "../../memory/state";
import type { Env, MemoryRecord } from "../../types";
import { clampNumber, parseTagInput, parseTags, readFormText } from "./utils";

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

function cleanPinTags(tags: string[]): string[] {
  return [...new Set(tags.filter((tag) => {
    const normalized = tag.trim().toLowerCase();
    return normalized && !["pin", "pinned", "置顶"].includes(normalized);
  }))];
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
  if (Array.isArray(raw.tags)) patch.tags = cleanPinTags(raw.tags.map((item) => String(item).trim()).filter(Boolean));
  return patch;
}

function combineGuards(...guards: MemoryMutationGuard[]): MemoryMutationGuard {
  return {
    sql: guards.map((guard) => `(${guard.sql})`).join(" AND "),
    binds: guards.flatMap((guard) => guard.binds)
  };
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

function memoryStatusGuard(namespace: string, memoryId: string, status: string): MemoryMutationGuard {
  return {
    sql: "EXISTS (SELECT 1 FROM memories WHERE namespace = ? AND id = ? AND status = ?)",
    binds: [namespace, memoryId, status]
  };
}

function memoryExistsGuard(namespace: string, memoryId: string): MemoryMutationGuard {
  return {
    sql: "EXISTS (SELECT 1 FROM memories WHERE namespace = ? AND id = ?)",
    binds: [namespace, memoryId]
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

async function markReviewResolved(env: Env, proposal: MemoryRecord, resolution: "approved" | "rejected"): Promise<MemoryRecord | null> {
  return patchSyncedMemory(env, "default", proposal.id, reviewResolutionPatch(proposal, resolution), {
    source: "dream_review",
    reason: `dream_review_${resolution}`
  });
}

async function commitDreamReviewDeprojection(
  env: Env,
  input: {
    proposal: MemoryRecord;
    target: MemoryRecord;
    patch: UpdateMemoryInput;
    reason: string;
    requireUnpinned?: boolean;
    replacement?: MemoryRecord;
  }
): Promise<{
  proposal: MemoryRecord;
  target: MemoryRecord;
  replacement: MemoryRecord | null;
} | null> {
  const prepared = await prepareMemoryDeprojection(env.DB, {
    namespace: input.target.namespace,
    memoryId: input.target.id,
    patch: input.patch,
    expectedStatus: input.target.status,
    expectedRevision: input.target.five_axis_revision ?? 1,
    requireUnpinned: input.requireUnpinned,
    source: "dream_review",
    reason: input.reason,
    operationId: `deproj_dream_review_${input.proposal.id}`,
    memory: input.target,
    guard: dreamProposalGuard(input.proposal)
  });
  const proposalUpdate = prepareMemoryUpdate(env.DB, {
    namespace: input.proposal.namespace,
    id: input.proposal.id,
    patch: reviewResolutionPatch(input.proposal, "approved"),
    expectedStatus: "active",
    expectedRevision: input.proposal.five_axis_revision ?? 1,
    guard: prepared.successGuard,
    markVectorUnsynced: true
  });
  if (!proposalUpdate) throw new Error("dream_review_resolution_statement_missing");

  const callerInvariant = combineGuards(
    memoryStatusGuard(input.proposal.namespace, input.proposal.id, "superseded"),
    ...(input.replacement
      ? [memoryExistsGuard(input.replacement.namespace, input.replacement.id)]
      : [])
  );
  await env.DB.batch([
    ...prepared.statements,
    ...(input.replacement
      ? [prepareMemoryInsert(env.DB, input.replacement, prepared.successGuard)]
      : []),
    proposalUpdate,
    prepareMemoryDeprojectionCallerInvariant(env.DB, prepared, callerInvariant)
  ]);

  const [proposal, target, replacement] = await Promise.all([
    getMemoryById(env.DB, { namespace: input.proposal.namespace, id: input.proposal.id }),
    getMemoryById(env.DB, { namespace: input.target.namespace, id: input.target.id }),
    input.replacement
      ? getMemoryById(env.DB, {
          namespace: input.replacement.namespace,
          id: input.replacement.id
        })
      : Promise.resolve(null)
  ]);
  if (!proposal || proposal.status !== "superseded" || !target
    || (input.replacement && !replacement)) return null;

  await Promise.all([
    syncMemoryVector(env, proposal),
    syncMemoryVector(env, target),
    ...(replacement ? [syncMemoryVector(env, replacement)] : [])
  ]);
  return { proposal, target, replacement };
}

export async function createBoardMemory(env: Env, form: FormData): Promise<MemoryRecord | null> {
  const kind = readFormText(form, "kind");
  const content = readFormText(form, "content");
  if (!content) return null;

  let type = "note";
  let tags = ["admin-board"];
  let pinned = false;

  if (kind === "message") {
    type = "message";
    tags = ["留言", "unread", "admin-board"];
  } else if (kind === "diary") {
    const author = readFormText(form, "author") || "layla";
    type = author === "kld" ? "diary" : "layla_diary";
    tags = ["日记", author, "admin-board"];
  } else if (kind === "quote") {
    const category = readFormText(form, "category") || "语录";
    tags = ["语录", category, "admin-board"];
  } else if (kind === "memory") {
    type = readFormText(form, "memory_type") || "note";
    tags = cleanPinTags(parseTagInput(readFormText(form, "tags")));
    tags.push("admin-board");
    pinned = readFormText(form, "pinned") === "on";
  }

  const mood = readFormText(form, "mood");
  if (mood) tags.push(`mood:${mood}`);

  return createMemory(env.DB, {
    namespace: "default",
    type,
    content,
    summary: null,
    importance: pinned ? 1 : 0.65,
    confidence: 0.95,
    status: "active",
    pinned,
    tags: cleanPinTags(tags),
    source: "admin-board",
    sourceMessageIds: [],
    expiresAt: null
  });
}

export async function editBoardMemory(env: Env, form: FormData): Promise<MemoryRecord | null> {
  const id = readFormText(form, "id");
  const content = readFormText(form, "content");
  if (!id || !content) return null;

  const type = readFormText(form, "type") || "note";
  const tags = cleanPinTags(parseTagInput(readFormText(form, "tags")));
  const mood = readFormText(form, "mood");
  if (mood) tags.push(`mood:${mood}`);
  if (type === "message" && !tags.includes("留言")) tags.push("留言");

  return patchSyncedMemory(env, "default", id, {
      type,
      content,
      tags: cleanPinTags(tags),
      importance: clampNumber(readFormText(form, "importance"), 0.65, 0, 1),
      pinned: readFormText(form, "pinned") === "on"
  }, {
    source: "admin_board",
    reason: "admin_board_edit"
  });
}

export async function deleteBoardMemory(env: Env, form: FormData): Promise<MemoryRecord | null> {
  const id = readFormText(form, "id");
  if (!id) return null;

  const existing = await getMemoryById(env.DB, { namespace: "default", id });
  if (!existing) return null;

  return patchSyncedMemory(env, "default", id, {
      status: "deleted",
      pinned: false,
      tags: cleanPinTags(parseTags(existing.tags))
  }, {
    source: "admin_board",
    reason: "admin_board_delete",
    expectedStatus: existing.status,
    expectedRevision: existing.five_axis_revision ?? 1
  });
}

export async function approveDreamReview(env: Env, form: FormData): Promise<DreamReviewResult | null> {
  const id = readFormText(form, "id");
  if (!id) return null;
  const proposal = await getMemoryById(env.DB, { namespace: "default", id });
  if (!proposal) return null;
  const review = parseDreamReview(proposal);
  if (!review) return null;

  const target = await getMemoryById(env.DB, { namespace: "default", id: review.target_id! });
  if (!target) return null;

  const action = review.action === "delete" ? "delete" : review.action === "supersede" ? "supersede" : "update";
  let updatedTarget: MemoryRecord | null = null;
  if (action === "delete") {
    const result = await commitDreamReviewDeprojection(env, {
      proposal,
      target,
      patch: {
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
      const result = await commitDreamReviewDeprojection(env, {
        proposal,
        target,
        patch,
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
    const result = await commitDreamReviewDeprojection(env, {
      proposal,
      target,
      patch: { status: "superseded", activeFact: false },
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
  return { action, proposal: resolvedProposal ?? proposal, target: updatedTarget };
}

export async function rejectDreamReview(env: Env, form: FormData): Promise<DreamReviewResult | null> {
  const id = readFormText(form, "id");
  if (!id) return null;
  const proposal = await getMemoryById(env.DB, { namespace: "default", id });
  if (!proposal) return null;
  const review = parseDreamReview(proposal);
  if (!review) return null;
  const resolvedProposal = await markReviewResolved(env, proposal, "rejected");
  return { action: "reject", proposal: resolvedProposal ?? proposal, target: null };
}
