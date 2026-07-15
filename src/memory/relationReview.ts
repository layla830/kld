import { upsertMemoryCandidate } from "../db/memoryCandidates";
import { normalizeRelationPair } from "../db/memoryRelations";
import type { Env, MemoryRecord } from "../types";

export async function queueRelationReviewCandidate(
  env: Env,
  namespace: string,
  input: {
    relationType: string;
    source: MemoryRecord;
    target: MemoryRecord;
    strength: number;
    reason?: string | null;
    vectorScore?: number | null;
    projectionKey?: string;
  }
): Promise<void> {
  const pair = normalizeRelationPair(input.source.id, input.target.id, input.relationType);
  const sourceUpdatedAt = input.source.id === pair.sourceMemoryId
    ? input.source.updated_at
    : input.target.updated_at;
  const targetUpdatedAt = input.target.id === pair.targetMemoryId
    ? input.target.updated_at
    : input.source.updated_at;
  await upsertMemoryCandidate(env.DB, namespace, {
    externalKey: [
      "y-review",
      pair.relationType,
      pair.sourceMemoryId,
      pair.targetMemoryId,
      sourceUpdatedAt,
      targetUpdatedAt
    ].map(encodeURIComponent).join(":"),
    dreamDate: new Date().toISOString().slice(0, 10),
    action: "y_relation_review",
    subject: "system",
    targetId: pair.targetMemoryId,
    payload: {
      _kind: "y_relation_review",
      projection_key: input.projectionKey ?? null,
      relation_type: pair.relationType,
      source_id: pair.sourceMemoryId,
      target_id: pair.targetMemoryId,
      source_updated_at: sourceUpdatedAt,
      target_updated_at: targetUpdatedAt,
      strength: input.strength,
      reason: input.reason ?? null,
      vector_score: input.vectorScore ?? null
    },
    sourceChunkIds: [],
    sourceChunks: [],
    status: "pending"
  });
}
