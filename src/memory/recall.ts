import type { Env, MemoryApiRecord } from "../types";
import { normalizeQueryForMemorySearch } from "./query";
import { searchMemories } from "./search";
import { addDatedTimelineCandidates, filterUnsupportedRecallMemories } from "./recallFilter";
import { formatRecallBlock } from "./recallFormat";
import { analyzeRecallNeed, getRecallTopK } from "./recallIntent";

export { formatRecallBlock } from "./recallFormat";
export { analyzeRecallNeed } from "./recallIntent";

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
  const supportedMemories = filterUnsupportedRecallMemories(withDatedCandidates, searchQuery, analysis.query);
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
