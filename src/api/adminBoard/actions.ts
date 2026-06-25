import { createMemory, getMemoryById, updateMemory, type UpdateMemoryInput } from "../../db/memories";
import type { Env, MemoryRecord } from "../../types";
import { clampNumber, parseTagInput, parseTags, readFormText } from "./utils";

interface DreamReviewPayload {
  kind?: string;
  action?: "update" | "delete";
  target_id?: string;
  patch?: Record<string, unknown>;
  reason?: string;
}

export interface DreamReviewResult {
  action: "update" | "delete" | "reject";
  proposal: MemoryRecord;
  target: MemoryRecord | null;
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
    if (parsed.action !== "update" && parsed.action !== "delete") return null;
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

async function markReviewResolved(env: Env, proposal: MemoryRecord, resolution: "approved" | "rejected"): Promise<MemoryRecord | null> {
  const tags = cleanPinTags(parseTags(proposal.tags).filter((tag) => tag !== "pending-review"));
  tags.push(resolution);
  return updateMemory(env.DB, {
    namespace: "default",
    id: proposal.id,
    patch: {
      status: "superseded",
      pinned: false,
      tags: cleanPinTags(tags)
    }
  });
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

  return updateMemory(env.DB, {
    namespace: "default",
    id,
    patch: {
      type,
      content,
      tags: cleanPinTags(tags),
      importance: clampNumber(readFormText(form, "importance"), 0.65, 0, 1),
      pinned: readFormText(form, "pinned") === "on"
    }
  });
}

export async function deleteBoardMemory(env: Env, form: FormData): Promise<MemoryRecord | null> {
  const id = readFormText(form, "id");
  if (!id) return null;

  const existing = await getMemoryById(env.DB, { namespace: "default", id });
  if (!existing) return null;

  return updateMemory(env.DB, {
    namespace: "default",
    id,
    patch: {
      status: "deleted",
      pinned: false,
      tags: cleanPinTags(parseTags(existing.tags))
    }
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

  let updatedTarget: MemoryRecord | null = null;
  if (review.action === "delete") {
    updatedTarget = await updateMemory(env.DB, {
      namespace: "default",
      id: target.id,
      patch: {
        status: "deleted",
        pinned: false,
        tags: cleanPinTags(parseTags(target.tags))
      }
    });
  } else {
    const patch = reviewPatchToMemoryPatch(review.patch);
    if (Object.keys(patch).length === 0) return null;
    updatedTarget = await updateMemory(env.DB, { namespace: "default", id: target.id, patch });
  }

  const resolvedProposal = await markReviewResolved(env, proposal, "approved");
  return { action: review.action, proposal: resolvedProposal ?? proposal, target: updatedTarget };
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
