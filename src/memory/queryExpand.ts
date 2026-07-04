import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, MemoryApiRecord, OpenAIChatRequest, OpenAIChatResponse } from "../types";
import { extractJsonObject } from "../utils/jsonHelpers";

const QUERY_EXPAND_MAX_TOKENS = 300;

export function isQueryExpansionEnabled(env: Env): boolean {
  return env.ENABLE_QUERY_EXPANSION === "true";
}

export function getQueryExpandModel(env: Env): string | null {
  return env.QUERY_EXPAND_MODEL || env.MEMORY_MODEL || env.DREAM_MODEL || null;
}

export async function expandQueryAngles(env: Env, query: string): Promise<string[]> {
  if (!isQueryExpansionEnabled(env)) return [query];
  const model = getQueryExpandModel(env);
  if (!model) return [query];

  const request: OpenAIChatRequest = {
    model,
    messages: [
      { role: "system", content: "你是严格的 JSON 生成器。只输出 JSON。" },
      {
        role: "user",
        content: [
          "把用户查询改写成 2-4 个搜索角度，包括同义词、相关概念、情绪词。",
          "只输出 JSON，格式：",
          JSON.stringify({ angles: ["角度1", "角度2", "角度3"] }),
          "",
          "查询：",
          query
        ].join("\n")
      }
    ],
    temperature: 0,
    max_tokens: QUERY_EXPAND_MAX_TOKENS,
    response_format: { type: "json_object" },
    stream: false
  };

  try {
    const response = await callOpenAICompat(env, request);
    if (!response.ok) return [query];
    const parsed = (await response.json()) as OpenAIChatResponse;
    const content = (parsed.choices?.[0]?.message as { content?: unknown })?.content;
    const json = extractJsonObject(typeof content === "string" ? content : "");
    if (!json || typeof json !== "object") return [query];
    const angles = (json as { angles?: unknown }).angles;
    if (!Array.isArray(angles)) return [query];
    const expanded = [query, ...angles.filter((a): a is string => typeof a === "string" && a.trim().length > 0).map((a) => a.trim())];
    return [...new Set(expanded)].slice(0, 5);
  } catch {
    return [query];
  }
}

const RERANK_MAX_TOKENS = 600;

export function isRerankEnabled(env: Env): boolean {
  return env.ENABLE_RERANK === "true";
}

export function getRerankModel(env: Env): string | null {
  return env.RERANK_MODEL || env.MEMORY_MODEL || env.DREAM_MODEL || null;
}

export async function rerankMemories(
  env: Env,
  input: { query: string; memories: MemoryApiRecord[]; topK: number }
): Promise<MemoryApiRecord[]> {
  if (!isRerankEnabled(env) || input.memories.length <= 1) return input.memories.slice(0, input.topK);
  const model = getRerankModel(env);
  if (!model) return input.memories.slice(0, input.topK);

  const candidates = input.memories.slice(0, Math.min(input.memories.length, 20)).map((m) => ({
    id: m.id,
    type: m.type,
    content: m.content.slice(0, 200),
    importance: m.importance,
    score: m.score
  }));

  const request: OpenAIChatRequest = {
    model,
    messages: [
      { role: "system", content: "你是严格的 JSON 生成器。只输出 JSON。" },
      {
        role: "user",
        content: [
          "根据用户查询，对以下记忆按相关性重新排序。最相关的排最前。",
          "只输出 JSON，格式：",
          JSON.stringify({ ranked_ids: ["mem_x", "mem_y", "mem_z"] }),
          "",
          "用户查询：",
          input.query,
          "",
          "候选记忆：",
          JSON.stringify(candidates)
        ].join("\n")
      }
    ],
    temperature: 0,
    max_tokens: RERANK_MAX_TOKENS,
    response_format: { type: "json_object" },
    stream: false
  };

  try {
    const response = await callOpenAICompat(env, request);
    if (!response.ok) return input.memories.slice(0, input.topK);
    const parsed = (await response.json()) as OpenAIChatResponse;
    const content = (parsed.choices?.[0]?.message as { content?: unknown })?.content;
    const json = extractJsonObject(typeof content === "string" ? content : "");
    if (!json || typeof json !== "object") return input.memories.slice(0, input.topK);
    const rankedIds = (json as { ranked_ids?: unknown }).ranked_ids;
    if (!Array.isArray(rankedIds)) return input.memories.slice(0, input.topK);

    const idOrder = new Map<string, number>();
    rankedIds.forEach((id, index) => {
      if (typeof id === "string") idOrder.set(id, index);
    });

    const reordered = [...input.memories].sort((a, b) => {
      const aRank = idOrder.has(a.id) ? idOrder.get(a.id)! : 999;
      const bRank = idOrder.has(b.id) ? idOrder.get(b.id)! : 999;
      if (aRank !== bRank) return aRank - bRank;
      return (b.score ?? 0) - (a.score ?? 0);
    });

    return reordered.slice(0, input.topK);
  } catch {
    return input.memories.slice(0, input.topK);
  }
}
