import type { Env, MemoryApiRecord } from "../types";
import { searchMemories } from "./search";

const MAX_PROMPT_CHARS = 1_200;
const MAX_MEMORY_CHARS = 220;

const STRONG_RECALL_PATTERNS = [
  /之前|上次|以前|过去|刚才|昨天|前天|那天|当时|后来|曾经/,
  /记得|记住|忘了|想起来|回忆|印象|提过|说过|聊过|写过|存过/,
  /喜欢|讨厌|偏好|习惯|设定|雷点|底线|关系|称呼|名字|生日|纪念日/,
  /什么时候|哪天|多久|第几次|进度|状态|安排|计划/,
  /remember|recall|forgot|previous|before|last time|preference|habit|relationship/i,
  /\b\d{4}[.\-/年]\d{1,2}([.\-/月]\d{1,2})?/,
  /\b\d{1,2}月\d{1,2}日/
];

const SOFT_RECALL_PATTERNS = [
  /我|你|我们|她|他|宝宝|小柯|柯/,
  /怎么办|怎么做|要不要|可不可以|合适吗|继续|更新|整理|总结/,
  /难过|开心|生气|焦虑|害怕|想要|希望|感觉|在意/,
  /项目|仓库|服务器|部署|记忆库|heartbeat|forge|codex|claude|cc/,
  /how should|what did|what was|do you know|can you remember/i
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
  const fallback = Number(env.MEMORY_RECALL_TOP_K || 5);
  const value = requested || fallback;
  return Number.isFinite(value) ? clamp(Math.floor(value), 1, 12) : 5;
}

export function analyzeRecallNeed(prompt: string): { shouldRecall: boolean; score: number; reasons: string[]; query: string } {
  const query = normalizePrompt(prompt);
  if (!query || query.length < 2) return { shouldRecall: false, score: 0, reasons: [], query };
  if (NO_RECALL_PATTERNS.some((pattern) => pattern.test(query))) return { shouldRecall: false, score: 0, reasons: ["trivial"], query };

  const reasons: string[] = [];
  let score = 0;

  for (const pattern of STRONG_RECALL_PATTERNS) {
    if (!pattern.test(query)) continue;
    score += 2;
    reasons.push("strong_signal");
  }

  for (const pattern of SOFT_RECALL_PATTERNS) {
    if (!pattern.test(query)) continue;
    score += 1;
    reasons.push("soft_signal");
  }

  if (query.length >= 18) score += 1;
  if (/[?？]/.test(query)) score += 1;

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
    query: analysis.query,
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
