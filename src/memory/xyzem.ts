import { createMemoryEvent } from "../db/memoryEvents";
import { createMemoryRelation, normalizeRelationType, REVIEW_RELATION_TYPES, SAFE_RELATION_TYPES } from "../db/memoryRelations";
import { getMemoryById, listFactKeyConflicts, listMemoriesSince } from "../db/memories";
import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, MemoryRecord, OpenAIChatRequest, OpenAIChatResponse } from "../types";
import { extractJsonObject } from "../utils/jsonHelpers";
import { searchVectorMemories } from "./vectorStore";

function dayAgoIso(): string {
  return new Date(Date.now() - 86_400_000).toISOString();
}

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

    const activeNonPinned = memories.filter((m) => m.status === "active" && !m.pinned);
    const activePinned = memories.filter((m) => m.status === "active" && m.pinned);

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
  namespace: string
): Promise<{ conflicts: number; queued: number; events: number }> {
  const reviews = await listFactKeyConflictsForReview(env, namespace, 200);
  let queued = 0;
  let events = 0;

  for (const review of reviews) {
    if (review.reason === "pending_supersede_review" && review.best) {
      await createMemoryEvent(env.DB, {
        namespace,
        eventType: "z_audit",
        payload: {
          fact_key: review.fact_key,
          memory_ids: review.memory_ids,
          count: review.count,
          action: "pending_supersede_review",
          best_id: review.best.id,
          weaker_ids: review.weaker.map((m) => m.id)
        }
      });
      queued += 1;
    } else {
      await createMemoryEvent(env.DB, {
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
    events += 1;
  }

  return { conflicts: reviews.length, queued, events };
}
export async function runMetabolismPatrol(
  env: Env,
  namespace: string
): Promise<{ suggestions: number; events: number }> {
  const suggestions: Array<Record<string, unknown>> = [];

  const duplicateFacts = await listFactKeyConflicts(env.DB, { namespace, limit: 100 });
  for (const conflict of duplicateFacts) {
    suggestions.push({
      action: "review",
      severity: "critical",
      reason: "fact_key has multiple active/review memories",
      fact_key: conflict.fact_key,
      memory_ids: conflict.ids.split(",").map((id) => id.trim()).filter(Boolean)
    });
  }

  const reviewRows = await env.DB
    .prepare(
      `SELECT id FROM memories
       WHERE namespace = ?
         AND status = 'review'
       ORDER BY updated_at DESC
       LIMIT 50`
    )
    .bind(namespace)
    .all<{ id: string }>();
  if ((reviewRows.results ?? []).length > 0) {
    suggestions.push({
      action: "review",
      severity: "warning",
      reason: "memories waiting for review",
      memory_ids: (reviewRows.results ?? []).map((row) => row.id)
    });
  }

  const staleRows = await env.DB
    .prepare(
      `SELECT id FROM memories
       WHERE namespace = ?
         AND status = 'active'
         AND pinned = 0
         AND expires_at IS NOT NULL
         AND expires_at < ?
       ORDER BY expires_at ASC
       LIMIT 50`
    )
    .bind(namespace, new Date().toISOString())
    .all<{ id: string }>();
  if ((staleRows.results ?? []).length > 0) {
    suggestions.push({
      action: "archive_or_review",
      severity: "warning",
      reason: "active memories past expires_at",
      memory_ids: (staleRows.results ?? []).map((row) => row.id)
    });
  }

  const selfLoopRows = await env.DB
    .prepare(
      `SELECT id, source_memory_id FROM memory_relations
       WHERE namespace = ? AND source_memory_id = target_memory_id
       LIMIT 50`
    )
    .bind(namespace)
    .all<{ id: string; source_memory_id: string }>();
  if ((selfLoopRows.results ?? []).length > 0) {
    suggestions.push({
      action: "delete_relation",
      severity: "critical",
      reason: "relation self-loop",
      relation_ids: (selfLoopRows.results ?? []).map((row) => row.id),
      memory_ids: [...new Set((selfLoopRows.results ?? []).map((row) => row.source_memory_id))]
    });
  }

  const orphanRows = await env.DB
    .prepare(
      `SELECT r.id AS relation_id, r.source_memory_id, r.target_memory_id
       FROM memory_relations r
       LEFT JOIN memories m1 ON m1.namespace = r.namespace AND m1.id = r.source_memory_id
       LEFT JOIN memories m2 ON m2.namespace = r.namespace AND m2.id = r.target_memory_id
       WHERE r.namespace = ?
         AND (m1.id IS NULL OR m2.id IS NULL
              OR m1.status NOT IN ('active','review')
              OR m2.status NOT IN ('active','review'))
       LIMIT 50`
    )
    .bind(namespace)
    .all<{ relation_id: string; source_memory_id: string; target_memory_id: string }>();
  if ((orphanRows.results ?? []).length > 0) {
    suggestions.push({
      action: "delete_relation_or_relink",
      severity: "warning",
      reason: "relation touches missing or non-live memory",
      relation_ids: (orphanRows.results ?? []).map((row) => row.relation_id)
    });
  }

  const symmetricDupRows = await env.DB
    .prepare(
      `SELECT a.id AS keep_id, b.id AS dup_id, a.source_memory_id, a.target_memory_id, a.relation_type
       FROM memory_relations a
       JOIN memory_relations b
         ON b.namespace = a.namespace
        AND b.relation_type = a.relation_type
        AND b.source_memory_id = a.target_memory_id
        AND b.target_memory_id = a.source_memory_id
        AND b.id > a.id
       WHERE a.namespace = ?
       LIMIT 50`
    )
    .bind(namespace)
    .all<{ keep_id: string; dup_id: string; relation_type: string }>();
  if ((symmetricDupRows.results ?? []).length > 0) {
    suggestions.push({
      action: "delete_relation",
      severity: "info",
      reason: "duplicate symmetric relation (A->B and B->A)",
      relation_ids: (symmetricDupRows.results ?? []).map((row) => row.dup_id)
    });
  }

  if (suggestions.length > 0) {
    await createMemoryEvent(env.DB, {
      namespace,
      eventType: "m_patrol",
      payload: { suggestions }
    });
    return { suggestions: suggestions.length, events: 1 };
  }

  return { suggestions: 0, events: 0 };
}

interface RelationCandidate {
  pairId: string;
  source: MemoryRecord;
  target: MemoryRecord;
  vectorScore: number;
}

interface RelationHint {
  pair_id: string;
  relation_type: string;
  strength: number;
  reason?: string;
}

const RELATION_NEIGHBOR_TOP_K = 6;
const RELATION_NEIGHBOR_MIN_SCORE = 0.5;
const RELATION_MAX_SCAN = 50;

function readRelationModel(env: Env): string | null {
  const value = env.DREAM_MODEL?.trim() || env.MEMORY_MODEL?.trim() || env.MEMORY_EXTRACT_MODEL?.trim();
  return value || null;
}

async function findRelationCandidates(
  env: Env,
  namespace: string,
  memories: MemoryRecord[]
): Promise<RelationCandidate[]> {
  if (!env.VECTORIZE || memories.length === 0) return [];
  const candidates: RelationCandidate[] = [];
  const seen = new Set<string>();

  for (const memory of memories) {
    const neighbors = await searchVectorMemories(env, {
      namespace,
      query: memory.content,
      topK: RELATION_NEIGHBOR_TOP_K
    });
    if (!neighbors) continue;
    for (const neighbor of neighbors) {
      if (neighbor.id === memory.id) continue;
      if (neighbor.score < RELATION_NEIGHBOR_MIN_SCORE) continue;
      const key = [memory.id, neighbor.id].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        pairId: `p${candidates.length}`,
        source: memory,
        target: neighbor,
        vectorScore: neighbor.score
      });
    }
  }
  return candidates;
}

function buildRelationPrompt(candidates: RelationCandidate[]): string {
  const pairs = candidates.map((candidate) => ({
    pair_id: candidate.pairId,
    a_id: candidate.source.id,
    a: candidate.source.content.slice(0, 200),
    b_id: candidate.target.id,
    b: candidate.target.content.slice(0, 200)
  }));
  return [
    "你是 kld 的记忆关系建图器。给定若干对记忆，判断每对的关系类型。",
    "只输出 JSON，不要 markdown，不要解释。",
    "",
    "可选关系类型：",
    "safe（可直接建边）：same_topic, same_event, same_project, same_issue, same_tool, same_person, in_thread, in_episode, emotional_link, instance_of, derived_from, temporal_sequence, origin_split, same_fact_key",
    "review（需人工审）：contradicts, cause_effect, supports",
    "none：关联太弱",
    "",
    "判断规则：",
    "- temporal_sequence：A 明显是 B 的前因或后续，同事件链",
    "- same_event：同一具体事件的两条记录",
    "- same_topic：同主题但不同事件",
    "- same_person：都涉及同一个人",
    "- emotional_link：主题不同但情绪相同",
    "- contradicts：同一事实槽的不同说法",
    "- derived_from：B 是从 A 提炼而来",
    "- 不确定就用 none",
    "",
    "strength 是关联强度（0-1），不是文本相似度；关联越强越高。",
    "",
    "输出 JSON：",
    JSON.stringify({
      hints: [
        { pair_id: "p0", relation_type: "same_topic", strength: 0.6, reason: "都是关于项目部署" }
      ]
    }),
    "",
    "候选对：",
    JSON.stringify(pairs)
  ].join("\n");
}

async function proposeRelationsViaLlm(
  env: Env,
  candidates: RelationCandidate[]
): Promise<{ hints: RelationHint[]; error?: string }> {
  if (candidates.length === 0) return { hints: [] };
  const model = readRelationModel(env);
  if (!model) return { hints: [], error: "missing_model" };

  const request: OpenAIChatRequest = {
    model,
    messages: [
      { role: "system", content: "你是严格的 JSON 生成器。只输出 JSON。" },
      { role: "user", content: buildRelationPrompt(candidates) }
    ],
    temperature: 0,
    max_tokens: 1200,
    response_format: { type: "json_object" },
    stream: false
  };

  try {
    const response = await callOpenAICompat(env, request);
    if (!response.ok) return { hints: [], error: `model_status_${response.status}` };
    const parsed = (await response.json()) as OpenAIChatResponse;
    const message = parsed.choices?.[0]?.message as ({ content?: unknown }) | undefined;
    const content = typeof message?.content === "string" ? message.content.trim() : "";
    const json = extractJsonObject(content);
    if (!json) return { hints: [], error: "invalid_json" };
    const rawHints = (json as { hints?: unknown }).hints;
    if (!Array.isArray(rawHints)) return { hints: [], error: "no_hints_array" };
    const hints: RelationHint[] = [];
    for (const item of rawHints) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const pairId = typeof record.pair_id === "string" ? record.pair_id : null;
      const relationType = typeof record.relation_type === "string" ? record.relation_type.trim() : null;
      if (!pairId || !relationType) continue;
      hints.push({
        pair_id: pairId,
        relation_type: relationType,
        strength: typeof record.strength === "number" ? Math.min(Math.max(record.strength, 0), 1) : 0.6,
        reason: typeof record.reason === "string" ? record.reason : undefined
      });
    }
    return { hints };
  } catch (error) {
    return { hints: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runRelationBuild(
  env: Env,
  namespace: string,
  options: { sinceIso?: string; dryRun?: boolean } = {}
): Promise<{ scanned: number; inserted: number; review: number; proposed: number; candidates: number; error?: string }> {
  const dryRun = options.dryRun ?? true;
  const memories = await listMemoriesSince(env.DB, {
    namespace,
    since: options.sinceIso ?? dayAgoIso(),
    limit: RELATION_MAX_SCAN
  });
  let inserted = 0;
  let review = 0;
  let proposed = 0;

  const candidates = await findRelationCandidates(env, namespace, memories);
  const candidateMap = new Map(candidates.map((candidate) => [candidate.pairId, candidate]));
  const { hints, error } = await proposeRelationsViaLlm(env, candidates);

  for (const hint of hints) {
    const candidate = candidateMap.get(hint.pair_id);
    if (!candidate) continue;
    const relationType = normalizeRelationType(hint.relation_type);
    if (relationType === "none") continue;

    if (SAFE_RELATION_TYPES.has(relationType)) {
      if (dryRun) {
        proposed += 1;
      } else if (await createMemoryRelation(env.DB, {
        namespace,
        sourceMemoryId: candidate.source.id,
        targetMemoryId: candidate.target.id,
        relationType,
        strength: hint.strength,
        reason: hint.reason ?? null
      })) {
        inserted += 1;
      }
    } else if (REVIEW_RELATION_TYPES.has(relationType)) {
      await createMemoryEvent(env.DB, {
        namespace,
        eventType: "y_relation_review",
        payload: {
          relation_type: relationType,
          source_id: candidate.source.id,
          target_id: candidate.target.id,
          strength: hint.strength,
          reason: hint.reason ?? null
        }
      });
      review += 1;
    }
  }

  const factGroups = new Map<string, string[]>();
  for (const memory of memories) {
    if (!memory.fact_key) continue;
    factGroups.set(memory.fact_key, [...(factGroups.get(memory.fact_key) ?? []), memory.id]);
  }
  for (const [factKey, ids] of factGroups.entries()) {
    if (ids.length <= 1) continue;
    await createMemoryEvent(env.DB, {
      namespace,
      eventType: "y_relation_review",
      payload: {
        relation_type: "contradicts",
        fact_key: factKey,
        memory_ids: ids,
        reason: "multiple new memories share fact_key; needs human or Z-axis review"
      }
    });
    review += 1;
  }

  if (dryRun && proposed > 0) {
    await createMemoryEvent(env.DB, {
      namespace,
      eventType: "y_relation_proposed",
      payload: { proposed, candidates: candidates.length, scanned: memories.length, note: "dry-run; no edges written" }
    });
  }

  return { scanned: memories.length, inserted, review, proposed, candidates: candidates.length, error };
}

export async function runXyzemNightlyMaintenance(
  env: Env,
  namespace: string,
  options: { dryRun?: boolean } = {}
): Promise<{ zAudit: Awaited<ReturnType<typeof runZAudit>>; patrol: Awaited<ReturnType<typeof runMetabolismPatrol>>; relations: Awaited<ReturnType<typeof runRelationBuild>> }> {
  const zAudit = await runZAudit(env, namespace);
  const patrol = await runMetabolismPatrol(env, namespace);
  const relations = await runRelationBuild(env, namespace, { dryRun: options.dryRun });
  return { zAudit, patrol, relations };
}
