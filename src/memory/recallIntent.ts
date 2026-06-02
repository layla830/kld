import type { Env } from "../types";

const MAX_PROMPT_CHARS = 1_200;
const DEFAULT_RECALL_TOP_K = 3;
const MAX_RECALL_TOP_K = 5;

export const TIME_WORD_RE = /昨天|前天|今天|今晚|昨晚|那天|那次|当时|上周|本周|这个月|本月|上个月|上月/;
const DATE_RE = /\b(?:20\d{2}[.\-/年])?\d{1,2}[.\-/月]\d{1,2}日?/;
const MEMORY_VERB_RE = /记得|忘了|想起来|回忆|印象|提过|说过|聊过|写过|存过|之前|上次|以前|过去|曾经/;
const NATURAL_RECALL_RE = /是什么|怎么来的|由来|发生了什么|发生什么|怎么聊的|怎么聊|聊了什么/;
const CONTEXT_HINT_RE = /她|他|我们|小柯|柯|绿卡|第四种|换窗|暗号|关系|称呼|名字|生日|纪念日|4\.5|4\.6|4\.7|4o|forge|codex|claude|cc|记忆库/i;
const TRIVIAL_RE = /^\s*(hi|hello|hey|你好|嗨|在吗|嗯|哦|好|好的|行|可以|继续|谢谢|辛苦|yes|no|ok|okay|thanks|test|测试)\s*[。.!！?？]*\s*$/i;

export const BROAD_TIME_QUERY_RE = new RegExp(`${TIME_WORD_RE.source}.*(说了什么|聊了什么|在聊什么|弄什么|做什么|干什么|怎么样|发生了什么|发生什么|怎么聊)`);

export interface RecallAnalysis {
  shouldRecall: boolean;
  score: number;
  reasons: string[];
  query: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT_CHARS);
}

export function getRecallTopK(env: Env, requested?: number): number {
  const fallback = Number(env.MEMORY_RECALL_TOP_K || DEFAULT_RECALL_TOP_K);
  const value = requested || fallback;
  return Number.isFinite(value) ? clamp(Math.floor(value), 1, MAX_RECALL_TOP_K) : DEFAULT_RECALL_TOP_K;
}

export function analyzeRecallNeed(prompt: string): RecallAnalysis {
  const query = normalizePrompt(prompt);
  if (!query || query.length < 2) return { shouldRecall: false, score: 0, reasons: [], query };
  if (TRIVIAL_RE.test(query)) return { shouldRecall: false, score: 0, reasons: ["trivial"], query };

  const recallSignal = MEMORY_VERB_RE.test(query) || TIME_WORD_RE.test(query) || DATE_RE.test(query) || NATURAL_RECALL_RE.test(query);
  const contextHint = CONTEXT_HINT_RE.test(query) || /什么|哪|多久|第几次|发生|怎么聊|where|when|what|how/i.test(query);
  const score = (recallSignal ? 2 : 0) + (recallSignal && contextHint ? 1 : 0);
  const reasons = [recallSignal ? "explicit_recall_signal" : "", recallSignal && contextHint ? "context_hint" : ""].filter(Boolean);

  return { shouldRecall: score >= 2, score, reasons: [...new Set(reasons)], query };
}
