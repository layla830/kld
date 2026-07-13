import type { MemoryRecord } from "../types";
import { computeDecayedWeight } from "./halfLife";
import { lexicalTerms, recordHaystack, strongNeedles } from "./recallQueryPlan";
import { recencyBoost, timeIntentScore, type TimeIntent } from "./recallTemporal";
import type { ScoredMemoryRecord } from "./vectorStore";

const RRF_K = 60;
const STRONG_KEYWORD_SCORE = 0.54;
const WEAK_KEYWORD_SCORE = 0.48;
const VECTOR_ONLY_SCORE_WITH_STRONG_KEYWORDS = 0.78;
const RULE_TYPES = new Set(["rule", "lesson", "core", "preference", "identity"]);
const CONTEXT_TYPES = new Set(["diary", "layla_diary", "quote", "message", "timeline_day", "conversation_message"]);

type HybridRecord = ScoredMemoryRecord & {
  lexicalScore?: number;
  rankScore?: number;
  timeScore?: number;
  baselineScore?: number;
  eAxisScore?: number;
};

export interface EAxisRankChange {
  id: string;
  type: string;
  fact_key: string | null;
  baseline_rank: number | null;
  e_axis_rank: number | null;
  baseline_score: number;
  e_axis_score: number;
  boost: number;
}

export interface EAxisFusionTrace {
  mode: "shadow" | "active";
  evaluated: boolean;
  compared_count: number;
  boosted_count: number;
  changed_count: number;
  top_k_changed: boolean;
  baseline_top_ids: string[];
  e_axis_top_ids: string[];
  changes: EAxisRankChange[];
}

export interface MergeSearchResultsOutput {
  records: ScoredMemoryRecord[];
  eAxis: EAxisFusionTrace;
}

function clamp(value: number, min: number, max: number): number { return Math.min(Math.max(value, min), max); }

function lexicalScore(record: MemoryRecord, query: string, expandedQuery: string): number {
  const terms = lexicalTerms(query, expandedQuery);
  const content = record.content.toLowerCase();
  const summary = (record.summary || "").toLowerCase();
  const factKey = (record.fact_key || "").toLowerCase();
  const tags = (record.tags || "").toLowerCase();
  const type = record.type.toLowerCase();
  const haystack = `${content} ${summary} ${factKey} ${tags} ${type}`;
  const compact = query.toLowerCase().replace(/\s+/g, "");
  let best = compact.length >= 2 && compact.length <= 24 && haystack.includes(compact) ? 0.7 : 0;
  let hits = 0;
  for (const term of terms) {
    const inText = content.includes(term) || summary.includes(term);
    const inMeta = factKey.includes(term) || tags.includes(term) || type.includes(term);
    if (!inText && !inMeta) continue;
    hits += 1;
    best = Math.max(best, inMeta ? 0.9 : 0.6);
  }
  return clamp(best + (terms.length ? Math.min(1, hits / Math.min(terms.length, 4)) : 0) * 0.22, 0, 1.1);
}

function eAxisBoost(record: HybridRecord): number {
  if (CONTEXT_TYPES.has(record.type)) return 0;
  let boost = RULE_TYPES.has(record.type) ? 0.06 : 0;
  if (typeof record.tension_score === "number" && record.tension_score >= 0.5) boost += 0.04;
  if (record.risk_level === "high") boost += 0.03;
  else if (record.risk_level === "medium") boost += 0.015;
  if (record.thread?.startsWith("relationship.boundaries")) boost += 0.02;
  return Math.min(boost, 0.15);
}

function rank(record: HybridRecord, applyEAxis: boolean): number {
  return (record.vectorScore ?? 0) * 0.42 + (record.keywordScore ?? 0) * 0.7 +
    (record.lexicalScore ?? 0) * 0.45 + (record.timeScore ?? 0) * 1.2 +
    (record.rankScore ?? 0) * 8 + computeDecayedWeight(record) * 0.12 +
    (record.pinned ? 0.08 : 0) + recencyBoost(record) * 0.02 + (applyEAxis ? eAxisBoost(record) : 0);
}

function rounded(value: number): number { return Math.round(value * 10000) / 10000; }

function buildEAxisTrace(
  baseline: HybridRecord[],
  eAxis: HybridRecord[],
  observeTopK: number,
  applyEAxis: boolean
): EAxisFusionTrace {
  const size = Math.min(Math.max(Math.floor(observeTopK), 1), Math.max(baseline.length, 1));
  const baselineTop = baseline.slice(0, size);
  const eAxisTop = eAxis.slice(0, size);
  const baselineRanks = new Map(baseline.map((record, index) => [record.id, index + 1]));
  const eAxisRanks = new Map(eAxis.map((record, index) => [record.id, index + 1]));
  const byId = new Map([...baseline, ...eAxis].map((record) => [record.id, record]));
  const observedIds = [...new Set([...baselineTop.map((record) => record.id), ...eAxisTop.map((record) => record.id)])];
  const changes = observedIds
    .map((id): EAxisRankChange | null => {
      const record = byId.get(id);
      if (!record) return null;
      const baselineRank = baselineRanks.get(id) ?? null;
      const eAxisRank = eAxisRanks.get(id) ?? null;
      const baselineScore = record.baselineScore ?? rank(record, false);
      const eAxisScore = record.eAxisScore ?? rank(record, true);
      if (baselineRank === eAxisRank && Math.abs(eAxisScore - baselineScore) < 0.00005) return null;
      return {
        id: record.id,
        type: record.type,
        fact_key: record.fact_key,
        baseline_rank: baselineRank,
        e_axis_rank: eAxisRank,
        baseline_score: rounded(baselineScore),
        e_axis_score: rounded(eAxisScore),
        boost: rounded(eAxisScore - baselineScore)
      };
    })
    .filter((change): change is EAxisRankChange => change !== null)
    .slice(0, 12);
  const baselineTopIds = baselineTop.map((record) => record.id);
  const eAxisTopIds = eAxisTop.map((record) => record.id);
  return {
    mode: applyEAxis ? "active" : "shadow",
    evaluated: baseline.length > 0,
    compared_count: baseline.length,
    boosted_count: baseline.filter((record) => (record.eAxisScore ?? 0) > (record.baselineScore ?? 0) + 0.00005).length,
    changed_count: changes.filter((change) => change.baseline_rank !== change.e_axis_rank).length,
    top_k_changed: baselineTopIds.some((id, index) => eAxisTopIds[index] !== id),
    baseline_top_ids: baselineTopIds,
    e_axis_top_ids: eAxisTopIds,
    changes
  };
}

export function mergeSearchResults(
  vectorRecords: ScoredMemoryRecord[] | null,
  keywordRecords: ScoredMemoryRecord[],
  input: { query: string; expandedQuery: string; limit: number; timeIntent: TimeIntent; applyEAxis: boolean; observeTopK?: number }
): MergeSearchResultsOutput {
  const merged = new Map<string, HybridRecord>();
  const add = (record: ScoredMemoryRecord, source: "vector" | "keyword", sourceRank: number) => {
    const existing = merged.get(record.id);
    const lexical = lexicalScore(record, input.query, input.expandedQuery);
    const time = timeIntentScore(record, input.timeIntent);
    const rankScore = (source === "keyword" ? 1.25 : 1) / (RRF_K + sourceRank);
    const next: HybridRecord = existing ? {
      ...existing, ...record,
      vectorScore: Math.max(existing.vectorScore ?? 0, record.vectorScore ?? 0) || undefined,
      keywordScore: Math.max(existing.keywordScore ?? 0, record.keywordScore ?? 0) || undefined,
      lexicalScore: Math.max(existing.lexicalScore ?? 0, lexical),
      timeScore: Math.max(existing.timeScore ?? 0, time),
      rankScore: (existing.rankScore ?? 0) + rankScore
    } : { ...record, lexicalScore: lexical, timeScore: time, rankScore };
    next.baselineScore = rank(next, false);
    next.eAxisScore = rank(next, true);
    next.score = input.applyEAxis ? next.eAxisScore : next.baselineScore;
    merged.set(record.id, next);
  };
  (vectorRecords ?? []).forEach((record, index) => add(record, "vector", index + 1));
  keywordRecords.forEach((record, index) => add(record, "keyword", index + 1));
  const allRecords = [...merged.values()];
  const hasStrongKeyword = allRecords.some((record) => (record.keywordScore ?? 0) >= STRONG_KEYWORD_SCORE || (record.lexicalScore ?? 0) >= 0.55);
  const needles = strongNeedles(input.query, input.expandedQuery);
  const supported = allRecords.filter((record) => !hasStrongKeyword || (record.lexicalScore ?? 0) >= 0.55 ||
    (record.keywordScore ?? 0) >= WEAK_KEYWORD_SCORE || (record.timeScore ?? 0) >= 0.55 ||
    needles.some((needle) => recordHaystack(record).includes(needle.toLowerCase())) ||
    (record.vectorScore ?? 0) >= VECTOR_ONLY_SCORE_WITH_STRONG_KEYWORDS);
  const eligible = supported.length ? supported : allRecords;
  const baselineRanked = [...eligible].sort((a, b) => (b.baselineScore ?? 0) - (a.baselineScore ?? 0));
  const eAxisRanked = [...eligible].sort((a, b) => (b.eAxisScore ?? 0) - (a.eAxisScore ?? 0));
  const activeRanked = input.applyEAxis ? eAxisRanked : baselineRanked;
  return {
    records: activeRanked.slice(0, input.limit).map((record) => ({
      ...record,
      score: input.applyEAxis ? record.eAxisScore ?? record.score : record.baselineScore ?? record.score
    })),
    eAxis: buildEAxisTrace(baselineRanked, eAxisRanked, input.observeTopK ?? input.limit, input.applyEAxis)
  };
}

export function mergeRelatedRecords(records: ScoredMemoryRecord[], related: ScoredMemoryRecord[], limit: number): ScoredMemoryRecord[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const record of related) {
    const existing = byId.get(record.id);
    if (!existing || record.score > existing.score) byId.set(record.id, record);
  }
  return [...byId.values()].sort((a, b) => b.score + b.importance * 0.05 - (a.score + a.importance * 0.05)).slice(0, limit);
}
