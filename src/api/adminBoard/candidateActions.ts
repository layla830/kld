import { getMemoryCandidate, resolveMemoryCandidate } from "../../db/memoryCandidates";
import { createMemory, getMemoryById, softDeleteMemory, updateMemory, type UpdateMemoryInput } from "../../db/memories";
import type { Env, MemoryRecord } from "../../types";
import { readFormText } from "./utils";
import { createMemoryRelation } from "../../db/memoryRelations";
import { upsertMemoryEmbedding } from "../../memory/embedding";

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
