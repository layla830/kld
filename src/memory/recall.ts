import { listActiveMemoriesByFactKeys } from "../db/memories";
import type { Env, MemoryApiRecord } from "../types";
import { normalizeQueryForMemorySearch } from "./query";
import { searchMemories, toMemoryApiRecord } from "./search";
import { addDatedTimelineCandidates, filterUnsupportedRecallMemories } from "./recallFilter";
import { formatRecallBlock } from "./recallFormat";
import { analyzeRecallNeed, getRecallTopK } from "./recallIntent";
import { factKeysForQueryHint } from "./queryHints";

export { formatRecallBlock } from "./recallFormat";
export { analyzeRecallNeed } from "./recallIntent";

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

export async function buildRecallContext(
  env: Env,
  input: { namespace: string; prompt: string; topK?: number; force?: boolean }
): Promise<{ should_recall: boolean; score: number; reasons: string[]; query: string; memories: MemoryApiRecord[]; recall: string }> {
  const analysis = analyzeRecallNeed(input.prompt);
  if (!input.force && !analysis.shouldRecall) {
    return { should_recall: false, score: analysis.score, reasons: analysis.reasons, query: analysis.query, memories: [], recall: "" };
  }

  const topK = getRecallTopK(env, input.topK);
  const searchQuery = normalizeQueryForMemorySearch(analysis.query);
  const memories = await searchMemories(env, {
    namespace: input.namespace,
    query: searchQuery,
    rawQuery: analysis.query,
    topK,
    includeMessages: true
  });
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
    recall
  };
}
