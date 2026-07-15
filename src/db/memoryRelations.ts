import type { MemoryRecord } from "../types";
import { newId } from "../utils/ids";
import { nowIso } from "../utils/time";
import { fetchMemoriesByIds } from "./memories";

const D1_BIND_LIMIT = 90;

export interface MemoryRelationRecord {
  id: string;
  namespace: string;
  source_memory_id: string;
  target_memory_id: string;
  relation_type: string;
  strength: number;
  reason: string | null;
  created_at: string;
}

export const SAFE_RELATION_TYPES = new Set([
  "same_issue",
  "same_project",
  "same_tool",
  "same_event",
  "same_topic",
  "temporal_sequence",
  "emotional_link",
  "in_thread",
  "same_person",
  "in_episode",
  "instance_of",
  "derived_from",
  "same_fact_key",
  "origin_split"
]);

export const REVIEW_RELATION_TYPES = new Set(["contradicts", "cause_effect", "supports"]);

export const PERSISTED_RELATION_TYPES = new Set([
  ...SAFE_RELATION_TYPES,
  ...REVIEW_RELATION_TYPES
]);

export const SYMMETRIC_RELATION_TYPES = new Set([
  "same_issue",
  "same_project",
  "same_tool",
  "same_event",
  "same_topic",
  "emotional_link",
  "in_thread",
  "same_person",
  "in_episode",
  "same_fact_key",
  "contradicts"
]);

const RELATION_TYPE_WEIGHTS = new Map([
  ["same_event", 1],
  ["same_topic", 0.95],
  ["same_fact_key", 0.92],
  ["origin_split", 0.9],
  ["same_project", 0.9],
  ["same_issue", 0.85],
  ["in_thread", 0.8],
  ["same_person", 0.78],
  ["in_episode", 0.78],
  ["same_tool", 0.75],
  ["instance_of", 0.72],
  ["derived_from", 0.7],
  ["temporal_sequence", 0.55],
  ["emotional_link", 0.5],
  ["supports", 0.8],
  ["cause_effect", 0.78],
  ["contradicts", 0.65]
]);

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function normalizeRelationType(value: string): string {
  const clean = value.trim();
  return clean === "contradiction" ? "contradicts" : clean;
}

export function normalizeRelationPair(
  sourceMemoryId: string,
  targetMemoryId: string,
  relationType: string
): { sourceMemoryId: string; targetMemoryId: string; relationType: string } {
  const normalizedType = normalizeRelationType(relationType);
  if (SYMMETRIC_RELATION_TYPES.has(normalizedType) && sourceMemoryId > targetMemoryId) {
    return { sourceMemoryId: targetMemoryId, targetMemoryId: sourceMemoryId, relationType: normalizedType };
  }
  return { sourceMemoryId, targetMemoryId, relationType: normalizedType };
}

export async function createMemoryRelation(
  db: D1Database,
  input: {
    namespace: string;
    sourceMemoryId: string;
    targetMemoryId: string;
    relationType: string;
    strength?: number;
    reason?: string | null;
  }
): Promise<boolean> {
  if (input.sourceMemoryId === input.targetMemoryId) return false;
  const pair = normalizeRelationPair(input.sourceMemoryId, input.targetMemoryId, input.relationType);
  if (!SAFE_RELATION_TYPES.has(pair.relationType)) return false;
  const strength = typeof input.strength === "number" && Number.isFinite(input.strength) ? clamp(input.strength, 0, 1) : 1;

  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO memory_relations (
        id, namespace, source_memory_id, target_memory_id, relation_type, strength, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(newId("rel"), input.namespace, pair.sourceMemoryId, pair.targetMemoryId, pair.relationType, strength, input.reason ?? null, nowIso())
    .run();

  return Boolean(result.meta.changes);
}

export async function getMemoryRelationById(
  db: D1Database,
  input: { namespace: string; id: string }
): Promise<MemoryRelationRecord | null> {
  return (await db.prepare("SELECT * FROM memory_relations WHERE namespace = ? AND id = ?")
    .bind(input.namespace, input.id).first<MemoryRelationRecord>()) ?? null;
}

export async function replaceTimelineSequenceRelations(
  db: D1Database,
  input: {
    namespace: string;
    groupKey: string;
    thread: string;
    factKey: string;
    edges: Array<{ sourceMemoryId: string; targetMemoryId: string }>;
  }
): Promise<{ expected: number; inserted: number }> {
  const reason = `timeline_approved:${input.groupKey}`;
  const statements = [
    db.prepare(
      `DELETE FROM memory_relations
       WHERE namespace = ? AND relation_type = 'temporal_sequence'
         AND reason = ?`
    ).bind(
      input.namespace,
      reason
    ),
    ...input.edges.map((edge) => db.prepare(
      `INSERT OR IGNORE INTO memory_relations (
         id, namespace, source_memory_id, target_memory_id, relation_type, strength, reason, created_at
       ) VALUES (?, ?, ?, ?, 'temporal_sequence', 1, ?, ?)`
    ).bind(
      newId("rel"),
      input.namespace,
      edge.sourceMemoryId,
      edge.targetMemoryId,
      reason,
      nowIso()
    ))
  ];
  const results = await db.batch(statements);
  return {
    expected: input.edges.length,
    inserted: results.slice(1).reduce((sum, result) => sum + (result.meta.changes ?? 0), 0)
  };
}

async function listRelationsForFrontier(
  db: D1Database,
  input: { namespace: string; frontier: string[] }
): Promise<MemoryRelationRecord[]> {
  const rows: MemoryRelationRecord[] = [];
  const idsPerQuery = Math.floor((D1_BIND_LIMIT - 1) / 2);
  for (const ids of chunk(input.frontier, idsPerQuery)) {
    const placeholders = ids.map(() => "?").join(", ");
    const result = await db
      .prepare(
        `SELECT id, namespace, source_memory_id, target_memory_id, relation_type, strength, reason, created_at
         FROM memory_relations
         WHERE namespace = ?
           AND (source_memory_id IN (${placeholders}) OR target_memory_id IN (${placeholders}))`
      )
      .bind(input.namespace, ...ids, ...ids)
      .all<MemoryRelationRecord>();
    rows.push(...(result.results ?? []));
  }
  return rows;
}

export async function listRelationExpandedMemories(
  db: D1Database,
  input: { namespace: string; baseIds: string[]; limit: number }
): Promise<Array<MemoryRecord & { score: number; relationScore: number }>> {
  const baseIds = [...new Set(input.baseIds.filter((id) => id && !id.startsWith("msg_")))];
  if (baseIds.length === 0) return [];

  const scores = new Map<string, number>();
  const baseSet = new Set(baseIds);
  let frontier = baseIds;

  for (const depth of [1, 2]) {
    if (frontier.length === 0) break;
    const relations = await listRelationsForFrontier(db, { namespace: input.namespace, frontier });
    const nextFrontier = new Set<string>();

    for (const relation of relations) {
      if (!PERSISTED_RELATION_TYPES.has(relation.relation_type)) continue;
      if (depth === 1 && relation.strength < 0.4) continue;
      if (depth === 2 && relation.strength < 0.7) continue;

      const sourceInFrontier = frontier.includes(relation.source_memory_id);
      const targetInFrontier = frontier.includes(relation.target_memory_id);
      const relatedId = sourceInFrontier ? relation.target_memory_id : targetInFrontier ? relation.source_memory_id : null;
      if (!relatedId || baseSet.has(relatedId)) continue;

      const depthWeight = depth === 1 ? 0.32 : 0.14;
      const typeWeight = RELATION_TYPE_WEIGHTS.get(relation.relation_type) ?? 0.5;
      const score = Math.min(0.8, clamp(relation.strength, 0, 1) * typeWeight * depthWeight);
      scores.set(relatedId, Math.max(scores.get(relatedId) ?? 0, score));
      if (depth === 1) nextFrontier.add(relatedId);
    }

    frontier = [...nextFrontier].filter((id) => !baseSet.has(id));
  }

  const ids = [...scores.keys()].slice(0, Math.max(input.limit * 3, input.limit));
  if (ids.length === 0) return [];

  return (await fetchMemoriesByIds(db, { namespace: input.namespace, ids }))
    .filter((record) => record.status === "active" && record.active_fact !== 0)
    .map((record) => {
      const relationScore = scores.get(record.id) ?? 0;
      return { ...record, score: relationScore, relationScore };
    })
    .sort((a, b) => b.score + b.importance * 0.05 - (a.score + a.importance * 0.05))
    .slice(0, input.limit);
}
