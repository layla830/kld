import type { Env, MemoryApiRecord } from "../types";
import { searchMemories } from "./search";

const MAX_PROMPT_CHARS = 1_200;
const MAX_MEMORY_CHARS = 140;
const EXCERPT_RADIUS = 52;
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

const QUERY_NOISE_PATTERNS = [
  /你还记得/g,
  /还记得/g,
  /记不记得/g,
  /记得/g,
  /记住/g,
  /想起来/g,
  /回忆/g,
  /印象/g,
  /之前/g,
  /上次/g,
  /以前/g,
  /过去/g,
  /刚才/g,
  /昨天/g,
  /那天/g,
  /当时/g,
  /说过/g,
  /聊过/g,
  /提过/g,
  /存过/g,
  /是什么/g,
  /什么/g,
  /哪个/g,
  /哪里/g,
  /哪儿/g,
  /吗/g,
  /呢/g,
  /呀/g,
  /啊/g,
  /的/g
];

const LEADING_PRONOUN_PATTERN = /^(你们|我们|他们|她们|它们|你|我|她|他|它)+/;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT_CHARS);
}

function normalizeMemoryContent(memory: MemoryApiRecord): string {
  return memory.content.replace(/\s+/g, " ").replace(/<\/?memories>/gi, "").trim();
}

function clip(value: string, limit = MAX_MEMORY_CHARS): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trim()}...`;
}

function getRecallTopK(env: Env, requested?: number): number {
  const fallback = Number(env.MEMORY_RECALL_TOP_K || DEFAULT_RECALL_TOP_K);
  const value = requested || fallback;
  return Number.isFinite(value) ? clamp(Math.floor(value), 1, 3) : DEFAULT_RECALL_TOP_K;
}

function cleanQueryTerms(query: string): string {
  let normalized = query.toLowerCase().replace(/[?？!！。.,，、:：;；"“”'‘’]/g, " ");
  for (const pattern of QUERY_NOISE_PATTERNS) normalized = normalized.replace(pattern, " ");
  normalized = normalized.replace(/\s+/g, " ").trim();
  let previous = "";
  while (previous !== normalized) {
    previous = normalized;
    normalized = normalized.replace(LEADING_PRONOUN_PATTERN, "").trim();
  }
  return normalized.length >= 2 ? normalized : query;
}

function chineseNgrams(value: string): string[] {
  const grams: string[] = [];
  for (let size = Math.min(4, value.length); size >= 2; size -= 1) {
    for (let index = 0; index <= value.length - size; index += 1) grams.push(value.slice(index, index + size));
  }
  return grams;
}

function excerptNeedles(query: string): string[] {
  const needles = new Set<string>();
  for (const source of [cleanQueryTerms(query), query]) {
    for (const match of source.match(/[a-z][a-z0-9_+-]{2,}|[\u4e00-\u9fff]{2,}/gi) ?? []) {
      const term = match.toLowerCase();
      needles.add(term);
      if (/^[\u4e00-\u9fff]+$/.test(term) && term.length > 2) {
        for (const gram of chineseNgrams(term)) needles.add(gram);
      }
    }
  }
  return [...needles].sort((a, b) => b.length - a.length).slice(0, 16);
}

function relevantExcerpt(memory: MemoryApiRecord, query: string): string {
  const content = normalizeMemoryContent(memory);
  if (!content) return "";

  const lowerContent = content.toLowerCase();
  for (const needle of excerptNeedles(query)) {
    const index = lowerContent.indexOf(needle.toLowerCase());
    if (index < 0) continue;
    const start = Math.max(0, index - EXCERPT_RADIUS);
    const end = Math.min(content.length, index + needle.length + EXCERPT_RADIUS);
    const prefix = start > 0 ? "..." : "";
    const suffix = end < content.length ? "..." : "";
    return clip(`${prefix}${content.slice(start, end).trim()}${suffix}`);
  }

  return clip(content);
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

export function formatRecallBlock(memories: MemoryApiRecord[], query: string): string {
  const lines = memories.flatMap((memory) => {
    const content = relevantExcerpt(memory, query);
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
    recall: formatRecallBlock(memories, analysis.query)
  };
}
