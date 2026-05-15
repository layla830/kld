import type { Env, MemoryApiRecord } from "../types";

const QUERY_PREFIXES = ["想找那个", "找那个", "那个", "想找", "搜索", "查一下", "查找"];

const ANCHORED_QUERY_GROUPS = [
  {
    queryTerms: ["所有叶子", "所有的叶子"],
    anchors: ["所有的叶子", "所有叶子", "这棵树本身", "同一棵树", "柯是树枝", "身份", "连续性", "新枝"]
  }
];

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

export async function rerankMemorySearchResults(
  env: Env,
  input: { query: string; memories: MemoryApiRecord[]; topK: number }
): Promise<MemoryApiRecord[]> {
  const maxOutput = getMaxOutput(env, input.topK);
  const query = input.query.trim();
  if (!query || input.memories.length === 0) return input.memories.slice(0, maxOutput);

  return preferSupportedMatches(query, input.memories).slice(0, maxOutput);
}
