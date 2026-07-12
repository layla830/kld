import { getMemoryCandidate, resolveMemoryCandidate } from "../../db/memoryCandidates";
import { createMemory, getMemoryById, softDeleteMemory, updateMemory, type UpdateMemoryInput } from "../../db/memories";
import type { Env, MemoryRecord } from "../../types";
import { readFormText } from "./utils";
import { createMemoryRelation } from "../../db/memoryRelations";
import { upsertMemoryEmbedding } from "../../memory/embedding";
import { assessCandidateQuality } from "../../memory/candidateQuality";

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

async function existingDiarySplitMemory(env: Env, itemKey: string): Promise<MemoryRecord | null> {
  return (await env.DB.prepare(
    "SELECT * FROM memories WHERE namespace = ? AND status = 'active' AND source = 'timeline_split' AND tags LIKE ? LIMIT 1"
  ).bind("default", `%split_item:${itemKey}%`).first<MemoryRecord>()) ?? null;
}

function updatePatch(payload: Record<string, unknown>): UpdateMemoryInput {
  return {
    content: text(payload.content), type: text(payload.type), factKey: text(payload.fact_key) ?? null,
    thread: text(payload.thread) ?? null, riskLevel: text(payload.risk_level) ?? null,
    urgencyLevel: text(payload.urgency_level) ?? null, responsePosture: text(payload.response_posture) ?? null,
    importance: number(payload.importance), confidence: number(payload.confidence), tensionScore: coordinateNumber(payload.tension_score),
    valence: coordinateNumber(payload.valence, -1), arousal: coordinateNumber(payload.arousal),
    tags: tags(payload.tags)
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
  if (!candidate || candidate.status !== "pending" || candidate.action === "relation" || candidate.action === "timeline_date") return null;
  const payload = payloadOf(candidate.payload_json);
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
      status: "active", pinned: false, tags: tags(payload.tags), source: "vps-dream-candidate", sourceMessageIds: [], expiresAt: null
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
    target = await updateMemory(env.DB, { namespace: "default", id: candidate.target_id, patch: updatePatch(payload) });
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
    await Promise.all(updated.map(memory => upsertMemoryEmbedding(env, memory)));
    target = updated[0];
  }
  if (!target) return null;
  await resolveMemoryCandidate(env.DB, "default", id, "approved", target.id);
  return target;
}
