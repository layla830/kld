import { upsertMemoryCandidate } from "../db/memoryCandidates";
import type { Env, MemoryRecord } from "../types";
import { listFactKeyConflictsForReview } from "./fiveAxis/zFacts";

export interface FactTransitionSnapshot {
  id: string;
  type: string;
  content: string;
  fact_key: string;
  importance: number;
  confidence: number;
  pinned: boolean;
  status: string;
  active_fact: number;
  updated_at: string;
}

function snapshot(memory: MemoryRecord): FactTransitionSnapshot {
  return {
    id: memory.id,
    type: memory.type,
    content: memory.content,
    fact_key: memory.fact_key || "",
    importance: memory.importance,
    confidence: memory.confidence,
    pinned: Boolean(memory.pinned),
    status: memory.status,
    active_fact: memory.active_fact,
    updated_at: memory.updated_at
  };
}

function externalKey(factKey: string, best: MemoryRecord, weaker: MemoryRecord): string {
  return ["z-review", factKey, best.id, weaker.id]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

export async function scanFactTransitionReviewCandidates(
  env: Env,
  namespace = "default"
): Promise<{ conflicts: number; candidates: number }> {
  const reviews = await listFactKeyConflictsForReview(env, namespace, 200);
  let candidates = 0;
  for (const review of reviews) {
    if (review.reason !== "pending_supersede_review" || !review.best) continue;
    for (const weaker of review.weaker) {
      await upsertMemoryCandidate(env.DB, namespace, {
        externalKey: externalKey(review.fact_key, review.best, weaker),
        dreamDate: new Date().toISOString().slice(0, 10),
        action: "z_supersede",
        subject: "system",
        targetId: weaker.id,
        payload: {
          _kind: "fact_transition",
          fact_key: review.fact_key,
          reason: "同一事实槽存在多条 active 记忆；建议保留评分更高的一条，并让较弱版本退出召回",
          best: snapshot(review.best),
          weaker: snapshot(weaker)
        },
        sourceChunkIds: [],
        status: "pending"
      });
      candidates += 1;
    }
  }
  return { conflicts: reviews.filter((review) => review.reason === "pending_supersede_review").length, candidates };
}
