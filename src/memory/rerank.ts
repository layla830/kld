import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, MemoryApiRecord, OpenAIChatRequest, OpenAIChatResponse } from "../types";

interface RerankItem {
  id: string;
  score: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getRerankModel(env: Env): string | null {
  return env.MEMORY_RERANK_MODEL || env.MEMORY_FILTER_MODEL || env.MEMORY_QUERY_REWRITE_MODEL || env.MEMORY_MODEL || null;
}

function isRerankEnabled(env: Env): boolean {
  return env.ENABLE_MEMORY_RERANK === "true" && Boolean(getRerankModel(env));
}

function getMaxCandidates(env: Env): number {
  const value = Number(env.MEMORY_RERANK_MAX_CANDIDATES || 18);
  return Number.isFinite(value) ? clamp(Math.floor(value), 2, 50) : 18;
}

function extractJsonArray(text: string): unknown[] | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
      const maybe = parsed as { results?: unknown; memories?: unknown; items?: unknown };
      if (Array.isArray(maybe.results)) return maybe.results;
      if (Array.isArray(maybe.memories)) return maybe.memories;
      if (Array.isArray(maybe.items)) return maybe.items;
    }
  } catch {
    // Some providers wrap strict JSON in text. Extract the first array below.
  }

  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseRerankItems(text: string, allowedIds: Set<string>): RerankItem[] | null {
  const array = extractJsonArray(text);
  if (!array) return null;

  const items: RerankItem[] = [];
  for (const item of array) {
    if (typeof item === "string") {
      if (allowedIds.has(item)) items.push({ id: item, score: 0.7 });
      continue;
    }
    if (!item || typeof item !== "object") continue;

    const record = item as { id?: unknown; score?: unknown; relevance?: unknown };
    const id = typeof record.id === "string" ? record.id : null;
    if (!id || !allowedIds.has(id)) continue;

    const rawScore = typeof record.score === "number" ? record.score : typeof record.relevance === "number" ? record.relevance : 0.7;
    items.push({ id, score: clamp(rawScore, 0, 1) });
  }

  return items.length > 0 ? items : null;
}

function buildPrompt(input: { query: string; memories: MemoryApiRecord[]; maxOutput: number }): string {
  const candidates = input.memories.map((memory, index) => ({
    index: index + 1,
    id: memory.id,
    type: memory.type,
    importance: memory.importance,
    pinned: memory.pinned,
    score: memory.score,
    tags: memory.tags,
    summary: memory.summary,
    content: memory.content.slice(0, 700)
  }));

  return [
    "你是个人长期记忆搜索的相关性裁判。你的任务是从候选记忆中选出真正回答搜索词的结果，并按相关性排序。",
    "",
    "规则：",
    "- 只保留和搜索词真实相关的候选；语义擦边、只是情绪相似、只有常见词重合的都删除。",
    "- pinned=true 不能自动保留；只有确实相关时才保留。",
    "- 如果搜索词是缩写、隐喻、上位概念或模糊说法，可以保留同义词、别名、相关术语命中的候选。",
    "- 如果搜索词包含具体词、日期、名字、项目名，必须优先保留直接包含或明确指向这些信息的候选。",
    "- 不要输出候选之外的 id，不要改写内容，不要解释。",
    `- 最多输出 ${input.maxOutput} 条；如果只有 1 条相关，就只输出 1 条；如果都不相关，输出 []。`,
    "",
    "只输出 JSON 数组，格式：",
    "[{\"id\":\"mem_xxx\",\"score\":0.93}]",
    "",
    `搜索词：${input.query}`,
    "",
    `候选记忆：${JSON.stringify(candidates)}`
  ].join("\n");
}

function applyRerank(memories: MemoryApiRecord[], items: RerankItem[], topK: number): MemoryApiRecord[] {
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const used = new Set<string>();
  const result: MemoryApiRecord[] = [];

  for (const item of items.sort((a, b) => b.score - a.score)) {
    const memory = byId.get(item.id);
    if (!memory || used.has(item.id)) continue;
    used.add(item.id);
    result.push({ ...memory, score: item.score });
  }

  return result.slice(0, topK);
}

export async function rerankMemorySearchResults(
  env: Env,
  input: { query: string; memories: MemoryApiRecord[]; topK: number }
): Promise<MemoryApiRecord[]> {
  const query = input.query.trim();
  if (!isRerankEnabled(env) || !query || input.memories.length <= 1) {
    return input.memories.slice(0, input.topK);
  }

  const model = getRerankModel(env);
  if (!model) return input.memories.slice(0, input.topK);

  const maxCandidates = getMaxCandidates(env);
  const candidates = input.memories.slice(0, maxCandidates);
  const request: OpenAIChatRequest = {
    model,
    messages: [
      { role: "system", content: "你是严格的 JSON 生成器。你只输出 JSON。" },
      { role: "user", content: buildPrompt({ query, memories: candidates, maxOutput: input.topK }) }
    ],
    temperature: 0,
    max_tokens: 500,
    stream: false
  };

  try {
    const response = await callOpenAICompat(env, request);
    if (!response.ok) return input.memories.slice(0, input.topK);

    const parsed = (await response.json()) as OpenAIChatResponse;
    const message = parsed.choices?.[0]?.message as ({ content?: unknown; reasoning_content?: unknown }) | undefined;
    const content = typeof message?.content === "string" ? message.content.trim() : "";
    const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "";
    const allowedIds = new Set(candidates.map((memory) => memory.id));
    const items = parseRerankItems(content || reasoning, allowedIds);
    if (!items) return input.memories.slice(0, input.topK);

    const reranked = applyRerank(candidates, items, input.topK);
    return reranked.length > 0 ? reranked : input.memories.slice(0, input.topK);
  } catch (error) {
    console.error("memory search rerank failed", error);
    return input.memories.slice(0, input.topK);
  }
}
