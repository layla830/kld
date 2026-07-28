import {
  replacePendingOperationalCandidateFamily,
  type CandidateInput
} from "../db/memoryCandidates";
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

async function pendingFactTransitionFamilies(
  db: D1Database,
  namespace: string
): Promise<string[]> {
  const rows = await db.prepare(
    `SELECT DISTINCT json_extract(payload_json, '$.fact_key') AS fact_key
     FROM memory_candidates
     WHERE namespace = ?
       AND action = 'z_supersede'
       AND status IN ('pending', 'needs_subject_review', 'deferred_relation')
       AND json_type(payload_json, '$.fact_key') = 'text'
       AND TRIM(json_extract(payload_json, '$.fact_key')) != ''
     ORDER BY fact_key
     LIMIT 200`
  ).bind(namespace).all<{ fact_key: string }>();
  return (rows.results ?? []).map((row) => row.fact_key);
}

export async function scanFactTransitionReviewCandidates(
  env: Env,
  namespace = "default",
  options: { factKeys?: string[]; dryRun?: boolean } = {}
): Promise<{
  conflicts: number;
  candidates: number;
  superseded?: number;
  candidateExternalKeys?: string[];
}> {
  const requestedFactKeys = [...new Set(
    (options.factKeys ?? []).map((factKey) => factKey.trim()).filter(Boolean)
  )].slice(0, 80);
  const reviews = await listFactKeyConflictsForReview(
    env,
    namespace,
    200,
    requestedFactKeys.length > 0 ? requestedFactKeys : undefined
  );
  const reviewByFactKey = new Map(reviews.map((review) => [review.fact_key, review]));
  const selectedFactKeys = requestedFactKeys.length > 0
    ? requestedFactKeys
    : [...reviewByFactKey.keys(), ...await pendingFactTransitionFamilies(env.DB, namespace)];
  const familyFactKeys = [...new Set(selectedFactKeys)];
  let candidates = 0;
  let superseded = 0;
  const candidateExternalKeys: string[] = [];
  for (const factKey of familyFactKeys) {
    const review = reviewByFactKey.get(factKey);
    const best = review?.reason === "pending_supersede_review" ? review.best : null;
    const inputs: CandidateInput[] = [];
    for (const weaker of best ? review?.weaker ?? [] : []) {
      const candidateExternalKey = externalKey(factKey, best!, weaker);
      inputs.push({
        externalKey: candidateExternalKey,
        dreamDate: new Date().toISOString().slice(0, 10),
        action: "z_supersede",
        subject: "system",
        targetId: weaker.id,
        payload: {
          _kind: "fact_transition",
          fact_key: factKey,
          reason: "同一事实槽存在多条 active 记忆；建议保留评分更高的一条，并让较弱版本退出召回",
          best: snapshot(best!),
          weaker: snapshot(weaker)
        },
        sourceChunkIds: [],
        status: "pending",
        dependencies: [
          { memoryId: best!.id, role: "source" },
          { memoryId: weaker.id, role: "target" }
        ]
      });
      candidates += 1;
    }
    if (!options.dryRun) {
      const replacement = await replacePendingOperationalCandidateFamily(
        env.DB,
        namespace,
        { action: "z_supersede", factKey },
        inputs
      );
      candidateExternalKeys.push(...replacement.candidateExternalKeys);
      superseded += replacement.superseded;
    }
  }
  return {
    conflicts: reviews.filter((review) => review.reason === "pending_supersede_review").length,
    candidates,
    superseded,
    ...(candidateExternalKeys.length > 0 ? { candidateExternalKeys } : {})
  };
}
