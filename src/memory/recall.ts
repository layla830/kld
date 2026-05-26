import type { Env, MemoryApiRecord } from "../types";
import { chineseNgrams, normalizeQueryForMemorySearch } from "./query";
import { searchMemories } from "./search";

const MAX_PROMPT_CHARS = 1_200;
const MAX_MEMORY_CHARS = 120;
const EXCERPT_RADIUS = 48;
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

const RECALL_SUPPORT_STOPWORDS = new Set([
  "你", "我", "她", "他", "我们", "你们", "他们", "她们", "这个", "那个", "什么", "哪个", "哪里", "怎么", "为啥",
  "是不是", "还有", "一下", "记得", "还记得", "之前", "上次", "以前", "过去", "刚才", "刚刚", "昨天", "前天",
  "今天", "今晚", "昨晚", "那天", "当时", "后来", "曾经", "说过", "聊过", "提过", "问题", "事情", "东西",
  "正常", "聊天", "召回", "记忆", "回忆", "印象", "忘了", "想起来", "the", "and", "that", "what", "when", "where",
  "how", "before", "previous", "remember", "recall", "forgot", "last", "time"
]);

const BROAD_TIME_RECALL_PATTERN = /(昨天|前天|今天|今晚|昨晚|上周|本周|上个月|本月).*(说了什么|聊了什么|弄什么|做什么|干什么|怎么样)/;
const SENTENCE_BOUNDARIES = new Set(["。", "！", "？", "!", "?", "；", ";"]);

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

function queryNeedles(query: string): string[] {
  const needles = new Set<string>();
  for (const match of normalizeQueryForMemorySearch(query).match(/[a-z][a-z0-9_+-]{2,}|[\u4e00-\u9fff]{2,}/gi) ?? []) {
    const term = match.toLowerCase();
    if (RECALL_SUPPORT_STOPWORDS.has(term)) continue;
    needles.add(term);
    if (/^[\u4e00-\u9fff]+$/.test(term) && term.length > 2) {
      for (const gram of chineseNgrams(term)) {
        if (!RECALL_SUPPORT_STOPWORDS.has(gram)) needles.add(gram);
      }
    }
  }
  return [...needles].sort((a, b) => b.length - a.length).slice(0, 16);
}

function excerptNeedles(query: string): string[] {
  const needles = queryNeedles(query);
  if (needles.length > 0) return needles;

  const fallback = new Set<string>();
  for (const match of normalizeQueryForMemorySearch(query).match(/[a-z][a-z0-9_+-]{2,}|[\u4e00-\u9fff]{2,}/gi) ?? []) {
    fallback.add(match.toLowerCase());
  }
  return [...fallback].sort((a, b) => b.length - a.length).slice(0, 16);
}

function findExcerptStart(content: string, index: number): number {
  const rawStart = Math.max(0, index - EXCERPT_RADIUS);
  for (let cursor = index - 1; cursor >= rawStart; cursor -= 1) {
    if (SENTENCE_BOUNDARIES.has(content[cursor])) return cursor + 1;
  }
  return rawStart;
}

function findExcerptEnd(content: string, index: number, needleLength: number): number {
  const rawEnd = Math.min(content.length, index + needleLength + EXCERPT_RADIUS);
  for (let cursor = index + needleLength; cursor < rawEnd; cursor += 1) {
    if (SENTENCE_BOUNDARIES.has(content[cursor])) return cursor + 1;
  }
  return rawEnd;
}

function relevantExcerpt(memory: MemoryApiRecord, query: string): string {
  const content = normalizeMemoryContent(memory);
  if (!content) return "";

  const lowerContent = content.toLowerCase();
  for (const needle of excerptNeedles(query)) {
    const index = lowerContent.indexOf(needle.toLowerCase());
    if (index < 0) continue;
    const start = findExcerptStart(content, index);
    const end = findExcerptEnd(content, index, needle.length);
    const excerpt = content.slice(start, end).replace(/^\s*(?:\d+\.|[一二三四五六七八九十]+、)\s*/, "").trim();
    const prefix = start > 0 ? "..." : "";
    const suffix = end < content.length ? "..." : "";
    return clip(prefix + excerpt + suffix);
  }

  return clip(content);
}

function supportHaystack(memory: MemoryApiRecord): string {
  return `${memory.content} ${memory.summary || ""} ${memory.tags.join(" ")} ${memory.type}`.toLowerCase();
}

function hasSupportNeedle(memory: MemoryApiRecord, needles: string[]): boolean {
  const haystack = supportHaystack(memory);
  return needles.some((needle) => haystack.includes(needle));
}

function isTimeSummaryCandidate(memory: MemoryApiRecord): boolean {
  const meta = `${memory.type} ${memory.tags.join(" ")} ${memory.source || ""}`;
  return /auto_diary|diary|summary|交接|日记|总结|conversation_message/i.test(meta);
}

function filterUnsupportedRecallMemories(memories: MemoryApiRecord[], query: string, rawQuery: string): MemoryApiRecord[] {
  const needles = queryNeedles(`${rawQuery} ${query}`);
  if (needles.length === 0) return BROAD_TIME_RECALL_PATTERN.test(rawQuery) ? memories.filter(isTimeSummaryCandidate) : memories;

  const supported = memories.filter((memory) => hasSupportNeedle(memory, needles));
  if (supported.length > 0) return supported;

  if (BROAD_TIME_RECALL_PATTERN.test(rawQuery)) return memories.filter(isTimeSummaryCandidate);
  return [];
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

  const searchQuery = normalizeQueryForMemorySearch(analysis.query);
  const memories = await searchMemories(env, {
    namespace: input.namespace,
    query: searchQuery,
    rawQuery: analysis.query,
    topK: getRecallTopK(env, input.topK),
    includeMessages: true
  });
  const supportedMemories = filterUnsupportedRecallMemories(memories, searchQuery, analysis.query);
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
