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
  limit = 200,
  factKeys: string[] = []
): Promise<FactKeyConflictReview[]> {
  const conflicts = await listFactKeyConflicts(env.DB, { namespace, limit, factKeys });
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

export type FactConflictReview = Awaited<ReturnType<typeof listFactKeyConflictsForReview>>[number];
