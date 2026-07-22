import { listActiveMemoriesByFactKeys, searchMemoriesByText } from "../db/memories";
import type { Env, MemoryApiRecord } from "../types";
import { normalizeQueryForMemorySearch } from "../memory/query";
import {
  recordMemorySearchDegradation,
  searchMemories,
  toMemoryApiRecord,
  type MemorySearchDegradation
} from "../memory/search";
import { addDatedTimelineCandidates, filterUnsupportedRecallMemories } from "./candidatePolicy";
import { topicNeedles } from "./vocabulary";
import { formatRecallBlock } from "./formatter";
import { analyzeRecallNeed, getRecallTopK } from "./intent";
import { factKeysForQueryHint } from "../memory/queryHints";
import { buildRecallTrace, type RecallTrace } from "./trace";
import type { EAxisFusionTrace } from "./fusion";

export { formatRecallBlock } from "./formatter";
export { analyzeRecallNeed } from "./intent";

export interface RecallContextResult {
  should_recall: boolean;
  score: number;
  reasons: string[];
  query: string;
  memories: MemoryApiRecord[];
  recall: string;
  trace: RecallTrace;
}

function mergeUniqueMemories(primary: MemoryApiRecord[], secondary: MemoryApiRecord[]): MemoryApiRecord[] {
  const seen = new Set<string>();
  const merged: MemoryApiRecord[] = [];
  for (const memory of [...primary, ...secondary]) {
    if (seen.has(memory.id)) continue;
    seen.add(memory.id);
    merged.push(memory);
  }
  return merged;
}

async function fetchHintedFactKeyCandidates(
  env: Env,
  input: { namespace: string; rawQuery: string; searchQuery: string; limit: number }
): Promise<MemoryApiRecord[]> {
  const factKeys = factKeysForQueryHint(`${input.rawQuery} ${input.searchQuery}`);
  if (factKeys.length === 0) return [];

  const records = await listActiveMemoriesByFactKeys(env.DB, {
    namespace: input.namespace,
    factKeys,
    limit: input.limit,
    excludeTypes: ["diary", "layla_diary"]
  });
  return records.map((record) => toMemoryApiRecord(record, 1.4));
}

async function fetchDurableLexicalCandidates(
  env: Env,
  input: { namespace: string; rawQuery: string; limit: number }
): Promise<{ records: MemoryApiRecord[]; degradations: MemorySearchDegradation[] }> {
  const terms = topicNeedles(input.rawQuery).slice(0, 8);
  if (terms.length === 0) return { records: [], degradations: [] };

  const result = await searchMemoriesByText(env.DB, {
    namespace: input.namespace,
    query: terms.join(" "),
    excludeTypes: ["diary", "layla_diary", "auto_diary"],
    limit: Math.max(input.limit * 3, 8)
  });
  return {
    records: result.records.map((record) => toMemoryApiRecord(record, record.score)),
    degradations: result.status === "degraded"
      ? [{ source: "keyword", ...result.error }]
      : []
  };
}

function uniqueDegradations(items: MemorySearchDegradation[]): MemorySearchDegradation[] {
  return [...new Map(items.map((item) => [`${item.source}:${item.code}`, item])).values()];
}

export async function buildRecallContext(
  env: Env,
  input: { namespace: string; prompt: string; topK?: number; force?: boolean }
): Promise<RecallContextResult> {
  const analysis = analyzeRecallNeed(input.prompt);
  if (!input.force && !analysis.shouldRecall) {
    return { should_recall: false, score: analysis.score, reasons: analysis.reasons, query: analysis.query, memories: [], recall: "", trace: buildRecallTrace([], "hybrid_search") };
  }

  const topK = getRecallTopK(env, input.topK);
  const searchQuery = normalizeQueryForMemorySearch(analysis.query);
  const directHintedCandidates = await fetchHintedFactKeyCandidates(env, {
    namespace: input.namespace,
    rawQuery: input.prompt,
    searchQuery,
    limit: Math.max(4, topK)
  });
  const directDatedCandidates = await addDatedTimelineCandidates(env, {
    namespace: input.namespace,
    rawQuery: analysis.query,
    memories: [],
    topK
  });
  const directLexicalSearch = analysis.reasons.includes("explicit_recall_signal")
    ? await fetchDurableLexicalCandidates(env, { namespace: input.namespace, rawQuery: analysis.query, limit: topK })
    : { records: [], degradations: [] };
  const directLexicalCandidates = directLexicalSearch.records;
  const directCandidates = directDatedCandidates.length > 0
    ? mergeUniqueMemories(directDatedCandidates, mergeUniqueMemories(directHintedCandidates, directLexicalCandidates))
    : mergeUniqueMemories(directHintedCandidates, directLexicalCandidates);
  if (directCandidates.length > 0) {
    const supportedDirect = filterUnsupportedRecallMemories(directCandidates, searchQuery, analysis.query).slice(0, topK);
    const directRecall = formatRecallBlock(supportedDirect, searchQuery);
    if (supportedDirect.length > 0 && directRecall) {
      await recordMemorySearchDegradation(env, {
        namespace: input.namespace,
        degradations: directLexicalSearch.degradations
      });
      return {
        should_recall: true,
        score: analysis.score,
        reasons: [...new Set([...analysis.reasons, "deterministic_fast_path"])],
        query: searchQuery,
        memories: supportedDirect,
        recall: directRecall,
        trace: buildRecallTrace(
          supportedDirect,
          "deterministic_fast_path",
          undefined,
          directLexicalSearch.degradations
        )
      };
    }
  }

  let eAxisTrace: EAxisFusionTrace | undefined;
  const memorySearch = await searchMemories(env, {
    namespace: input.namespace,
    query: searchQuery,
    rawQuery: analysis.query,
    topK,
    includeMessages: true,
    onEAxisTrace: (trace) => { eAxisTrace = trace; }
  });
  const memories = memorySearch.records;
  const withDatedCandidates = await addDatedTimelineCandidates(env, {
    namespace: input.namespace,
    rawQuery: analysis.query,
    memories,
    topK
  });
  const withHintedCandidates = mergeUniqueMemories(
    await fetchHintedFactKeyCandidates(env, {
      namespace: input.namespace,
      rawQuery: input.prompt,
      searchQuery,
      limit: Math.max(4, topK)
    }),
    withDatedCandidates
  );
  const supportedMemories = filterUnsupportedRecallMemories(withHintedCandidates, searchQuery, analysis.query);
  const recall = formatRecallBlock(supportedMemories, searchQuery);

  return {
    should_recall: supportedMemories.length > 0 && Boolean(recall),
    score: analysis.score,
    reasons: analysis.reasons,
    query: searchQuery,
    memories: supportedMemories,
    recall,
    trace: buildRecallTrace(
      supportedMemories,
      "hybrid_search",
      eAxisTrace,
      uniqueDegradations([...directLexicalSearch.degradations, ...memorySearch.degradations])
    )
  };
}
