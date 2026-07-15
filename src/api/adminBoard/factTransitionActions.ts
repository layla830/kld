import { createMemoryEvent } from "../../db/memoryEvents";
import { loadDreamConfig } from "../../config/runtime";
import { getMemoryCandidate, resolveMemoryCandidate } from "../../db/memoryCandidates";
import { getMemoryById, updateMemory } from "../../db/memories";
import { listFactKeyConflictsForReview } from "../../memory/fiveAxis/zFacts";
import { markMemorySupersededSynced, syncMemoryVector } from "../../memory/state";
import type { Env, MemoryRecord } from "../../types";
import { nowIso } from "../../utils/time";
import { readFormText } from "./utils";

interface Snapshot {
  id: string;
  content: string;
  fact_key: string;
  pinned: boolean;
  status: string;
  active_fact: number;
  updated_at: string;
}

export interface FactTransitionResult {
  axis: "Z";
  action: "supersede" | "rollback";
  memories: MemoryRecord[];
}

function candidateNamespace(env: Env, form: FormData): string {
  return readFormText(form, "namespace") || loadDreamConfig(env).namespace;
}

function payloadOf(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function snapshotOf(value: unknown): Snapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.content !== "string" || typeof item.fact_key !== "string"
    || typeof item.status !== "string" || typeof item.updated_at !== "string") return null;
  return {
    id: item.id,
    content: item.content,
    fact_key: item.fact_key,
    pinned: item.pinned === true,
    status: item.status,
    active_fact: Number(item.active_fact) || 0,
    updated_at: item.updated_at
  };
}

function matchesPendingSnapshot(memory: MemoryRecord | null, snapshot: Snapshot): memory is MemoryRecord {
  return Boolean(memory
    && memory.id === snapshot.id
    && memory.status === "active"
    && !memory.pinned
    && memory.content === snapshot.content
    && (memory.fact_key || "") === snapshot.fact_key
    && memory.updated_at === snapshot.updated_at);
}

export async function approveFactTransitionCandidate(env: Env, form: FormData): Promise<FactTransitionResult | null> {
  const id = readFormText(form, "id");
  if (!id) return null;
  const candidate = await getMemoryCandidate(env.DB, candidateNamespace(env, form), id);
  if (!candidate || candidate.status !== "pending" || candidate.action !== "z_supersede") return null;
  const payload = payloadOf(candidate.payload_json);
  const factKey = typeof payload.fact_key === "string" ? payload.fact_key : "";
  const bestSnapshot = snapshotOf(payload.best);
  const weakerSnapshot = snapshotOf(payload.weaker);
  if (!factKey || !bestSnapshot || !weakerSnapshot || factKey !== bestSnapshot.fact_key || factKey !== weakerSnapshot.fact_key) return null;

  const [best, weaker, reviews] = await Promise.all([
    getMemoryById(env.DB, { namespace: candidate.namespace, id: bestSnapshot.id }),
    getMemoryById(env.DB, { namespace: candidate.namespace, id: weakerSnapshot.id }),
    listFactKeyConflictsForReview(env, candidate.namespace, 200)
  ]);
  const currentReview = reviews.find((review) => review.fact_key === factKey && review.reason === "pending_supersede_review");
  if (!matchesPendingSnapshot(best, bestSnapshot) || !matchesPendingSnapshot(weaker, weakerSnapshot)
    || currentReview?.best?.id !== best.id || !currentReview.weaker.some((memory) => memory.id === weaker.id)) {
    throw new Error("fact_transition_candidate_is_stale");
  }

  await createMemoryEvent(env.DB, {
    namespace: candidate.namespace,
    eventType: "z_snapshot",
    memoryId: weaker.id,
    payload: { candidate_id: candidate.id, fact_key: factKey, best: bestSnapshot, weaker: weakerSnapshot }
  });
  const superseded = await markMemorySupersededSynced(env, candidate.namespace, weaker.id, {
    candidate_id: candidate.id,
    fact_key: factKey,
    best_id: best.id,
    superseded_id: weaker.id,
    action: "z_review_approve"
  });
  if (!superseded) return null;
  await resolveMemoryCandidate(env.DB, candidate.namespace, candidate.id, "approved", best.id);
  return { axis: "Z", action: "supersede", memories: [superseded] };
}

export async function rejectFactTransitionCandidate(env: Env, form: FormData): Promise<boolean> {
  const id = readFormText(form, "id");
  if (!id) return false;
  const candidate = await getMemoryCandidate(env.DB, candidateNamespace(env, form), id);
  return Boolean(candidate && candidate.action === "z_supersede" && candidate.status === "pending"
    && await resolveMemoryCandidate(env.DB, candidate.namespace, candidate.id, "rejected"));
}

export async function rollbackFactTransitionCandidate(env: Env, form: FormData): Promise<FactTransitionResult | null> {
  const id = readFormText(form, "id");
  if (!id) return null;
  const candidate = await getMemoryCandidate(env.DB, candidateNamespace(env, form), id);
  if (!candidate || candidate.status !== "approved" || candidate.action !== "z_supersede") return null;
  const payload = payloadOf(candidate.payload_json);
  const factKey = typeof payload.fact_key === "string" ? payload.fact_key : "";
  const bestSnapshot = snapshotOf(payload.best);
  const weakerSnapshot = snapshotOf(payload.weaker);
  if (!factKey || !bestSnapshot || !weakerSnapshot) return null;

  const [best, weaker] = await Promise.all([
    getMemoryById(env.DB, { namespace: candidate.namespace, id: bestSnapshot.id }),
    getMemoryById(env.DB, { namespace: candidate.namespace, id: weakerSnapshot.id })
  ]);
  if (!best || best.status !== "active" || (best.fact_key || "") !== factKey
    || !weaker || weaker.status !== "superseded" || weaker.pinned
    || weaker.content !== weakerSnapshot.content || (weaker.fact_key || "") !== factKey) {
    throw new Error("fact_transition_rollback_state_changed");
  }

  const restored = await updateMemory(env.DB, {
    namespace: candidate.namespace,
    id: weaker.id,
    patch: { status: "active", activeFact: weakerSnapshot.active_fact !== 0 },
    expectedStatus: "superseded",
    requireUnpinned: true
  });
  if (!restored) return null;
  await syncMemoryVector(env, restored);
  const updated = await env.DB.prepare(
    "UPDATE memory_candidates SET status = 'rolled_back', resolved_at = ?, updated_at = ? WHERE namespace = ? AND id = ? AND status = 'approved'"
  ).bind(nowIso(), nowIso(), candidate.namespace, candidate.id).run();
  if ((updated.meta.changes ?? 0) !== 1) throw new Error("fact_transition_rollback_candidate_changed");
  await createMemoryEvent(env.DB, {
    namespace: candidate.namespace,
    eventType: "z_rollback",
    memoryId: restored.id,
    payload: { candidate_id: candidate.id, fact_key: factKey, restored: weakerSnapshot }
  });
  return { axis: "Z", action: "rollback", memories: [restored] };
}
