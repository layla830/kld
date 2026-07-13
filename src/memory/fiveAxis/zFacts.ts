import { createMemoryEvent } from "../../db/memoryEvents";
import { getMemoryById, listFactKeyConflicts } from "../../db/memories";
import type { Env, MemoryRecord } from "../../types";

export interface FactKeyConflictReview {
  fact_key: string;
  memory_ids: string[];
  count: number;
  best: MemoryRecord | null;
  weaker: MemoryRecord[];
  reason: "pinned_memory_present" | "single_active" | "pending_supersede_review";
}

export async function listFactKeyConflictsForReview(
  env: Env,
  namespace: string,
  limit = 200
): Promise<FactKeyConflictReview[]> {
  const conflicts = await listFactKeyConflicts(env.DB, { namespace, limit });
  const reviews: FactKeyConflictReview[] = [];

  for (const conflict of conflicts) {
    const ids = conflict.ids.split(",").map((id) => id.trim()).filter(Boolean);
    const memories: MemoryRecord[] = [];
    for (const id of ids) {
      const memory = await getMemoryById(env.DB, { namespace, id });
      if (memory) memories.push(memory);
    }

    const activeNonPinned = memories.filter((memory) => memory.status === "active" && !memory.pinned);
    const activePinned = memories.filter((memory) => memory.status === "active" && memory.pinned);

    if (activePinned.length > 0 || activeNonPinned.length <= 1) {
      reviews.push({
        fact_key: conflict.fact_key,
        memory_ids: ids,
        count: conflict.count,
        best: null,
        weaker: [],
        reason: activePinned.length > 0 ? "pinned_memory_present" : "single_active"
      });
      continue;
    }

    const ranked = [...activeNonPinned].sort((a, b) => {
      if (a.importance !== b.importance) return b.importance - a.importance;
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      return b.updated_at.localeCompare(a.updated_at);
    });

    reviews.push({
      fact_key: conflict.fact_key,
      memory_ids: ids,
      count: conflict.count,
      best: ranked[0],
      weaker: ranked.slice(1),
      reason: "pending_supersede_review"
    });
  }

  return reviews;
}

export async function runZAudit(
  env: Env,
  namespace: string,
  options: { dryRun?: boolean } = {}
): Promise<{ conflicts: number; queued: number; events: number }> {
  const dryRun = options.dryRun ?? false;
  const reviews = await listFactKeyConflictsForReview(env, namespace, 200);
  let queued = 0;
  let events = 0;

  for (const review of reviews) {
    if (review.reason === "pending_supersede_review" && review.best) {
      if (!dryRun) await createMemoryEvent(env.DB, {
        namespace,
        eventType: "z_audit",
        payload: {
          fact_key: review.fact_key,
          memory_ids: review.memory_ids,
          count: review.count,
          action: "pending_supersede_review",
          best_id: review.best.id,
          weaker_ids: review.weaker.map((memory) => memory.id)
        }
      });
      queued += 1;
    } else {
      if (!dryRun) await createMemoryEvent(env.DB, {
        namespace,
        eventType: "z_audit",
        payload: {
          fact_key: review.fact_key,
          memory_ids: review.memory_ids,
          count: review.count,
          action: "no_change",
          reason: review.reason
        }
      });
    }
    if (!dryRun) events += 1;
  }

  return { conflicts: reviews.length, queued, events };
}
