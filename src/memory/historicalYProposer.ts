import { readAssistantTexts } from "../adapters/llm/assistantText";
import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, MemoryRecord, OpenAIChatRequest, OpenAIChatResponse } from "../types";
import { extractJsonObject } from "../utils/jsonHelpers";
import type { RelationCandidate } from "./fiveAxis/yRelations";

export const HISTORICAL_Y_CONTENT_LIMIT = 200;
const HISTORICAL_Y_MAX_TOKENS = 4096;

export interface HistoricalYRelationHint {
  pair_id: string;
  relation_type: string;
  strength: number | null;
}

export interface HistoricalYProposalResult {
  hints: HistoricalYRelationHint[];
  error?: string;
}

export function historicalYContentExcerpt(memory: Pick<MemoryRecord, "content">): string {
  return memory.content.slice(0, HISTORICAL_Y_CONTENT_LIMIT);
}

function historicalRelationModel(env: Env, modelOverride?: string): string | null {
  const value = modelOverride?.trim()
    || env.DREAM_MODEL?.trim()
    || env.MEMORY_MODEL?.trim()
    || env.MEMORY_EXTRACT_MODEL?.trim();
  return value || null;
}

export function buildHistoricalYPrompt(candidates: RelationCandidate[]): string {
  const pairs = candidates.map((candidate) => ({
    pair_id: candidate.pairId,
    a_id: candidate.source.id,
    a_type: candidate.source.type,
    a_created_at: candidate.source.created_at,
    a: historicalYContentExcerpt(candidate.source),
    b_id: candidate.target.id,
    b_type: candidate.target.type,
    b_created_at: candidate.target.created_at,
    b: historicalYContentExcerpt(candidate.target)
  }));
  return [
    "你是 kld 历史记忆关系复核器。给定已存在的关系端点，独立判断每一对的关系类型。",
    "只输出一个紧凑 JSON 对象，不要 markdown、解释或 reason 字段。每个 pair_id 必须恰好返回一项。",
    "输出格式：{\"hints\":[{\"pair_id\":\"...\",\"relation_type\":\"same_topic\",\"strength\":0.7}]}",
    "若没有足够关系，也必须返回该 pair_id，relation_type 使用 none，strength 使用 null。",
    "",
    "允许类型：same_issue, same_project, same_tool, same_event, same_topic, emotional_link, in_thread, same_person, in_episode, instance_of, derived_from, same_fact_key, origin_split, none。",
    "时间先后关系由 X 轴维护，绝不输出 temporal_sequence。",
    "same_event 表示同一具体事件的两条记录；same_topic 表示同主题但不是同一事件。",
    "",
    "derived_from 是有方向的来源断言：目标 B 是从来源 A 提炼、总结或拆分出来的。",
    "没有明确来源证据不得输出 derived_from，也不得仅凭内容相似猜测来源。",
    "可接受证据：B 明确总结、引用或列举 A 的具体事件内容，或 B 明确说明它是从 A 得出的 lesson/rule。",
    "不构成证据：同主题、共享原则或关键词、总则与细则、共享 fact_key、两条独立整合的 rule。此时最多使用 same_topic/same_issue。",
    "合成正例：A 是一条原始事故记录；B 引用 A 的具体事实并明确说明这是从该事故总结的 lesson，则 A→B 可为 derived_from。",
    "合成反例：规则 A 与规则 B 共享一句原则，但它们是并列整合规则，没有提炼证据，应为 same_topic，不是 derived_from。",
    "合成反例：A 是一个行为模式 lesson，B 是后来发生的一次该模式实例；不能声称事件 B 从 lesson A 提炼。若语义成立应考虑 instance_of，而不是 derived_from。",
    "不确定时优先 none 或非来源型关系，绝不猜测 provenance。",
    "",
    "候选对：",
    JSON.stringify(pairs)
  ].join("\n");
}

function parseHistoricalHints(value: unknown): HistoricalYRelationHint[] | null {
  const rawHints = value && typeof value === "object"
    ? (value as { hints?: unknown }).hints
    : null;
  if (!Array.isArray(rawHints)) return null;
  const hints: HistoricalYRelationHint[] = [];
  const seenPairIds = new Set<string>();
  for (const item of rawHints) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const pairId = typeof record.pair_id === "string" ? record.pair_id.trim() : "";
    const relationType = typeof record.relation_type === "string"
      ? record.relation_type.trim()
      : "";
    if (!pairId || !relationType) continue;
    if (seenPairIds.has(pairId)) return null;
    seenPairIds.add(pairId);
    hints.push({
      pair_id: pairId,
      relation_type: relationType,
      strength: relationType.toLowerCase() === "none"
        ? null
        : typeof record.strength === "number"
          ? Math.min(Math.max(record.strength, 0), 1)
          : 0.6
    });
  }
  return hints;
}

export async function proposeHistoricalYRelations(
  env: Env,
  candidates: RelationCandidate[],
  modelOverride?: string
): Promise<HistoricalYProposalResult> {
  if (candidates.length === 0) return { hints: [] };
  const model = historicalRelationModel(env, modelOverride);
  if (!model) return { hints: [], error: "missing_model" };

  const basePrompt = buildHistoricalYPrompt(candidates);
  let lastError = "invalid_json";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const request: OpenAIChatRequest = {
      model,
      messages: [
        { role: "system", content: "你是严格的 JSON 生成器。只输出一个完整 JSON 对象。" },
        {
          role: "user",
          content: attempt === 0
            ? basePrompt
            : `${basePrompt}\n\nThe previous response was invalid. Return one compact, complete JSON object with exactly one hint per pair_id and no prose.`
        }
      ],
      temperature: 0,
      max_tokens: HISTORICAL_Y_MAX_TOKENS,
      response_format: { type: "json_object" },
      stream: false
    };
    try {
      const response = await callOpenAICompat(env, request);
      if (!response.ok) {
        lastError = `model_status_${response.status}`;
        if (attempt === 0 && response.status >= 500) continue;
        return { hints: [], error: lastError };
      }
      const parsed = (await response.json()) as OpenAIChatResponse;
      const hints = readAssistantTexts(parsed)
        .map((text) => parseHistoricalHints(extractJsonObject(text)))
        .find((value) => value !== null) ?? null;
      if (!hints) {
        lastError = "invalid_json";
        continue;
      }
      return { hints };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt === 0) continue;
    }
  }
  return { hints: [], error: lastError };
}
