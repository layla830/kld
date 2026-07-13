import { loadRecallConfig } from "../config/runtime";
import { listActiveMemoriesByFactKeys, listGuidanceSeedMemories, markMemoriesRecalled, searchMemoriesByText } from "../db/memories";
import { listRelationExpandedMemories } from "../db/memoryRelations";
import { searchMessagesForRecall } from "../db/messages";
import type { Env, MemoryApiRecord, MessageRecord } from "../types";
import { shouldApplyEAxisToRanking } from "./eAxis";
import { toMemoryApiRecord } from "./mapper";
import { applyLead, postProcessMemorySearchResults, pruneConflictingDateContext } from "./postProcess";
import { expandQueryAngles, rerankMemories } from "./queryExpand";
import { factKeysForQueryHint } from "./queryHints";
import { searchEmotionMemories } from "../recall/sources/emotion";
import { mergeRelatedRecords, mergeSearchResults, type EAxisFusionTrace } from "../recall/fusion";
import { dedupeRecallOutput, isRecallEligible, keepHintedContext, keepRelatedContext, RECALL_EXCLUDED_TYPES } from "../recall/outputPolicy";
import { buildRecallQueryPlan, recordHaystack } from "../recall/queryPlan";
import { searchVectorMemories, type ScoredMemoryRecord } from "./vectorStore";

export { toMemoryApiRecord } from "./mapper";

export interface SearchMemoriesInput {
  namespace: string;
  query: string;
  rawQuery?: string;
  types?: string[];
  topK?: number;
  includeMessages?: boolean;
  recordRecall?: boolean;
  onEAxisTrace?: (trace: EAxisFusionTrace) => void;
}

const QUERY_HINT_SCORE = 1.35;
const GUIDANCE_SEED_SCORE = 0.72;
const RAW_EVENTS_FLOOR = 0.30;
const STRONG_KEYWORD_SCORE = 0.54;
const GUIDANCE_QUERY_RE = /应该怎么做|怎么办|怎么接|怎么哄|怎么回应|怎么处理|要怎么做|该怎么办/;

function candidateLimit(topK: number): number { return Math.min(Math.max(topK * 5, topK), 80); }

function messageRecord(message: MessageRecord & { score: number }): ScoredMemoryRecord {
  return {
    id: `msg_${message.id}`, namespace: message.namespace, type: "conversation_message",
    content: `${message.role === "user" ? "她" : "他"}：${message.content}`,
    summary: null, fact_key: null, active_fact: 1, thread: null, risk_level: null,
    urgency_level: null, tension_score: null, response_posture: null, audit_state: null,
    valence: null, arousal: null, importance: message.role === "user" ? 0.42 : 0.34,
    confidence: 0.75, status: "active", pinned: 0,
    tags: JSON.stringify(["raw_message", message.source || "chat"]), source: message.source || "messages",
    source_message_ids: JSON.stringify([message.id]), vector_id: null, vector_synced: 0,
    last_recalled_at: null, recall_count: 0, created_at: message.created_at, updated_at: message.created_at,
    expires_at: null, score: message.score, keywordScore: message.score
  };
}

export async function searchMemories(env: Env, input: SearchMemoriesInput): Promise<MemoryApiRecord[]> {
  const config = loadRecallConfig(env);
  const topK = Math.min(Math.max(input.topK ?? config.searchTopK, 1), 50);
  const limit = candidateLimit(topK);
  const plan = buildRecallQueryPlan(input.query, input.rawQuery || input.query);
  const hintedFactKeys = factKeysForQueryHint(`${plan.rawQuery} ${input.query} ${plan.searchQuery}`);
  const addGuidance = GUIDANCE_QUERY_RE.test(`${plan.rawQuery} ${input.query} ${plan.searchQuery}`);

  const angles = await expandQueryAngles(env, plan.rawQuery);
  const vectorHits = (await Promise.all((angles.length > 1 ? angles : [plan.expandedQuery]).map((query) =>
    searchVectorMemories(env, { namespace: input.namespace, query, types: input.types, topK: limit })
  ))).flatMap((records) => records ?? []);
  const vectorRecords = vectorHits.length ? [...new Map(vectorHits.filter(isRecallEligible).map((record) => [record.id, record])).values()]
    .sort((a, b) => (b.vectorScore ?? 0) - (a.vectorScore ?? 0)) : null;
  const vectorTopScore = vectorRecords?.[0]?.vectorScore ?? 0;

  const keywordRecords = (await searchMemoriesByText(env.DB, {
    namespace: input.namespace, query: plan.expandedQuery, types: input.types,
    excludeTypes: [...RECALL_EXCLUDED_TYPES], limit
  })).filter(isRecallEligible).map((record) => ({ ...record, keywordScore: record.score }));

  const messageRecords = vectorTopScore < RAW_EVENTS_FLOOR && input.includeMessages
    ? (await searchMessagesForRecall(env.DB, {
        namespace: input.namespace, query: plan.searchQuery,
        after: plan.timeIntent.mode === "hard_range" ? plan.timeIntent.after : undefined,
        before: plan.timeIntent.mode === "hard_range" ? plan.timeIntent.before : undefined,
        limit: Math.min(limit, 24)
      })).map(messageRecord)
    : [];

  const hintedRecords = hintedFactKeys.length ? await listActiveMemoriesByFactKeys(env.DB, {
    namespace: input.namespace, factKeys: hintedFactKeys, limit: Math.max(6, hintedFactKeys.length * 3),
    excludeTypes: [...RECALL_EXCLUDED_TYPES]
  }) : [];
  const guidanceRecords = addGuidance ? await listGuidanceSeedMemories(env.DB, { namespace: input.namespace, limit: 18 }) : [];

  const literalRecords: ScoredMemoryRecord[] = plan.literalTerms.length ? (await searchMemoriesByText(env.DB, {
    namespace: input.namespace, query: plan.literalTerms.join(" "), types: input.types,
    excludeTypes: [...RECALL_EXCLUDED_TYPES], limit: 3
  })).filter(isRecallEligible)
    .filter((record) => plan.literalTerms.some((term) => recordHaystack(record).includes(term.toLowerCase())))
    .map((record) => ({ ...record, score: Math.max(record.score, 0.82), keywordScore: Math.max(record.score, 0.82) })) : [];

  const emotionRecords = (await searchEmotionMemories(env, input.namespace, plan.rawQuery)).filter(isRecallEligible);
  const fusion = mergeSearchResults(vectorRecords, [
    ...keywordRecords,
    ...hintedRecords.map((record) => ({ ...record, score: QUERY_HINT_SCORE, keywordScore: QUERY_HINT_SCORE })),
    ...guidanceRecords.map((record) => ({
      ...record, score: GUIDANCE_SEED_SCORE + Math.min(0.24, record.relation_count * 0.015) + record.importance * 0.08,
      keywordScore: GUIDANCE_SEED_SCORE
    })),
    ...messageRecords, ...literalRecords, ...emotionRecords
  ], {
    query: plan.searchQuery, expandedQuery: plan.expandedQuery, limit,
    timeIntent: plan.timeIntent, applyEAxis: shouldApplyEAxisToRanking(env), observeTopK: topK
  });
  input.onEAxisTrace?.(fusion.eAxis);
  const fused = fusion.records;

  const related = (await listRelationExpandedMemories(env.DB, {
    namespace: input.namespace, baseIds: fused.map((record) => record.id), limit: Math.max(topK, Math.ceil(limit / 3))
  })).filter(isRecallEligible);
  const candidates = mergeRelatedRecords(fused, related, limit).map((record) => toMemoryApiRecord(record, record.score));
  const protectedIds = [
    ...literalRecords.map((record) => record.id),
    ...keywordRecords.filter((record) => (record.keywordScore ?? 0) >= STRONG_KEYWORD_SCORE).map((record) => record.id)
  ];
  const processed = await postProcessMemorySearchResults(env, {
    query: plan.searchQuery, rawQuery: plan.rawQuery, memories: candidates.filter(isRecallEligible), topK, protectedIds
  });
  const finalRelated = (await listRelationExpandedMemories(env.DB, {
    namespace: input.namespace, baseIds: processed.map((record) => record.id), limit: Math.max(topK, 8)
  })).filter(isRecallEligible).map((record) => toMemoryApiRecord(record, record.score));
  const hintedApi = hintedRecords.map((record) => toMemoryApiRecord(record, QUERY_HINT_SCORE));
  const output = dedupeRecallOutput(pruneConflictingDateContext(applyLead(
    await rerankMemories(env, {
      query: plan.searchQuery,
      memories: keepRelatedContext(keepHintedContext(processed, hintedApi, topK), finalRelated, topK),
      topK
    }), plan.rawQuery, plan.searchQuery
  ), plan.rawQuery)).slice(0, topK);

  if (input.recordRecall) {
    await markMemoriesRecalled(env.DB, { namespace: input.namespace, ids: output.map((record) => record.id).filter((id) => !id.startsWith("msg_")) });
  }
  return output;
}
