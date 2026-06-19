import type { Env, MemoryApiRecord } from "../types";
import { filterAndCompressMemories } from "./filter";

const FILTER_TIMEOUT_MS = 8000;

const UTTERANCE_RE = /原话|怎么说|说什么|说过什么|表达|口头禅|称呼|叫/;
const FACT_RE = /是什么|哪个|哪种|喜欢什么|讨厌什么|设定|偏好|雷点|底线|怎么来的|由来/;
const TIME_RE = /什么时候|哪天|多久|第几次|上次|昨天|前天|那天|那次|当时|日期|时间|发生了什么|发生什么|怎么聊|聊了什么/;
const GUIDANCE_RE = /应该怎么做|怎么办|怎么接|怎么哄|怎么回应|怎么处理|怎么开口|怎么说|要怎么做|该怎么办/;
const SHORT_UTTERANCE_NOISE_RE = /待会|现在|公司|回消息|自己玩|洗澡|回来|找你|睡觉|睡前|醒的时候|摸鱼/;

type IntentKind = "utterance" | "fact" | "time" | "guidance" | "general";

function getMaxOutput(env: Env, requestedTopK: number): number {
  const value = Number(env.MEMORY_SEARCH_MAX_OUTPUT || 8);
  const maxOutput = Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 1), 20) : 8;
  return Math.min(requestedTopK, maxOutput);
}

function intentKind(rawQuery: string, query: string): IntentKind {
  const text = `${rawQuery} ${query}`;
  if (UTTERANCE_RE.test(text)) return "utterance";
  if (TIME_RE.test(text)) return "time";
  if (FACT_RE.test(text)) return "fact";
  if (GUIDANCE_RE.test(text)) return "guidance";
  return "general";
}

function meta(memory: MemoryApiRecord): string {
  return `${memory.type} ${memory.tags.join(" ")} ${memory.source || ""}`;
}

function haystack(memory: MemoryApiRecord): string {
  return `${memory.content} ${memory.summary || ""} ${memory.tags.join(" ")} ${memory.type}`.toLowerCase();
}

function compact(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "").replace(/[?？！。.,，、:：;；"“”'‘’]/g, "");
}

function asksForHandoff(query: string): boolean {
  return /handoff|交接/i.test(query);
}

function isHandoff(memory: MemoryApiRecord): boolean {
  return /handoff|交接/i.test(`${meta(memory)} ${memory.content.slice(0, 80)}`);
}

function isTimelineDay(memory: MemoryApiRecord): boolean {
  return /timeline_day|day_summary/i.test(meta(memory));
}

function isTimeline(memory: MemoryApiRecord): boolean {
  return /timeline|quote|date:\d{4}-\d{2}-\d{2}/i.test(meta(memory));
}

function isQuote(memory: MemoryApiRecord): boolean {
  return /quote/i.test(meta(memory));
}

function isMilestone(memory: MemoryApiRecord): boolean {
  return /milestone/i.test(meta(memory));
}

function isLongNarrative(memory: MemoryApiRecord): boolean {
  return memory.content.length > 180 || /diary|summary|日记|总结|legacy:vps/i.test(meta(memory));
}

function isGuidanceRecord(memory: MemoryApiRecord): boolean {
  return Boolean(memory.fact_key) && /^(rule|lesson|core|preference)$/i.test(memory.type);
}

function directHit(memory: MemoryApiRecord, query: string): boolean {
  const needle = compact(query);
  return needle.length >= 2 && compact(haystack(memory)).includes(needle);
}

function directHitAny(memory: MemoryApiRecord, queries: string[]): boolean {
  return queries.some((query) => directHit(memory, query));
}

function scoreMemory(memory: MemoryApiRecord, input: { kind: IntentKind; query: string; rawQuery: string; index: number }): number {
  let score = typeof memory.score === "number" ? memory.score : 0;
  const query = `${input.rawQuery} ${input.query}`;

  if (isHandoff(memory) && !asksForHandoff(query)) score -= 3;
  if (directHitAny(memory, [input.query, input.rawQuery])) score += 0.6;

  if (input.kind === "time") {
    if (isTimelineDay(memory)) score += 2;
    else if (isTimeline(memory)) score += 0.7;
    if (/diary|日记/i.test(meta(memory))) score -= 0.4;
  }

  if (input.kind === "fact") {
    if (isQuote(memory) && directHitAny(memory, [input.query, input.rawQuery])) score += 1.8;
    if (isMilestone(memory)) score += 1.5;
    if (isLongNarrative(memory)) score -= 0.8;
  }

  if (input.kind === "utterance") {
    if (isQuote(memory)) score += 1;
    if (SHORT_UTTERANCE_NOISE_RE.test(memory.content)) score -= 0.7;
    if (isLongNarrative(memory)) score -= 0.7;
  }

  if (input.kind === "guidance") {
    if (isGuidanceRecord(memory)) score += 1.05;
    if (memory.response_posture && isGuidanceRecord(memory)) score += 0.25;
    if (isQuote(memory) || isMilestone(memory) || isTimeline(memory)) score -= 0.85;
    if (/^(diary|layla_diary|quarrel|message|identity)$/i.test(memory.type)) score -= 0.75;
    if (isLongNarrative(memory) && !isGuidanceRecord(memory)) score -= 0.9;
  }

  return score - input.index * 0.001;
}

function rerank(query: string, rawQuery: string, memories: MemoryApiRecord[]): { kind: IntentKind; memories: MemoryApiRecord[] } {
  const kind = intentKind(rawQuery, query);
  if (kind === "general") return { kind, memories };

  return {
    kind,
    memories: [...memories].sort((a, b) => {
      const aIndex = memories.indexOf(a);
      const bIndex = memories.indexOf(b);
      return scoreMemory(b, { kind, query, rawQuery, index: bIndex }) - scoreMemory(a, { kind, query, rawQuery, index: aIndex }) || aIndex - bIndex;
    })
  };
}

function withoutIncidentalHandoff(query: string, memories: MemoryApiRecord[]): MemoryApiRecord[] {
  if (asksForHandoff(query)) return memories;
  const kept = memories.filter((memory) => !isHandoff(memory));
  return kept.length > 0 ? kept : memories;
}

async function filterWithTimeout(env: Env, query: string, memories: MemoryApiRecord[]): Promise<MemoryApiRecord[]> {
  return Promise.race([
    filterAndCompressMemories(env, { query, memories }),
    new Promise<MemoryApiRecord[]>((resolve) => setTimeout(() => resolve(memories), FILTER_TIMEOUT_MS))
  ]);
}

function leadFor(kind: IntentKind, query: string, rawQuery: string, memories: MemoryApiRecord[]): MemoryApiRecord | undefined {
  if (kind === "time") return memories.find(isTimelineDay) || memories.find(isQuote);
  if (kind === "fact") return memories.find((memory) => isQuote(memory) && directHitAny(memory, [query, rawQuery])) || memories.find(isMilestone);
  if (kind === "utterance") return memories.find(isQuote);
  return undefined;
}

function keepLead(kind: IntentKind, query: string, rawQuery: string, candidates: MemoryApiRecord[], filtered: MemoryApiRecord[], maxOutput: number): MemoryApiRecord[] {
  const lead = leadFor(kind, query, rawQuery, candidates);
  if (!lead) return filtered.slice(0, maxOutput);

  if (kind === "fact" || kind === "utterance" || isQuote(lead)) {
    const focused = filtered.filter((memory) => memory.id !== lead.id && ((isMilestone(memory) || isQuote(memory)) && directHitAny(memory, [query, rawQuery])));
    return [lead, ...focused].slice(0, maxOutput);
  }

  return [lead, ...filtered.filter((memory) => memory.id !== lead.id)].slice(0, maxOutput);
}

export async function postProcessMemorySearchResults(
  env: Env,
  input: { query: string; rawQuery?: string; memories: MemoryApiRecord[]; topK: number }
): Promise<MemoryApiRecord[]> {
  const maxOutput = getMaxOutput(env, input.topK);
  const query = input.query.trim();
  if (!query || input.memories.length === 0) return input.memories.slice(0, maxOutput);

  const rawQuery = input.rawQuery || query;
  const { kind, memories } = rerank(query, rawQuery, input.memories);
  const candidates = withoutIncidentalHandoff(rawQuery, memories);
  if (kind === "guidance") return candidates.slice(0, maxOutput);
  const filtered = await filterWithTimeout(env, rawQuery, candidates);
  return keepLead(kind, query, rawQuery, candidates, filtered, maxOutput);
}
