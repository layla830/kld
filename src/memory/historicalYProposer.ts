import { readAssistantParts } from "../adapters/llm/assistantText";
import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, MemoryRecord, OpenAIChatRequest, OpenAIChatResponse } from "../types";
import { extractJsonObject } from "../utils/jsonHelpers";
import type { RelationCandidate } from "./fiveAxis/yRelations";

export const HISTORICAL_Y_CONTENT_LIMIT = 200;
const HISTORICAL_Y_MAX_TOKENS = 4096;

/**
 * Semantic relation types the model is allowed to output.
 *
 * Structural types (in_thread, same_fact_key, origin_split) are excluded —
 * those are decided deterministically from record fields, never by the model.
 */
const SEMANTIC_RELATION_TYPES = new Set<string>(
  [
    "same_issue",
    "same_project",
    "same_tool",
    "same_event",
    "same_topic",
    "emotional_link",
    "same_person",
    "in_episode",
    "instance_of",
    "derived_from",
    "none"
  ]
);

export interface HistoricalYRelationHint {
  pair_id: string;
  relation_type: string;
  strength: number | null;
}

/**
 * Per-attempt telemetry recorded for every model call.  Never contains prompt
 * text, memory content, or completion text — only structured features.
 *
 * See: spec §2.1
 */
export interface HistoricalYAttemptTelemetry {
  attempt_index: number;
  model: string | null;
  batch_id: string | null;
  http_status: number | null;
  elapsed_ms: number;
  finish_reason: string | null;
  usage: {
    prompt_tokens: number | null;
    completion_tokens: number | null;
    total_tokens: number | null;
    reasoning_tokens: number | null;
  };
  content_chars: number;
  reasoning_chars: number | null;
  parse_outcome: string;
}

export interface HistoricalYProposalResult {
  hints: HistoricalYRelationHint[];
  error?: string;
  attempts?: HistoricalYAttemptTelemetry[];
  modelCalled?: boolean;
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
    "允许类型：same_issue, same_project, same_tool, same_event, same_topic, emotional_link, same_person, in_episode, instance_of, derived_from, none。",
    "时间先后关系由 X 轴维护，绝不输出 temporal_sequence。",
    "in_thread、same_fact_key、origin_split 由系统从记录字段判定，证据不在模型输入中，模型不得输出这三个类型。",
    "same_event 表示同一具体事件的两条记录；same_topic 表示同主题但不是同一事件。",
    "",
    "instance_of 是有方向的：起点 A 是终点 B 概念的一个具体实例。方向不明时不得输出 instance_of。",
    "合成正例：A 是一次具体争吵记录；B 是关于『争吵模式』的认知 rule，则 A→B 可为 instance_of。",
    "合成反例：A 和 B 都是独立整合的 rule，共享主题但没有实例归属关系，应为 same_topic，不是 instance_of。",
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

/**
 * Parse the model's JSON response strictly.
 *
 * Returns `{ hints, parseOutcome }`.  When `parseOutcome` is not `"ok"`,
 * `hints` is null and the attempt is considered failed.
 *
 * `missing_pair` is NOT a parse outcome — the parser succeeds (ok) even if
 * some requested pair_ids are absent; missing_pair is detected by the writer.
 */
function parseHistoricalHints(
  value: unknown,
  requestedPairIds: Set<string>
): { hints: HistoricalYRelationHint[] | null; parseOutcome: string } {
  if (!value || typeof value !== "object") {
    return { hints: null, parseOutcome: "no_json_object" };
  }
  const rawHints = (value as { hints?: unknown }).hints;
  if (!Array.isArray(rawHints)) {
    return { hints: null, parseOutcome: "hints_array_invalid" };
  }
  if (rawHints.length === 0) {
    return { hints: null, parseOutcome: "empty_choices" };
  }
  const hints: HistoricalYRelationHint[] = [];
  const seenPairIds = new Set<string>();
  for (const item of rawHints) {
    if (!item || typeof item !== "object") {
      return { hints: null, parseOutcome: "malformed_hint" };
    }
    const record = item as Record<string, unknown>;
    const pairId = typeof record.pair_id === "string" ? record.pair_id.trim() : "";
    const relationType = typeof record.relation_type === "string"
      ? record.relation_type.trim()
      : "";
    if (!pairId || !relationType) {
      return { hints: null, parseOutcome: "malformed_hint" };
    }
    if (!SEMANTIC_RELATION_TYPES.has(relationType)) {
      return { hints: null, parseOutcome: "out_of_vocabulary_type" };
    }
    if (!requestedPairIds.has(pairId)) {
      return { hints: null, parseOutcome: "unknown_pair_id" };
    }
    if (seenPairIds.has(pairId)) {
      return { hints: null, parseOutcome: "duplicate_pair_id" };
    }
    seenPairIds.add(pairId);

    const isNone = relationType.toLowerCase() === "none";
    if (isNone) {
      hints.push({ pair_id: pairId, relation_type: relationType, strength: null });
    } else if (typeof record.strength === "number" && Number.isFinite(record.strength)) {
      hints.push({
        pair_id: pairId,
        relation_type: relationType,
        strength: Math.min(Math.max(record.strength, 0), 1)
      });
    } else {
      return { hints: null, parseOutcome: "malformed_hint" };
    }
  }
  return { hints, parseOutcome: "ok" };
}

/**
 * Extract usage fields via a numeric whitelist.  Never passes the raw upstream
 * object through; missing fields become explicit nulls.
 */
function extractUsage(raw: unknown): HistoricalYAttemptTelemetry["usage"] {
  const u = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const details = typeof u.completion_tokens_details === "object" && u.completion_tokens_details
    ? u.completion_tokens_details as Record<string, unknown>
    : {};
  return {
    prompt_tokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : null,
    completion_tokens: typeof u.completion_tokens === "number" ? u.completion_tokens : null,
    total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : null,
    reasoning_tokens: typeof details.reasoning_tokens === "number" ? details.reasoning_tokens : null
  };
}

function logTelemetry(telemetry: HistoricalYAttemptTelemetry): void {
  console.log(JSON.stringify({
    event: "historical_y_attempt",
    ...telemetry
  }));
}

export async function proposeHistoricalYRelations(
  env: Env,
  candidates: RelationCandidate[],
  modelOverride?: string,
  batchId?: string
): Promise<HistoricalYProposalResult> {
  if (candidates.length === 0) return { hints: [], attempts: [], modelCalled: false };
  const model = historicalRelationModel(env, modelOverride);
  if (!model) return { hints: [], error: "missing_model", attempts: [], modelCalled: false };

  const requestedPairIds = new Set(candidates.map((candidate) => candidate.pairId));
  const basePrompt = buildHistoricalYPrompt(candidates);
  const attempts: HistoricalYAttemptTelemetry[] = [];
  let lastError = "invalid_json";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const attemptStart = Date.now();
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

    let telemetry: HistoricalYAttemptTelemetry;

    try {
      const response = await callOpenAICompat(env, request);
      const elapsedMs = Date.now() - attemptStart;

      if (!response.ok) {
        lastError = `model_status_${response.status}`;
        telemetry = {
          attempt_index: attempt,
          model,
          batch_id: batchId ?? null,
          http_status: response.status,
          elapsed_ms: elapsedMs,
          finish_reason: null,
          usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null, reasoning_tokens: null },
          content_chars: 0,
          reasoning_chars: null,
          parse_outcome: "http_error"
        };
        attempts.push(telemetry);
        logTelemetry(telemetry);
        if (attempt === 0 && response.status >= 500) continue;
        return { hints: [], error: lastError, attempts, modelCalled: true };
      }

      const parsed = (await response.json()) as OpenAIChatResponse;
      const { content: contentText, reasoning: reasoningText } = readAssistantParts(parsed);

      const extractedJson = extractJsonObject(contentText);
      const { hints, parseOutcome } = parseHistoricalHints(extractedJson, requestedPairIds);

      const finishReason = parsed.choices?.[0]?.finish_reason ?? null;
      const usage = extractUsage(parsed.usage);

      telemetry = {
        attempt_index: attempt,
        model,
        batch_id: batchId ?? null,
        http_status: response.status,
        elapsed_ms: elapsedMs,
        finish_reason: typeof finishReason === "string" ? finishReason : null,
        usage,
        content_chars: contentText.length,
        reasoning_chars: reasoningText.length > 0 ? reasoningText.length : null,
        parse_outcome: hints ? "ok" : parseOutcome
      };
      attempts.push(telemetry);
      logTelemetry(telemetry);

      if (!hints) {
        lastError = "invalid_json";
        continue;
      }
      return { hints, attempts, modelCalled: true };
    } catch (error) {
      const elapsedMs = Date.now() - attemptStart;
      lastError = error instanceof Error ? error.message : String(error);
      telemetry = {
        attempt_index: attempt,
        model,
        batch_id: batchId ?? null,
        http_status: null,
        elapsed_ms: elapsedMs,
        finish_reason: null,
        usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null, reasoning_tokens: null },
        content_chars: 0,
        reasoning_chars: null,
        parse_outcome: "exception"
      };
      attempts.push(telemetry);
      logTelemetry(telemetry);
      if (attempt === 0) continue;
    }
  }
  return { hints: [], error: lastError, attempts, modelCalled: true };
}
