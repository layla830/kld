import { listActiveMemoriesByFactKeys, searchMemoriesByText } from "../db/memories";
import type { Env, MemoryApiRecord } from "../types";
import { normalizeQueryForMemorySearch } from "./query";
import { searchMemories, toMemoryApiRecord } from "./search";
import { addDatedTimelineCandidates, filterUnsupportedRecallMemories } from "./recallFilter";
import { topicNeedles } from "./recallNeedles";
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

async function fetchDurableLexicalCandidates(
  env: Env,
  input: { namespace: string; rawQuery: string; limit: number }
): Promise<MemoryApiRecord[]> {
  const terms = topicNeedles(input.rawQuery).slice(0, 8);
  if (terms.length === 0) return [];

  const records = await searchMemoriesByText(env.DB, {
    namespace: input.namespace,
    query: terms.join(" "),
    excludeTypes: ["diary", "layla_diary", "auto_diary"],
    limit: Math.max(input.limit * 3, 8)
  });
  return records.map((record) => toMemoryApiRecord(record, record.score));
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
  const directLexicalCandidates = analysis.reasons.includes("explicit_recall_signal")
    ? await fetchDurableLexicalCandidates(env, { namespace: input.namespace, rawQuery: analysis.query, limit: topK })
    : [];
  const directCandidates = mergeUniqueMemories(
    directHintedCandidates,
    mergeUniqueMemories(directDatedCandidates, directLexicalCandidates)
  );
  if (directCandidates.length > 0) {
    const supportedDirect = filterUnsupportedRecallMemories(directCandidates, searchQuery, analysis.query).slice(0, topK);
    const directRecall = formatRecallBlock(supportedDirect, searchQuery);
    if (supportedDirect.length > 0 && directRecall) {
      return {
        should_recall: true,
        score: analysis.score,
        reasons: [...new Set([...analysis.reasons, "deterministic_fast_path"])],
        query: searchQuery,
        memories: supportedDirect,
        recall: directRecall
      };
    }
  }

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
