import type { Env, MemoryApiRecord } from "../types";
import { searchMemories } from "./search";

const MAX_PROMPT_CHARS = 1_200;
const MAX_MEMORY_CHARS = 220;
const DEFAULT_RECALL_TOP_K = 3;

const EXPLICIT_RECALL_PATTERNS = [
  /之前|上次|以前|过去|刚才|昨天|前天|那天|当时|后来|曾经/,
  /记得|记住|忘了|想起来|回忆|印象|提过|说过|聊过|写过|存过/,
  /之前.*(喜欢|讨厌|偏好|习惯|设定|雷点|底线|关系|称呼|名字|生日|纪念日)/,
  /(喜欢|讨厌|偏好|习惯|设定|雷点|底线|关系|称呼|名字|生日|纪念日).*之前/,
  /(上次|之前|刚才|昨天|那天|当时).*(进度|状态|安排|计划|部署|服务器|记忆库|heartbeat|forge|codex|claude|cc)/,
  /(进度|状态|安排|计划|部署|服务器|记忆库|heartbeat|forge|codex|claude|cc).*(上次|之前|刚才|昨天|那天|当时)/,
  /remember|recall|forgot|previous|before|last time|as we discussed|mentioned before/i,
  /\b\d{4}[.\-/年]\d{1,2}([.\-/月]\d{1,2})?/,
  /\b\d{1,2}月\d{1,2}日/
];

const CONTEXT_HINT_PATTERNS = [
  /喜欢|讨厌|偏好|习惯|设定|雷点|底线|关系|称呼|名字|生日|纪念日/,
  /进度|状态|安排|计划|部署|服务器|记忆库|heartbeat|forge|codex|claude|cc/,
  /她|他|我们|小柯|柯/,
  /什么|哪|多久|第几次|where|when|what/i
];

const NO_RECALL_PATTERNS = [
  /^\s*(hi|hello|hey|你好|嗨|在吗|嗯|哦|好|好的|行|可以|继续|谢谢|辛苦)\s*[。.!！?？]*\s*$/i,
  /^\s*(yes|no|ok|okay|thanks|thank you)\s*[。.!！?？]*\s*$/i,
  /^(ping|test|测试)$/i
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT_CHARS);
}

function sanitizeMemoryContent(memory: MemoryApiRecord): string {
  return memory.content
    .replace(/\s+/g, " ")
    .replace(/<\/?memories>/gi, "")
    .trim()
    .slice(0, MAX_MEMORY_CHARS);
}

function getRecallTopK(env: Env, requested?: number): number {
  const fallback = Number(env.MEMORY_RECALL_TOP_K || DEFAULT_RECALL_TOP_K);
  const value = requested || fallback;
  return Number.isFinite(value) ? clamp(Math.floor(value), 1, 3) : DEFAULT_RECALL_TOP_K;
}

function buildRecallSearchQuery(query: string): string {
  const terms = new Set([query]);
  const compact = query.replace(/\s+/g, "");

  if (/想你/.test(compact) && /(说什么|会说|说啥|怎么说|留言|口头禅)/.test(compact)) {
    terms.add("机 人想你 人好想你 机人想你 留言");
  }

  return [...terms].join(" ");
}

export function analyzeRecallNeed(prompt: string): { shouldRecall: boolean; score: number; reasons: string[]; query: string } {
  const query = normalizePrompt(prompt);
  if (!query || query.length < 2) return { shouldRecall: false, score: 0, reasons: [], query };
  if (NO_RECALL_PATTERNS.some((pattern) => pattern.test(query))) return { shouldRecall: false, score: 0, reasons: ["trivial"], query };

  const reasons: string[] = [];
  let score = 0;

  for (const pattern of EXPLICIT_RECALL_PATTERNS) {
    if (!pattern.test(query)) continue;
    score += 2;
    reasons.push("explicit_recall_signal");
  }

  if (score > 0) {
    for (const pattern of CONTEXT_HINT_PATTERNS) {
      if (!pattern.test(query)) continue;
      score += 1;
      reasons.push("context_hint");
      break;
    }
  }

  return {
    shouldRecall: score >= 2,
    score,
    reasons: [...new Set(reasons)],
    query
  };
}

export function formatRecallBlock(memories: MemoryApiRecord[]): string {
  const lines = memories.flatMap((memory) => {
    const content = sanitizeMemoryContent(memory);
    if (!content) return [];
    const tags = memory.tags.length ? ` tags=${memory.tags.slice(0, 4).join(",")}` : "";
    const pinned = memory.pinned ? " pinned=true" : "";
    return [`- id=${memory.id} type=${memory.type} importance=${memory.importance.toFixed(2)}${pinned}${tags}: ${content}`];
  });

  if (lines.length === 0) return "";
  return [
    "<recall>",
    "Relevant long-term memories. Use only if helpful; do not mention the memory system.",
    ...lines,
    "</recall>"
  ].join("\n");
}

export async function buildRecallContext(
  env: Env,
  input: { namespace: string; prompt: string; topK?: number; force?: boolean }
): Promise<{ should_recall: boolean; score: number; reasons: string[]; query: string; memories: MemoryApiRecord[]; recall: string }> {
  const analysis = analyzeRecallNeed(input.prompt);
  if (!input.force && !analysis.shouldRecall) {
    return { should_recall: false, score: analysis.score, reasons: analysis.reasons, query: analysis.query, memories: [], recall: "" };
  }

  const memories = await searchMemories(env, {
    namespace: input.namespace,
    query: buildRecallSearchQuery(analysis.query),
    topK: getRecallTopK(env, input.topK)
  });

  return {
    should_recall: memories.length > 0,
    score: analysis.score,
    reasons: analysis.reasons,
    query: analysis.query,
    memories,
    recall: formatRecallBlock(memories)
  };
}
