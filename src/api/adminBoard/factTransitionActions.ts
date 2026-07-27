import { createMemoryEvent, prepareMemoryEventInsert } from "../../db/memoryEvents";
import { loadDreamConfig } from "../../config/runtime";
import {
  commitMemoryCandidateApproval,
  getMemoryCandidate,
  resolveMemoryCandidate,
  rollbackMemoryCandidate
} from "../../db/memoryCandidates";
import { getMemoryById, updateMemory } from "../../db/memories";
import { listFactKeyConflictsForReview } from "../../memory/fiveAxis/zFacts";
import {
  finishPreparedMemoryDeprojection,
  prepareMemoryDeprojection
} from "../../memory/deprojection";
import { reconcileMemoryVector } from "../../memory/state";
import type { Env, MemoryRecord } from "../../types";
import { payloadOf, readFormText } from "./utils";
import {
  combineMutationGuards,
  memoryCandidateStatusGuard,
  memoryEventsExistGuard
} from "../../db/mutationGuards";

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

  const deprojection = await prepareMemoryDeprojection(env.DB, {
    namespace: candidate.namespace,
    memoryId: weaker.id,
    patch: { status: "superseded" },
    expectedStatus: "active",
    expectedRevision: weaker.five_axis_revision ?? 1,
    requireUnpinned: true,
    source: "z_review",
    reason: "z_review_supersede",
    candidateId: candidate.id,
    operationId: `deproj_${candidate.id}`,
    memory: weaker,
    guard: memoryCandidateStatusGuard(candidate.namespace, candidate.id, "pending")
  });
  const snapshotEventId = `ev_z_snapshot_${candidate.id}`;
  const conflictEventId = `ev_z_conflict_${candidate.id}`;
  const snapshotEvent = prepareMemoryEventInsert(env.DB, {
    namespace: candidate.namespace,
    eventType: "z_snapshot",
    memoryId: weaker.id,
    payload: { candidate_id: candidate.id, fact_key: factKey, best: bestSnapshot, weaker: weakerSnapshot }
  }, {
    id: snapshotEventId,
    guard: deprojection.successGuard
  });
  const conflictEvent = prepareMemoryEventInsert(env.DB, {
    namespace: candidate.namespace,
    eventType: "z_conflict",
    memoryId: weaker.id,
    payload: {
      candidate_id: candidate.id,
      fact_key: factKey,
      best_id: best.id,
      superseded_id: weaker.id,
      action: "z_review_approve"
    }
  }, {
    id: conflictEventId,
    guard: deprojection.successGuard
  });
  const committed = await commitMemoryCandidateApproval(env.DB, {
    namespace: candidate.namespace,
    id: candidate.id,
    expectedStatus: "pending",
    resultMemoryId: best.id,
    businessStatements: [...deprojection.statements, snapshotEvent, conflictEvent],
    successGuard: combineMutationGuards(
      deprojection.successGuard,
      memoryEventsExistGuard(candidate.namespace, [snapshotEventId, conflictEventId])
    )
  });
  if (!committed) return null;
  const superseded = await getMemoryById(env.DB, {
    namespace: candidate.namespace,
    id: weaker.id
  });
  if (!superseded) throw new Error("fact_transition_deprojection_target_missing");
  await finishPreparedMemoryDeprojection(env, deprojection);
  await reconcileMemoryVector(env, {
    namespace: superseded.namespace,
    memoryId: superseded.id
  });
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
  await reconcileMemoryVector(env, {
    namespace: restored.namespace,
    memoryId: restored.id
  });
  if (!await rollbackMemoryCandidate(env.DB, candidate.namespace, candidate.id)) {
    throw new Error("fact_transition_rollback_candidate_changed");
  }
  await createMemoryEvent(env.DB, {
    namespace: candidate.namespace,
    eventType: "z_rollback",
    memoryId: restored.id,
    payload: { candidate_id: candidate.id, fact_key: factKey, restored: weakerSnapshot }
  });
  return { axis: "Z", action: "rollback", memories: [restored] };
}
