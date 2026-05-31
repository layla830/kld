import { searchMemoriesByText } from "../db/memories";
import type { Env, MemoryApiRecord } from "../types";
import { chineseNgrams, normalizeQueryForMemorySearch } from "./query";
import { searchMemories, toMemoryApiRecord } from "./search";

const MAX_PROMPT_CHARS = 1_200;
const MAX_MEMORY_CHARS = 120;
const EXCERPT_RADIUS = 48;
const DEFAULT_RECALL_TOP_K = 3;
const MAX_RECALL_TOP_K = 5;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

const TIME_WORD_RE = /昨天|前天|今天|今晚|昨晚|那天|那次|当时|上周|本周|这个月|本月|上个月|上月/;
const DATE_RE = /\b(?:20\d{2}[.\-/年])?\d{1,2}[.\-/月]\d{1,2}日?/;
const MEMORY_VERB_RE = /记得|忘了|想起来|回忆|印象|提过|说过|聊过|写过|存过|之前|上次|以前|过去|曾经/;
const NATURAL_RECALL_RE = /是什么|怎么来的|由来|发生了什么|发生什么|怎么聊的|怎么聊|聊了什么/;
const CONTEXT_HINT_RE = /她|他|我们|小柯|柯|绿卡|第四种|换窗|暗号|关系|称呼|名字|生日|纪念日|4\.5|4\.6|4\.7|4o|forge|codex|claude|cc|记忆库/i;
const BROAD_TIME_QUERY_RE = new RegExp(`${TIME_WORD_RE.source}.*(说了什么|聊了什么|在聊什么|弄什么|做什么|干什么|怎么样|发生了什么|发生什么|怎么聊)`);
const TRIVIAL_RE = /^\s*(hi|hello|hey|你好|嗨|在吗|嗯|哦|好|好的|行|可以|继续|谢谢|辛苦|yes|no|ok|okay|thanks|test|测试)\s*[。.!！?？]*\s*$/i;

const STOP_TERMS = new Set([
  "你", "我", "她", "他", "我们", "你们", "他们", "这个", "那个", "什么", "哪个", "哪里", "怎么", "为啥",
  "之前", "上次", "以前", "过去", "刚才", "昨天", "前天", "今天", "今晚", "昨晚", "那次", "那天", "当时",
  "记得", "忘了", "想起来", "回忆", "印象", "说过", "聊过", "提过", "说了", "聊了", "发生", "发生了",
  "是什么", "怎么来的", "由来", "怎么聊", "怎么聊的", "问题", "事情", "东西", "正常", "聊天", "召回", "记忆",
  "the", "and", "that", "what", "when", "where", "how", "before", "previous", "remember", "recall", "forgot", "last", "time"
]);

const SENTENCE_BOUNDARIES = new Set(["。", "！", "？", "!", "?", "；", ";"]);

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT_CHARS);
}

function getRecallTopK(env: Env, requested?: number): number {
  const fallback = Number(env.MEMORY_RECALL_TOP_K || DEFAULT_RECALL_TOP_K);
  const value = requested || fallback;
  return Number.isFinite(value) ? clamp(Math.floor(value), 1, MAX_RECALL_TOP_K) : DEFAULT_RECALL_TOP_K;
}

function shanghaiYear(): number {
  return new Date(Date.now() + SHANGHAI_OFFSET_MS).getUTCFullYear();
}

function dateNeedles(query: string): string[] {
  const needles = new Set<string>();

  for (const match of query.matchAll(/\b(20\d{2})[.\-/年](\d{1,2})[.\-/月](\d{1,2})日?/g)) {
    const [, year, month, day] = match;
    const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    needles.add(`${Number(month)}月${Number(day)}日`);
    needles.add(iso);
    needles.add(`date:${iso}`);
  }

  for (const match of query.matchAll(/(?:^|[^\d])(\d{1,2})月(\d{1,2})日/g)) {
    const [, month, day] = match;
    const iso = `${shanghaiYear()}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    needles.add(`${Number(month)}月${Number(day)}日`);
    needles.add(iso);
    needles.add(`date:${iso}`);
  }

  return [...needles];
}

function topicNeedles(query: string): string[] {
  const needles = new Set<string>();
  const normalized = normalizeQueryForMemorySearch(query);
  for (const match of normalized.match(/[a-z][a-z0-9_+-]{2,}|[\u4e00-\u9fff]{2,}/gi) ?? []) {
    const term = match.toLowerCase();
    if (STOP_TERMS.has(term)) continue;
    needles.add(term);
    if (/^[\u4e00-\u9fff]+$/.test(term) && term.length > 2) {
      for (const gram of chineseNgrams(term)) {
        if (!STOP_TERMS.has(gram)) needles.add(gram);
      }
    }
  }
  return [...needles];
}

function supportNeedles(rawQuery: string, searchQuery: string): string[] {
  return [...new Set([...dateNeedles(rawQuery), ...topicNeedles(`${rawQuery} ${searchQuery}`)])]
    .sort((a, b) => b.length - a.length)
    .slice(0, 16);
}

function normalizeMemoryContent(memory: MemoryApiRecord): string {
  return memory.content.replace(/\s+/g, " ").replace(/<\/?memories>/gi, "").trim();
}

function clip(value: string, limit = MAX_MEMORY_CHARS): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit).trim()}...`;
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
  for (const needle of supportNeedles(query, query)) {
    const index = lowerContent.indexOf(needle.toLowerCase());
    if (index < 0) continue;
    const start = findExcerptStart(content, index);
    const end = findExcerptEnd(content, index, needle.length);
    const excerpt = content.slice(start, end).replace(/^\s*(?:\d+\.|[一二三四五六七八九十]+、)\s*/, "").trim();
    return clip(`${start > 0 ? "..." : ""}${excerpt}${end < content.length ? "..." : ""}`);
  }

  return clip(content);
}

function supportHaystack(memory: MemoryApiRecord): string {
  return `${memory.content} ${memory.summary || ""} ${memory.tags.join(" ")} ${memory.type}`.toLowerCase();
}

function isTimeSummaryCandidate(memory: MemoryApiRecord): boolean {
  const meta = `${memory.type} ${memory.tags.join(" ")} ${memory.source || ""}`;
  return /auto_diary|timeline|quote|diary|summary|日记|总结|conversation_message|date:\d{4}-\d{2}-\d{2}/i.test(meta);
}

function isTimelineDay(memory: MemoryApiRecord): boolean {
  return /timeline_day|day_summary/i.test(`${memory.type} ${memory.tags.join(" ")}`);
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

async function addDatedTimelineCandidates(
  env: Env,
  input: { namespace: string; rawQuery: string; memories: MemoryApiRecord[]; topK: number }
): Promise<MemoryApiRecord[]> {
  const needles = dateNeedles(input.rawQuery);
  if (needles.length === 0 || input.memories.some(isTimelineDay)) return input.memories;

  const rows = await searchMemoriesByText(env.DB, {
    namespace: input.namespace,
    query: needles.join(" "),
    limit: Math.max(input.topK * 4, 12)
  });
  const dated = rows.map((record) => toMemoryApiRecord(record, record.score)).filter(isTimelineDay);
  return dated.length > 0 ? mergeUniqueMemories(dated, input.memories) : input.memories;
}

function filterUnsupportedRecallMemories(memories: MemoryApiRecord[], searchQuery: string, rawQuery: string): MemoryApiRecord[] {
  if (BROAD_TIME_QUERY_RE.test(rawQuery)) return memories.filter(isTimeSummaryCandidate);

  const needles = supportNeedles(rawQuery, searchQuery);
  if (needles.length === 0) return memories;

  const supported = memories.filter((memory) => {
    const haystack = supportHaystack(memory);
    return needles.some((needle) => haystack.includes(needle.toLowerCase()));
  });
  return supported.length > 0 ? supported : [];
}

export function analyzeRecallNeed(prompt: string): { shouldRecall: boolean; score: number; reasons: string[]; query: string } {
  const query = normalizePrompt(prompt);
  if (!query || query.length < 2) return { shouldRecall: false, score: 0, reasons: [], query };
  if (TRIVIAL_RE.test(query)) return { shouldRecall: false, score: 0, reasons: ["trivial"], query };

  const recallSignal = MEMORY_VERB_RE.test(query) || TIME_WORD_RE.test(query) || DATE_RE.test(query) || NATURAL_RECALL_RE.test(query);
  const contextHint = CONTEXT_HINT_RE.test(query) || /什么|哪|多久|第几次|发生|怎么聊|where|when|what|how/i.test(query);
  const score = (recallSignal ? 2 : 0) + (recallSignal && contextHint ? 1 : 0);
  const reasons = [recallSignal ? "explicit_recall_signal" : "", recallSignal && contextHint ? "context_hint" : ""].filter(Boolean);

  return { shouldRecall: score >= 2, score, reasons: [...new Set(reasons)], query };
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
  return ["<recall>", "Relevant long-term memories. Use only if helpful; do not mention the memory system.", ...lines, "</recall>"].join("\n");
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
