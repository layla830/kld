import { createMemory, getMemoryById, updateMemory } from "../db/memories";
import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, MemoryApiRecord, MemoryRecord, OpenAIChatRequest, OpenAIChatResponse } from "../types";
import { extractJsonObject, parseJsonStringArray } from "../utils/jsonHelpers";
import { upsertMemoryEmbedding } from "./embedding";
import type { ExtractedMemory } from "./extract";
import { searchMemories } from "./search";

const MERGE_CANDIDATE_TOP_K = 5;
const MERGE_SCORE_THRESHOLD = 0.82;
const CORRECTION_PATTERN = /(之前|刚才|上次).{0,12}(说错|记错|错了|不是|改成|更正)|不是.+是|应(?:该)?改为|改成/;

type MergeAction = "keep_both" | "merge" | "supersede";

interface MemoryMergeDecision {
  action: MergeAction;
  target_id?: string;
  content?: string;
  type?: string;
  importance?: number;
  confidence?: number;
  tags?: string[];
}

interface PersistMemoryInput {
  namespace: string;
  memory: ExtractedMemory;
  source: string;
  sourceMessageIds: string[];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clampScore(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : fallback;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

function isCorrection(text: string): boolean {
  return CORRECTION_PATTERN.test(text);
}

function parseDecision(text: string): MemoryMergeDecision | null {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== "object") return null;

  const raw = parsed as {
    action?: unknown;
    target_id?: unknown;
    content?: unknown;
    type?: unknown;
    importance?: unknown;
    confidence?: unknown;
    tags?: unknown;
  };

  if (raw.action !== "keep_both" && raw.action !== "merge" && raw.action !== "supersede") {
    return null;
  }

  return {
    action: raw.action,
    target_id: typeof raw.target_id === "string" ? raw.target_id : undefined,
    content: typeof raw.content === "string" && raw.content.trim() ? raw.content.trim() : undefined,
    type: typeof raw.type === "string" && raw.type.trim() ? raw.type.trim() : undefined,
    importance: typeof raw.importance === "number" && Number.isFinite(raw.importance) ? raw.importance : undefined,
    confidence: typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? raw.confidence : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === "string") : undefined
  };
}

function chooseFallbackDecision(
  incoming: ExtractedMemory,
  candidates: MemoryApiRecord[]
): MemoryMergeDecision {
  const target = candidates.find((candidate) => !candidate.pinned);
  if (!target) return { action: "keep_both" };

  if (isCorrection(incoming.content)) {
    return {
      action: "supersede",
      target_id: target.id,
      content: incoming.content,
      type: incoming.type,
      importance: incoming.importance,
      confidence: incoming.confidence,
      tags: incoming.tags
    };
  }

  return { action: "keep_both" };
}

function buildMergePrompt(input: { incoming: ExtractedMemory; candidates: MemoryApiRecord[] }): string {
  const candidates = input.candidates.map((candidate) => ({
    id: candidate.id,
    type: candidate.type,
    content: candidate.content,
    importance: candidate.importance,
    confidence: candidate.confidence,
    pinned: candidate.pinned,
    tags: candidate.tags,
    score: candidate.score
  }));

  return [
    "你是长期记忆去重与纠错器。请判断一条新记忆和候选旧记忆之间的关系。",
    "只输出 JSON，不要 markdown，不要解释。",
    "",
    "规则：",
    "- 如果新记忆和旧记忆表达同一稳定事实/偏好且兼容，action=merge。",
    "- 如果新记忆明确纠正旧记忆，例如“之前说错了”“不是 X 是 Y”“改成 Y”，action=supersede。",
    "- 如果不确定、只是主题相近、或会丢失细节，action=keep_both。",
    "- pinned=true 的候选记忆不能被 merge 或 supersede，只能 keep_both。",
    "- 不要添加输入里没有的新事实。",
    "",
    "输出格式：",
    JSON.stringify({
      action: "merge",
      target_id: "mem_x",
      content: "合并后的记忆正文",
      type: "preference",
      importance: 0.8,
      confidence: 0.9,
      tags: ["preference"]
    }),
    "",
    `新记忆：${JSON.stringify(input.incoming)}`,
    "",
    `候选旧记忆：${JSON.stringify(candidates)}`
  ].join("\n");
}

async function decideMemoryMerge(
  env: Env,
  incoming: ExtractedMemory,
  candidates: MemoryApiRecord[]
): Promise<MemoryMergeDecision> {
  const model = env.MEMORY_MERGE_MODEL || env.MEMORY_MODEL;
  if (!model || candidates.length === 0) {
    return chooseFallbackDecision(incoming, candidates);
  }

  const request: OpenAIChatRequest = {
    model,
    messages: [
      {
        role: "system",
        content: "你是严格的 JSON 生成器。你只输出 JSON。"
      },
      {
        role: "user",
        content: buildMergePrompt({ incoming, candidates })
      }
    ],
    temperature: 0,
    max_tokens: 700,
    stream: false
  };

  try {
    const response = await callOpenAICompat(env, request);
    if (!response.ok) return chooseFallbackDecision(incoming, candidates);

    const parsed = (await response.json()) as OpenAIChatResponse;
    const message = parsed.choices?.[0]?.message as
      | ({ content?: unknown; reasoning_content?: unknown })
      | undefined;
    const content = typeof message?.content === "string" ? message.content.trim() : "";
    const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "";
    return parseDecision(content || reasoning) ?? chooseFallbackDecision(incoming, candidates);
  } catch (error) {
    console.error("memory merge decision failed", error);
    return chooseFallbackDecision(incoming, candidates);
  }
}

async function findMergeCandidates(
  env: Env,
  input: { namespace: string; memory: ExtractedMemory }
): Promise<MemoryApiRecord[]> {
  const result = await searchMemories(env, {
    namespace: input.namespace,
    query: input.memory.content,
    topK: MERGE_CANDIDATE_TOP_K
  });
  if (result.status === "degraded") throw new Error("memory_merge_search_degraded");

  const incomingText = normalizeText(input.memory.content);
  return result.records.filter((match) => {
    if (match.status !== "active") return false;
    if (normalizeText(match.content) === incomingText) return true;
    return typeof match.score === "number" && match.score >= MERGE_SCORE_THRESHOLD;
  });
}

async function createNewMemory(env: Env, input: PersistMemoryInput): Promise<MemoryRecord> {
  const created = await createMemory(env.DB, {
    namespace: input.namespace,
    type: input.memory.type,
    content: input.memory.content,
    importance: input.memory.importance,
    confidence: input.memory.confidence,
    tags: input.memory.tags,
    source: input.source,
    sourceMessageIds: input.sourceMessageIds
  });

  await upsertMemoryEmbedding(env, created);
  return created;
}

function resolveTarget(decision: MemoryMergeDecision, candidates: MemoryApiRecord[]): MemoryApiRecord | null {
  if (decision.target_id) {
    return candidates.find((candidate) => candidate.id === decision.target_id) ?? null;
  }
  return candidates.find((candidate) => !candidate.pinned) ?? null;
}

export async function persistMemoryWithMerge(
  env: Env,
  input: PersistMemoryInput
): Promise<MemoryRecord | null> {
  const candidates = await findMergeCandidates(env, { namespace: input.namespace, memory: input.memory });

  if (candidates.length === 0) return createNewMemory(env, input);

  const decision = await decideMemoryMerge(env, input.memory, candidates);
  if ((decision.action === "merge" || decision.action === "supersede") && !decision.target_id) {
    return createNewMemory(env, input);
  }

  const target = resolveTarget(decision, candidates);
  if (!target || decision.action === "keep_both" || target.pinned) {
    return createNewMemory(env, input);
  }

  const existing = await getMemoryById(env.DB, { namespace: input.namespace, id: target.id });
  if (!existing || existing.status !== "active" || existing.pinned) {
    return createNewMemory(env, input);
  }

  if (decision.action === "merge") {
    if (!decision.content) return createNewMemory(env, input);

    const merged = await updateMemory(env.DB, {
      namespace: input.namespace,
      id: existing.id,
      expectedStatus: "active",
      requireUnpinned: true,
      patch: {
        type: decision.type ?? input.memory.type ?? existing.type,
        content: decision.content,
        importance: Math.max(existing.importance, clampScore(decision.importance, input.memory.importance)),
        confidence: Math.max(existing.confidence, clampScore(decision.confidence, input.memory.confidence)),
        tags: uniqueStrings([...parseJsonStringArray(existing.tags), ...input.memory.tags, ...(decision.tags ?? [])]),
        sourceMessageIds: uniqueStrings([...parseJsonStringArray(existing.source_message_ids), ...input.sourceMessageIds])
      }
    });

    if (!merged) return createNewMemory(env, input);
    await upsertMemoryEmbedding(env, merged);
    return merged;
  }

  if (decision.action === "supersede") {
    const replacement = {
      type: decision.type ?? input.memory.type ?? existing.type,
      content: decision.content ?? input.memory.content,
      importance: clampScore(decision.importance, input.memory.importance),
      confidence: clampScore(decision.confidence, input.memory.confidence),
      tags: uniqueStrings([...input.memory.tags, ...(decision.tags ?? [])]),
      fact_key: input.memory.fact_key ?? existing.fact_key ?? null,
      source: input.source,
      source_message_ids: input.sourceMessageIds
    };
    return createMemory(env.DB, {
      namespace: input.namespace,
      type: "dream_review",
      content: `发现一条可能需要替换的旧记忆，请核对新旧内容后决定。`,
      summary: JSON.stringify({
        kind: "dream_review",
        action: "supersede",
        target_id: existing.id,
        target: {
          id: existing.id,
          type: existing.type,
          content: existing.content,
          fact_key: existing.fact_key,
          status: existing.status
        },
        replacement,
        reason: "写入时发现新内容可能替代旧事实。批准前不会修改旧记忆，也不会把新内容写成 active 记忆。",
        decision
      }),
      importance: Math.max(existing.importance, replacement.importance),
      confidence: replacement.confidence,
      status: "active",
      pinned: false,
      tags: ["pending-review", "supersede-review", "merge-review"],
      source: "merge-review",
      sourceMessageIds: input.sourceMessageIds,
      expiresAt: null
    });
  }

  return createNewMemory(env, input);
}
