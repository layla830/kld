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

type HybridRecord = ScoredMemoryRecord & { lexicalScore?: number; rankScore?: number; timeScore?: number };

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

export function mergeSearchResults(
  vectorRecords: ScoredMemoryRecord[] | null,
  keywordRecords: ScoredMemoryRecord[],
  input: { query: string; expandedQuery: string; limit: number; timeIntent: TimeIntent; applyEAxis: boolean }
): ScoredMemoryRecord[] {
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
    next.score = rank(next, input.applyEAxis);
    merged.set(record.id, next);
  };
  (vectorRecords ?? []).forEach((record, index) => add(record, "vector", index + 1));
  keywordRecords.forEach((record, index) => add(record, "keyword", index + 1));
  const ranked = [...merged.values()].sort((a, b) => b.score - a.score);
  const hasStrongKeyword = ranked.some((record) => (record.keywordScore ?? 0) >= STRONG_KEYWORD_SCORE || (record.lexicalScore ?? 0) >= 0.55);
  const needles = strongNeedles(input.query, input.expandedQuery);
  const supported = ranked.filter((record) => !hasStrongKeyword || (record.lexicalScore ?? 0) >= 0.55 ||
    (record.keywordScore ?? 0) >= WEAK_KEYWORD_SCORE || (record.timeScore ?? 0) >= 0.55 ||
    needles.some((needle) => recordHaystack(record).includes(needle.toLowerCase())) ||
    (record.vectorScore ?? 0) >= VECTOR_ONLY_SCORE_WITH_STRONG_KEYWORDS);
  return (supported.length ? supported : ranked).slice(0, input.limit);
}

export function mergeRelatedRecords(records: ScoredMemoryRecord[], related: ScoredMemoryRecord[], limit: number): ScoredMemoryRecord[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const record of related) {
    const existing = byId.get(record.id);
    if (!existing || record.score > existing.score) byId.set(record.id, record);
  }
  return [...byId.values()].sort((a, b) => b.score + b.importance * 0.05 - (a.score + a.importance * 0.05)).slice(0, limit);
}
