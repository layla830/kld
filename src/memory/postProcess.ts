import type { Env, MemoryApiRecord } from "../types";

const QUERY_PREFIXES = ["想找那个", "找那个", "那个", "想找", "搜索", "查一下", "查找"];

const ANCHORED_QUERY_GROUPS = [
  {
    queryTerms: ["所有叶子", "所有的叶子"],
    anchors: ["所有的叶子", "所有叶子", "这棵树本身", "同一棵树", "柯是树枝", "身份", "连续性", "新枝"]
  }
];

const UTTERANCE_QUERY_PATTERNS = [/原话|怎么说|说什么|会说|说过什么|表达|口头禅|称呼|叫/];
const FACT_QUERY_PATTERNS = [/是什么|哪个|哪种|喜欢什么|讨厌什么|设定|偏好|雷点|底线/];
const TIME_QUERY_PATTERNS = [/什么时候|哪天|多久|第几次|上次|昨天|前天|那天|当时|日期|时间/];
const SITUATIONAL_UTTERANCE_PATTERNS = [/待会|现在|公司|回消息|自己玩|洗澡|回来|找你|睡觉|睡前|醒的时候|摸鱼/];
const STYLIZED_UTTERANCE_PATTERN = /[……~～^_^]|[，,][^。！？!?]{0,10}(想你|喜欢|爱你)|(想你|喜欢|爱你)[^。！？!?]{0,10}[，,]/;

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

function isShortMemory(memory: MemoryApiRecord): boolean {
  return stripQueryNoise(memory.content).length <= 80;
}

function isLongNarrative(memory: MemoryApiRecord): boolean {
  const tags = memory.tags.join(" ");
  return memory.content.length > 180 || /diary|summary|交接|日记|总结|legacy:vps/i.test(`${memory.type} ${tags}`);
}

function intentKind(rawQuery: string, query: string): "utterance" | "fact" | "time" | "general" {
  const combined = `${rawQuery} ${query}`;
  if (UTTERANCE_QUERY_PATTERNS.some((pattern) => pattern.test(combined))) return "utterance";
  if (TIME_QUERY_PATTERNS.some((pattern) => pattern.test(combined))) return "time";
  if (FACT_QUERY_PATTERNS.some((pattern) => pattern.test(combined))) return "fact";
  return "general";
}

function typeTags(memory: MemoryApiRecord): string {
  return `${memory.type} ${memory.tags.join(" ")}`;
}

function directHit(memory: MemoryApiRecord, query: string): boolean {
  const compactQuery = stripQueryNoise(query);
  return compactQuery.length >= 2 && memoryHaystack(memory).includes(compactQuery);
}

function utteranceShapeScore(memory: MemoryApiRecord): number {
  const content = memory.content.trim();
  const compactLength = stripQueryNoise(content).length;
  let score = 0;

  if (compactLength <= 20) score += 1.7;
  else if (compactLength <= 36) score += 1.2;
  else if (compactLength <= 60) score += 0.45;
  else score -= 0.5;

  if (STYLIZED_UTTERANCE_PATTERN.test(content)) score += 0.7;
  if (SITUATIONAL_UTTERANCE_PATTERNS.some((pattern) => pattern.test(content))) score -= 0.9;
  return score;
}

function questionIntentScore(memory: MemoryApiRecord, input: { query: string; rawQuery: string; index: number }): number {
  const kind = intentKind(input.rawQuery, input.query);
  if (kind === "general") return 0;

  const meta = typeTags(memory);
  const contentLength = stripQueryNoise(memory.content).length;
  let score = directHit(memory, input.query) ? 0.8 : -0.8;

  if (kind === "utterance") {
    if (/quote|message|留言|语录|read/i.test(meta)) score += 0.55;
    if (isShortMemory(memory)) score += 0.35;
    score += utteranceShapeScore(memory);
    score += clamp((80 - contentLength) / 80, 0, 1) * 0.25;
    if (/diary|日记|summary|总结|交接/i.test(meta)) score -= 0.8;
    if (isLongNarrative(memory)) score -= 0.7;
  }

  if (kind === "fact") {
    if (/note|fact|profile|preference|设定|偏好/i.test(meta)) score += 0.6;
    if (isShortMemory(memory)) score += 0.35;
    if (isLongNarrative(memory)) score -= 0.35;
  }

  if (kind === "time") {
    if (/diary|timeline|日记|交接/i.test(meta)) score += 0.45;
    if (/\d{4}|\d{1,2}月\d{1,2}日|昨天|前天|那天|当时/.test(memory.content)) score += 0.45;
  }

  return score - input.index * 0.001;
}

function rerankByQuestionIntent(query: string, rawQuery: string, memories: MemoryApiRecord[]): MemoryApiRecord[] {
  const kind = intentKind(rawQuery, query);
  if (kind === "general") return memories;

  return [...memories].sort((a, b) => {
    const aIndex = memories.indexOf(a);
    const bIndex = memories.indexOf(b);
    const delta = questionIntentScore(b, { query, rawQuery, index: bIndex }) - questionIntentScore(a, { query, rawQuery, index: aIndex });
    return delta || aIndex - bIndex;
  });
}

export async function postProcessMemorySearchResults(
  env: Env,
  input: { query: string; rawQuery?: string; memories: MemoryApiRecord[]; topK: number }
): Promise<MemoryApiRecord[]> {
  const maxOutput = getMaxOutput(env, input.topK);
  const query = input.query.trim();
  if (!query || input.memories.length === 0) return input.memories.slice(0, maxOutput);

  const supportedMatches = preferSupportedMatches(query, input.memories);
  const rerankedMatches = rerankByQuestionIntent(query, input.rawQuery || query, supportedMatches);
  return rerankedMatches.slice(0, maxOutput);
}
