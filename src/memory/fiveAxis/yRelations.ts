import { createMemoryEvent } from "../../db/memoryEvents";
import { createMemoryRelation, normalizeRelationType, REVIEW_RELATION_TYPES, SAFE_RELATION_TYPES } from "../../db/memoryRelations";
import { fetchMemoriesByIds, listMemoriesSince } from "../../db/memories";
import { callOpenAICompat } from "../../proxy/openaiAdapter";
import type { Env, MemoryRecord, OpenAIChatRequest, OpenAIChatResponse } from "../../types";
import { extractJsonObject } from "../../utils/jsonHelpers";
import { searchVectorMemories } from "../vectorStore";

function dayAgoIso(): string {
  return new Date(Date.now() - 86_400_000).toISOString();
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
const RELATION_MAX_SCAN = 500;

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
  options: { sinceIso?: string; dryRun?: boolean; memoryIds?: string[]; projectionKey?: string } = {}
): Promise<{ scanned: number; inserted: number; review: number; proposed: number; candidates: number; error?: string }> {
  const dryRun = options.dryRun ?? true;
  const memoryIds = [...new Set((options.memoryIds ?? []).map((id) => id.trim()).filter(Boolean))].slice(0, 10);
  const memories = memoryIds.length > 0
    ? (await fetchMemoriesByIds(env.DB, { namespace, ids: memoryIds })).filter((memory) => memory.status === "active")
    : await listMemoriesSince(env.DB, {
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
      if (!dryRun) {
        const projectionKey = options.projectionKey
          ? `${options.projectionKey}:relation:${relationType}:${[candidate.source.id, candidate.target.id].sort().join(":")}`
          : null;
        const existing = projectionKey
          ? await env.DB.prepare(
              "SELECT id FROM memory_events WHERE namespace = ? AND event_type = 'y_relation_review' AND payload_json LIKE ? LIMIT 1"
            ).bind(namespace, `%\"projection_key\":\"${projectionKey}\"%`).first<{ id: string }>()
          : null;
        if (!existing?.id) await createMemoryEvent(env.DB, {
          namespace,
          eventType: "y_relation_review",
          memoryId: candidate.source.id,
          payload: {
            projection_key: projectionKey,
            relation_type: relationType,
            source_id: candidate.source.id,
            target_id: candidate.target.id,
            strength: hint.strength,
            reason: hint.reason ?? null
          }
        });
      }
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
    if (!dryRun) {
      const projectionKey = options.projectionKey ? `${options.projectionKey}:fact:${factKey}` : null;
      const existing = projectionKey
        ? await env.DB.prepare(
            "SELECT id FROM memory_events WHERE namespace = ? AND event_type = 'y_relation_review' AND payload_json LIKE ? LIMIT 1"
          ).bind(namespace, `%\"projection_key\":\"${projectionKey}\"%`).first<{ id: string }>()
        : null;
      if (!existing?.id) await createMemoryEvent(env.DB, {
        namespace,
        eventType: "y_relation_review",
        memoryId: ids[0] ?? null,
        payload: {
          projection_key: projectionKey,
          relation_type: "contradicts",
          fact_key: factKey,
          memory_ids: ids,
          reason: "multiple new memories share fact_key; needs human or Z-axis review"
        }
      });
    }
    review += 1;
  }

  return { scanned: memories.length, inserted, review, proposed, candidates: candidates.length, error };
}

export type RelationBuildResult = Awaited<ReturnType<typeof runRelationBuild>>;
