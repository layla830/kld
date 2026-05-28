import type { Env, MemoryApiRecord } from "../types";
import { filterAndCompressMemories } from "./filter";

const QUERY_PREFIXES = ["想找那个", "找那个", "那个", "想找", "搜索", "查一下", "查找"];

const ANCHORED_QUERY_GROUPS = [
  {
    queryTerms: ["所有叶子", "所有的叶子"],
    anchors: ["所有的叶子", "所有叶子", "这棵树本身", "同一棵树", "柯是树枝", "身份", "连续性", "新枝"]
  }
];

const UTTERANCE_RE = /原话|怎么说|说什么|说过什么|表达|口头禅|称呼|叫/;
const FACT_RE = /是什么|哪个|哪种|喜欢什么|讨厌什么|设定|偏好|雷点|底线|怎么来的|由来/;
const TIME_RE = /什么时候|哪天|多久|第几次|上次|昨天|前天|那天|那次|当时|日期|时间|发生了什么|发生什么|怎么聊|聊了什么/;
const SHORT_UTTERANCE_NOISE_RE = /待会|现在|公司|回消息|自己玩|洗澡|回来|找你|睡觉|睡前|醒的时候|摸鱼/;
const FILTER_TIMEOUT_MS = 8000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getMaxOutput(env: Env, requestedTopK: number): number {
  const value = Number(env.MEMORY_SEARCH_MAX_OUTPUT || 8);
  const maxOutput = Number.isFinite(value) ? clamp(Math.floor(value), 1, 20) : 8;
  return Math.min(requestedTopK, maxOutput);
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "").trim();
}

function stripQueryNoise(value: string): string {
  return normalizeText(value).replace(/[?？!！。.,，、:：;；"“”'‘’]/g, "");
}

function exactQueryNeedles(query: string): string[] {
  const compact = stripQueryNoise(query);
  if (!compact || /[a-z0-9]/i.test(compact)) return [];

  const needles = new Set<string>();
  if (compact.length >= 3 && compact.length <= 16) needles.add(compact);

  for (const prefix of QUERY_PREFIXES) {
    if (!compact.startsWith(prefix)) continue;
    const stripped = compact.slice(prefix.length);
    if (stripped.length >= 2 && stripped.length <= 12) needles.add(stripped);
  }

  return [...needles];
}

function memoryHaystack(memory: MemoryApiRecord): string {
  return normalizeText(`${memory.content} ${memory.summary || ""} ${memory.tags.join(" ")} ${memory.type}`);
}

function anchoredQueryMatches(query: string, memories: MemoryApiRecord[]): MemoryApiRecord[] | null {
  const compactQuery = normalizeText(query);
  const group = ANCHORED_QUERY_GROUPS.find((item) => item.queryTerms.some((term) => compactQuery.includes(normalizeText(term))));
  if (!group) return null;

  const matches = memories.filter((memory) => {
    const haystack = memoryHaystack(memory);
    return group.anchors.some((anchor) => haystack.includes(normalizeText(anchor)));
  });

  return matches.length > 0 ? matches : null;
}

function exactQueryMatches(query: string, memories: MemoryApiRecord[]): MemoryApiRecord[] | null {
  const needles = exactQueryNeedles(query);
  if (needles.length === 0) return null;

  const matches = memories.filter((memory) => {
    const haystack = memoryHaystack(memory);
    return needles.some((needle) => haystack.includes(needle));
  });

  return matches.length > 0 ? matches : null;
}

function preferSupportedMatches(query: string, memories: MemoryApiRecord[]): MemoryApiRecord[] {
  return anchoredQueryMatches(query, memories) || exactQueryMatches(query, memories) || memories;
}

function meta(memory: MemoryApiRecord): string {
  return `${memory.type} ${memory.tags.join(" ")} ${memory.source || ""}`;
}

function asksForHandoff(query: string): boolean {
  return /handoff|交接/i.test(query);
}

function isHandoff(memory: MemoryApiRecord): boolean {
  return /handoff|交接/i.test(`${meta(memory)} ${memory.content.slice(0, 80)}`);
}

function removeIncidentalHandoff(query: string, memories: MemoryApiRecord[]): MemoryApiRecord[] {
  if (asksForHandoff(query)) return memories;
  const kept = memories.filter((memory) => !isHandoff(memory));
  return kept.length > 0 ? kept : memories;
}

function intentKind(rawQuery: string, query: string): "utterance" | "fact" | "time" | "general" {
  const combined = `${rawQuery} ${query}`;
  if (UTTERANCE_RE.test(combined)) return "utterance";
  if (TIME_RE.test(combined)) return "time";
  if (FACT_RE.test(combined)) return "fact";
  return "general";
}

function isTimeline(memory: MemoryApiRecord): boolean {
  return /timeline|timeline_day|quote|date:\d{4}-\d{2}-\d{2}/i.test(meta(memory));
}

function isTimelineDay(memory: MemoryApiRecord): boolean {
  return /timeline_day|day_summary/i.test(meta(memory));
}

function isQuote(memory: MemoryApiRecord): boolean {
  return /quote/i.test(meta(memory));
}

function isMilestone(memory: MemoryApiRecord): boolean {
  return /milestone/i.test(meta(memory));
}

function isLongNarrative(memory: MemoryApiRecord): boolean {
  return memory.content.length > 180 || /diary|summary|交接|日记|总结|legacy:vps/i.test(meta(memory));
}

function directHit(memory: MemoryApiRecord, query: string): boolean {
  const compactQuery = stripQueryNoise(query);
  return compactQuery.length >= 2 && memoryHaystack(memory).includes(compactQuery);
}

function utteranceShapeScore(memory: MemoryApiRecord): number {
  const length = stripQueryNoise(memory.content).length;
  if (SHORT_UTTERANCE_NOISE_RE.test(memory.content)) return -0.7;
  if (length <= 20) return 1.2;
  if (length <= 60) return 0.4;
  return -0.4;
}

function scoreMemory(memory: MemoryApiRecord, input: { query: string; rawQuery: string; kind: string; index: number }): number {
  const info = meta(memory);
  const combinedQuery = `${input.rawQuery} ${input.query}`;
  let score = directHit(memory, input.query) ? 0.8 : -0.4;

  if (isTimeline(memory)) score += 0.6;
  if (isHandoff(memory) && !asksForHandoff(combinedQuery)) score -= 2.5;

  if (input.kind === "utterance") {
    if (isQuote(memory) || /message|留言|语录/i.test(info)) score += 0.8;
    score += utteranceShapeScore(memory);
    if (isLongNarrative(memory)) score -= 0.8;
  }

  if (input.kind === "fact") {
    if (isMilestone(memory)) score += 1.1;
    if (isQuote(memory) && directHit(memory, input.query)) score += 0.8;
    if (/fact|profile|preference|设定|偏好/i.test(info)) score += 0.6;
    if (isTimelineDay(memory)) score += 0.25;
    if (isLongNarrative(memory)) score -= 0.75;
  }

  if (input.kind === "time") {
    if (isTimelineDay(memory)) score += 1.5;
    else if (isTimeline(memory)) score += 0.8;
    if (/diary|日记/i.test(info)) score -= 0.35;
    if (/date:\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}日|那天|那次|当时/.test(`${info} ${memory.content}`)) score += 0.5;
  }

  return score - input.index * 0.001;
}

function rerankByQuestionIntent(query: string, rawQuery: string, memories: MemoryApiRecord[]): MemoryApiRecord[] {
  const kind = intentKind(rawQuery, query);
  if (kind === "general") return memories;

  return [...memories].sort((a, b) => {
    const aIndex = memories.indexOf(a);
    const bIndex = memories.indexOf(b);
    return scoreMemory(b, { query, rawQuery, kind, index: bIndex }) - scoreMemory(a, { query, rawQuery, kind, index: aIndex }) || aIndex - bIndex;
  });
}

function preferredLead(kind: string, memories: MemoryApiRecord[]): MemoryApiRecord | undefined {
  if (kind === "time") return memories.find(isTimelineDay);
  if (kind === "fact") return memories.find(isMilestone);
  return undefined;
}

function focusedFactResult(lead: MemoryApiRecord, query: string, filtered: MemoryApiRecord[], maxOutput: number): MemoryApiRecord[] {
  const rest = filtered.filter((memory) => {
    if (memory.id === lead.id) return false;
    if (isMilestone(memory) && directHit(memory, query)) return true;
    return isQuote(memory) && directHit(memory, query);
  });
  return [lead, ...rest].slice(0, maxOutput);
}

function keepPreferredLead(input: {
  kind: string;
  query: string;
  candidates: MemoryApiRecord[];
  filtered: MemoryApiRecord[];
  maxOutput: number;
}): MemoryApiRecord[] {
  const lead = preferredLead(input.kind, input.candidates);
  if (!lead) return input.filtered.slice(0, input.maxOutput);
  if (input.kind === "fact") return focusedFactResult(lead, input.query, input.filtered, input.maxOutput);
  if (input.filtered.some((memory) => memory.id === lead.id)) return input.filtered.slice(0, input.maxOutput);
  return [lead, ...input.filtered.filter((memory) => memory.id !== lead.id)].slice(0, input.maxOutput);
}

async function filterMemoriesQuickly(
  env: Env,
  input: { query: string; memories: MemoryApiRecord[] }
): Promise<MemoryApiRecord[]> {
  return Promise.race([
    filterAndCompressMemories(env, input),
    new Promise<MemoryApiRecord[]>((resolve) => setTimeout(() => resolve(input.memories), FILTER_TIMEOUT_MS))
  ]);
}

export async function postProcessMemorySearchResults(
  env: Env,
  input: { query: string; rawQuery?: string; memories: MemoryApiRecord[]; topK: number }
): Promise<MemoryApiRecord[]> {
  const maxOutput = getMaxOutput(env, input.topK);
  const query = input.query.trim();
  if (!query || input.memories.length === 0) return input.memories.slice(0, maxOutput);

  const rawQuery = input.rawQuery || query;
  const kind = intentKind(rawQuery, query);
  const supportedMatches = preferSupportedMatches(query, input.memories);
  const rerankedMatches = rerankByQuestionIntent(query, rawQuery, supportedMatches);
  const recallCandidates = removeIncidentalHandoff(rawQuery, rerankedMatches);
  const modelFilteredMatches = await filterMemoriesQuickly(env, { query: rawQuery, memories: recallCandidates });
  return keepPreferredLead({ kind, query, candidates: recallCandidates, filtered: modelFilteredMatches, maxOutput });
}
