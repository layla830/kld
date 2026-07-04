import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, MessageRecord, OpenAIChatRequest, OpenAIChatResponse } from "../types";
import { extractJsonObject } from "../utils/jsonHelpers";
import { sanitizeMemoryContent } from "./contentSanitizer";
import {
  normalizeFactKey,
  normalizeThread,
  normalizeRiskLevel,
  normalizeUrgencyLevel,
  normalizeTensionScore,
  normalizeResponsePosture,
  normalizeValence,
  normalizeArousal
} from "./coordinates";

export interface ExtractedMemory {
  type: string;
  content: string;
  importance: number;
  confidence: number;
  tags: string[];
  source_message_ids: string[];
  fact_key?: string | null;
  thread?: string | null;
  risk_level?: string | null;
  urgency_level?: string | null;
  tension_score?: number | null;
  response_posture?: string | null;
  valence?: number | null;
  arousal?: number | null;
}

export interface MemoryExtractionResult {
  memories: ExtractedMemory[];
  summary_patch?: string;
}

function normalizeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : fallback;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function normalizeMemoryContent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = sanitizeMemoryContent(value);
  if (!text || text.length > 1000) return null;
  return text;
}

function parseExtraction(text: string): MemoryExtractionResult {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== "object") {
    return { memories: [] };
  }

  const raw = parsed as { memories?: unknown; summary_patch?: unknown };
  const memories = Array.isArray(raw.memories) ? raw.memories : [];

  return {
    summary_patch: typeof raw.summary_patch === "string" ? raw.summary_patch : undefined,
    memories: memories.flatMap((item): ExtractedMemory[] => {
      const stringContent = normalizeMemoryContent(item);
      if (stringContent) {
        return [
          {
            type: "note",
            content: stringContent,
            importance: 0.7,
            confidence: 0.8,
            tags: [],
            source_message_ids: []
          }
        ];
      }

      if (!item || typeof item !== "object") return [];
      const record = item as {
        type?: unknown;
        content?: unknown;
        importance?: unknown;
        confidence?: unknown;
        tags?: unknown;
        source_message_ids?: unknown;
        fact_key?: unknown;
        thread?: unknown;
        risk_level?: unknown;
        urgency_level?: unknown;
        tension_score?: unknown;
        response_posture?: unknown;
        valence?: unknown;
        arousal?: unknown;
      };

      const content = normalizeMemoryContent(record.content);
      if (!content) return [];

      return [
        {
          type: typeof record.type === "string" && record.type.trim() ? record.type.trim() : "note",
          content,
          importance: normalizeNumber(record.importance, 0.5),
          confidence: normalizeNumber(record.confidence, 0.8),
          tags: normalizeStringArray(record.tags),
          source_message_ids: normalizeStringArray(record.source_message_ids),
          fact_key: normalizeFactKey(record.fact_key),
          thread: normalizeThread(record.thread),
          risk_level: normalizeRiskLevel(record.risk_level),
          urgency_level: normalizeUrgencyLevel(record.urgency_level),
          tension_score: normalizeTensionScore(record.tension_score),
          response_posture: normalizeResponsePosture(record.response_posture),
          valence: normalizeValence(record.valence),
          arousal: normalizeArousal(record.arousal)
        }
      ];
    })
  };
}

function buildExtractionPrompt(messages: MessageRecord[]): string {
  const transcript = messages
    .map((message) => {
      const role = message.role === "assistant" ? "assistant" : "user";
      return `[${message.id}][${role}] ${message.content}`;
    })
    .join("\n\n");

  return [
    "你是长期记忆维护器。请从以下对话中抽取值得长期保存的信息。",
    "只输出 JSON，不要 markdown，不要解释。",
    "",
    "不要保存：",
    "- 普通寒暄",
    "- 临时语气词",
    "- 重复信息",
    "- 未明确表达的猜测",
    "- 只属于本轮 prompt 风格的临时指令",
    "- 记忆系统、debug-test、标签、测试口令等调试/后端元信息",
    "",
    "优先保存：",
    "- 用户长期偏好",
    "- 项目/计划",
    "- 重要事件",
    "- 承诺",
    "- 边界/雷点",
    "- 关系里程碑",
    "- 反复出现的习惯",
    "",
    "每条记忆可以附带 LMC-5 坐标（不确定就输出 null）：",
    "- fact_key: 稳定事实槽，格式如 project:kld_memory 或 relationship.status，不确定就 null",
    "- thread: 主题线，如 kld、relationship.boundaries、safety，不确定就 null",
    "- risk_level: low/normal/medium/high，默认 normal",
    "- urgency_level: low/normal/medium/high，默认 normal",
    "- tension_score: 0-1，话题有过张力/冲突时 >0.5，不确定就 null",
    "- valence: -1 到 1，正=愉悦，负=难受，不确定就 null",
    "- arousal: 0-1，越高越激动，不确定就 null",
    "- response_posture: 未来回应姿态，如\"直接说真实感受\"或\"comfort first\"，不确定就 null",
    "",
    "输出格式：",
    JSON.stringify({
      memories: [
        {
          type: "project",
          content: "用户正在做一个 Cloudflare Worker 项目。",
          importance: 0.86,
          confidence: 0.94,
          tags: ["project", "cloudflare"],
          fact_key: "project:cloudflare_worker",
          thread: "kld",
          risk_level: "normal",
          urgency_level: "normal",
          tension_score: null,
          valence: null,
          arousal: null,
          response_posture: null,
          source_message_ids: ["msg_x"]
        }
      ],
      summary_patch: "本轮讨论了记忆代理。"
    }),
    "",
    "对话：",
    transcript
  ].join("\n");
}

export async function extractMemoriesFromMessages(
  env: Env,
  messages: MessageRecord[]
): Promise<MemoryExtractionResult> {
  const model = env.MEMORY_EXTRACT_MODEL || env.MEMORY_MODEL;
  if (!model || messages.length === 0) {
    return { memories: [] };
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
        content: buildExtractionPrompt(messages)
      }
    ],
    temperature: 0,
    max_tokens: 900,
    stream: false
  };

  const response = await callOpenAICompat(env, request);
  if (!response.ok) {
    return { memories: [] };
  }

  const parsed = (await response.json()) as OpenAIChatResponse;
  const message = parsed.choices?.[0]?.message as
    | ({ content?: unknown; reasoning_content?: unknown })
    | undefined;
  const content = typeof message?.content === "string" ? message.content.trim() : "";
  const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "";
  return parseExtraction(content || reasoning);
}
