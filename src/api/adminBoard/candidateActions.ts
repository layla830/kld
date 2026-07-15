import { getMemoryCandidate, resolveMemoryCandidate, updateMemoryCandidateEvidence } from "../../db/memoryCandidates";
import { createMemory, getMemoryById, softDeleteMemory, updateMemory, type UpdateMemoryInput } from "../../db/memories";
import type { Env, MemoryRecord } from "../../types";
import { readFormText } from "./utils";
import { createMemoryRelation } from "../../db/memoryRelations";
import { syncMemoryVector } from "../../memory/state";
import { assessCandidateQuality } from "../../memory/candidateQuality";
import { canOverrideCandidateValidation } from "../../memory/candidateOverride";
import { createMemoryEvent } from "../../db/memoryEvents";

function payloadOf(text: string): Record<string, unknown> {
  try { const value = JSON.parse(text); return value && typeof value === "object" ? value : {}; } catch { return {}; }
}

function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function number(value: unknown): number | undefined { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : undefined; }
function coordinateNumber(value: unknown, min = 0): number | null | undefined {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(1, n)) : undefined;
}
function tags(value: unknown): string[] { return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : []; }

function hasOwn(payload: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key);
}

function nullableTextPatch(payload: Record<string, unknown>, key: string): string | null | undefined {
  if (!hasOwn(payload, key)) return undefined;
  return text(payload[key]) ?? null;
}

function nullableCoordinatePatch(
  payload: Record<string, unknown>,
  key: string,
  min = 0
): number | null | undefined {
  return hasOwn(payload, key) ? coordinateNumber(payload[key], min) : undefined;
}

function quotedEvidence(candidate: Awaited<ReturnType<typeof getMemoryCandidate>>): string[] {
  if (!candidate) return [];
  try {
    const chunks = JSON.parse(candidate.source_chunks_json) as unknown;
    if (!Array.isArray(chunks)) return [];
    return [...new Set(chunks.flatMap((chunk) => {
      if (!chunk || typeof chunk !== "object") return [];
      const quotes = (chunk as { important_quotes?: unknown }).important_quotes;
      return Array.isArray(quotes) ? quotes.map(String).map((quote) => quote.trim()).filter(Boolean) : [];
    }))];
  } catch {
    return [];
  }
}

export type CandidateEvidenceRepairResult = "repaired" | "not_found" | "not_verbatim" | "too_long";

export async function repairCandidateEvidence(env: Env, form: FormData): Promise<CandidateEvidenceRepairResult> {
  const id = readFormText(form, "id");
  const evidence = readFormText(form, "evidence");
  if (!id || !evidence) return "not_found";
  if (evidence.length > 80) return "too_long";
  const candidate = await getMemoryCandidate(env.DB, "default", id);
  if (!candidate || !["pending", "needs_subject_review"].includes(candidate.status)) return "not_found";
  if (!quotedEvidence(candidate).some((quote) => quote.includes(evidence))) return "not_verbatim";

  const payload = payloadOf(candidate.payload_json);
  payload.evidence = evidence;
  const remainingErrors = (candidate.validation_error || "").split(";")
    .map((error) => error.trim()).filter((error) => error && ![
      "missing_evidence", "evidence_too_long", "evidence_not_verbatim_in_source_chunks"
    ].includes(error));
  delete payload.validation_error;
  if (remainingErrors.length > 0) payload.validation_error = remainingErrors.join(";");
  const updated = await updateMemoryCandidateEvidence(
    env.DB, "default", id, payload, remainingErrors.length ? remainingErrors.join(";") : null
  );
  return updated ? "repaired" : "not_found";
}

async function existingDiarySplitMemory(env: Env, itemKey: string): Promise<MemoryRecord | null> {
  return (await env.DB.prepare(
    "SELECT * FROM memories WHERE namespace = ? AND status = 'active' AND source = 'timeline_split' AND tags LIKE ? LIMIT 1"
  ).bind("default", `%split_item:${itemKey}%`).first<MemoryRecord>()) ?? null;
}

export function candidateUpdatePatch(payload: Record<string, unknown>): UpdateMemoryInput {
  return {
    content: hasOwn(payload, "content") ? text(payload.content) : undefined,
    type: hasOwn(payload, "type") ? text(payload.type) : undefined,
    factKey: nullableTextPatch(payload, "fact_key"),
    thread: nullableTextPatch(payload, "thread"),
    riskLevel: nullableTextPatch(payload, "risk_level"),
    urgencyLevel: nullableTextPatch(payload, "urgency_level"),
    responsePosture: nullableTextPatch(payload, "response_posture"),
    importance: hasOwn(payload, "importance") ? number(payload.importance) : undefined,
    confidence: hasOwn(payload, "confidence") ? number(payload.confidence) : undefined,
    tensionScore: nullableCoordinatePatch(payload, "tension_score"),
    valence: nullableCoordinatePatch(payload, "valence", -1),
    arousal: nullableCoordinatePatch(payload, "arousal"),
    tags: hasOwn(payload, "tags") ? tags(payload.tags) : undefined
  };
}

export async function rejectCandidate(env: Env, form: FormData): Promise<boolean> {
  const id = readFormText(form, "id");
  return id ? resolveMemoryCandidate(env.DB, "default", id, "rejected") : false;
}

export interface CandidateQualityBatchResult {
  selected: number;
  processed: number;
  skipped: number;
}

const MAX_QUALITY_BATCH_SIZE = 100;

export async function batchRejectLowQualityCandidates(env: Env, form: FormData): Promise<CandidateQualityBatchResult | null> {
  const ids = [...new Set(form.getAll("ids").map(String).map((id) => id.trim()).filter(Boolean))]
    .slice(0, MAX_QUALITY_BATCH_SIZE);
  if (ids.length === 0) return null;

  let processed = 0;
  for (const id of ids) {
    const candidate = await getMemoryCandidate(env.DB, "default", id);
    if (!candidate || !["pending", "needs_subject_review"].includes(candidate.status)) continue;
    if (assessCandidateQuality(candidate).label === "pass") continue;
    if (await resolveMemoryCandidate(env.DB, "default", id, "rejected")) processed += 1;
  }
  return { selected: ids.length, processed, skipped: ids.length - processed };
}

export interface DiaryFactBatchResult {
  decision: "approve" | "reject";
  selected: number;
  processed: number;
  skipped: number;
  targets: MemoryRecord[];
}

const MAX_DIARY_FACT_BATCH_SIZE = 100;

export async function batchReviewDiaryFactCandidates(env: Env, form: FormData): Promise<DiaryFactBatchResult | null> {
  const decision = readFormText(form, "decision");
  if (decision !== "approve" && decision !== "reject") return null;
  const ids = [...new Set(form.getAll("ids").map(String).map((id) => id.trim()).filter(Boolean))]
    .slice(0, MAX_DIARY_FACT_BATCH_SIZE);
  if (ids.length === 0) return null;

  const targets: MemoryRecord[] = [];
  let processed = 0;
  for (const id of ids) {
    const candidate = await getMemoryCandidate(env.DB, "default", id);
    if (!candidate || candidate.status !== "pending" || candidate.action !== "diary_split_fact") continue;
    const itemForm = new FormData();
    itemForm.set("id", id);
    if (decision === "approve") {
      const target = await approveCandidate(env, itemForm);
      if (!target) continue;
      targets.push(target);
    } else if (!(await rejectCandidate(env, itemForm))) {
      continue;
    }
    processed += 1;
  }

  return { decision, selected: ids.length, processed, skipped: ids.length - processed, targets };
}

export async function approveCandidate(env: Env, form: FormData): Promise<MemoryRecord | null> {
  const id = readFormText(form, "id");
  if (!id) return null;
  const candidate = await getMemoryCandidate(env.DB, "default", id);
  if (!candidate || candidate.action === "relation" || candidate.action === "timeline_date") return null;
  const overrideRequested = readFormText(form, "override_validation") === "1";
  const validationOverride = overrideRequested && canOverrideCandidateValidation(candidate);
  if (candidate.status !== "pending" && !validationOverride) return null;
  const payload = payloadOf(candidate.payload_json);
  if (validationOverride) {
    await createMemoryEvent(env.DB, {
      namespace: "default",
      eventType: "memory_candidate_validation_override_requested",
      memoryId: candidate.target_id,
      payload: {
        candidate_id: candidate.id,
        action: candidate.action,
        validation_error: candidate.validation_error,
        policy: "explicit_admin_override"
      }
    });
  }
  let target: MemoryRecord | null = null;
  if (candidate.action === "add" || candidate.action === "excerpt") {
    const content = candidate.action === "excerpt"
      ? `【${candidate.dream_date} 重要原文】\n${text(payload.quote) ?? ""}${text(payload.reason) ? `\n保存原因：${text(payload.reason)}` : ""}`
      : text(payload.content) ?? "";
    if (!content.trim()) return null;
    target = await createMemory(env.DB, {
      namespace: "default", type: text(payload.type) ?? (candidate.action === "excerpt" ? "excerpt" : "note"), content,
      factKey: text(payload.fact_key) ?? null, thread: text(payload.thread) ?? null,
      riskLevel: text(payload.risk_level) ?? null, urgencyLevel: text(payload.urgency_level) ?? null,
      tensionScore: number(payload.tension_score), responsePosture: text(payload.response_posture) ?? null,
      importance: number(payload.importance) ?? 0.7, confidence: number(payload.confidence) ?? 0.82,
      status: "active", pinned: false, tags: tags(payload.tags),
      source: validationOverride ? "vps-dream-candidate-override" : "vps-dream-candidate",
      sourceMessageIds: [], expiresAt: null
    });
  } else if (candidate.action === "diary_split_fact") {
    const diaryId = text(payload.origin_diary_id);
    const evidence = text(payload.evidence);
    const itemKey = text(payload.split_item_key);
    const content = text(payload.content);
    const memoryType = text(payload.type);
    if (!diaryId || !evidence || !itemKey || !content || !memoryType || !["rule", "preference", "project_state", "lesson"].includes(memoryType)) return null;
    const diary = await getMemoryById(env.DB, { namespace: "default", id: diaryId });
    if (!diary || diary.status !== "active" || !["diary", "layla_diary"].includes(diary.type) || !diary.content.includes(evidence)) return null;
    target = await existingDiarySplitMemory(env, itemKey);
    if (!target) {
      target = await createMemory(env.DB, {
        namespace: "default",
        type: memoryType,
        content,
        summary: text(payload.summary) ?? null,
        factKey: text(payload.fact_key) ?? null,
        importance: number(payload.importance) ?? 0.7,
        confidence: number(payload.confidence) ?? 0.82,
        status: "active",
        pinned: false,
        tags: [...new Set([...tags(payload.tags), `origin:${diary.id}`, `split_item:${itemKey}`, "split_version:v2"])],
        source: "timeline_split",
        sourceMessageIds: [diary.id],
        expiresAt: null
      });
    }
  } else if (candidate.action === "update" && candidate.target_id) {
    if (!(await getMemoryById(env.DB, { namespace: "default", id: candidate.target_id }))) return null;
    target = await updateMemory(env.DB, { namespace: "default", id: candidate.target_id, patch: candidateUpdatePatch(payload) });
  } else if (candidate.action === "delete" && candidate.target_id) {
    target = await softDeleteMemory(env.DB, { namespace: "default", id: candidate.target_id });
  } else if (candidate.action === "fact_group") {
    const factKey = text(payload.fact_key);
    const ids = Array.isArray(payload.memory_ids) ? [...new Set(payload.memory_ids.map(String))].slice(0, 8) : [];
    if (!factKey || ids.length < 2) return null;
    const updated: MemoryRecord[] = [];
    for (const memoryId of ids) {
      if (!(await getMemoryById(env.DB, { namespace: "default", id: memoryId }))) return null;
      const memory = await updateMemory(env.DB, { namespace: "default", id: memoryId, patch: { factKey } });
      if (memory) updated.push(memory);
    }
    if (updated.length !== ids.length) return null;
    for (const memory of updated.slice(1)) await createMemoryRelation(env.DB, { namespace:"default", sourceMemoryId:updated[0].id, targetMemoryId:memory.id, relationType:"same_fact_key", strength:0.92, reason:"approved fact group" });
    await Promise.all(updated.map((memory) => syncMemoryVector(env, memory)));
    target = updated[0];
  }
  if (!target) return null;
  await resolveMemoryCandidate(env.DB, "default", id, "approved", target.id);
  if (validationOverride) {
    await createMemoryEvent(env.DB, {
      namespace: "default",
      eventType: "memory_candidate_validation_override_applied",
      memoryId: target.id,
      payload: {
        candidate_id: candidate.id,
        action: candidate.action,
        validation_error: candidate.validation_error,
        result_memory_id: target.id,
        policy: "explicit_admin_override"
      }
    });
  }
  return target;
}
