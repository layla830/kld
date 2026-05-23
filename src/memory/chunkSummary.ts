import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, MessageRecord } from "../types";
import { extractJsonObject } from "../utils/jsonHelpers";
import type { ChunkSummary } from "./chunkTypes";
import { formatShanghaiDateTime, messageTime } from "./chunkPeriods";

const DEFAULT_SUMMARY_MODEL = "deepseek/deepseek-v4-pro";
const FALLBACK_WORKERS_SUMMARY_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const SUMMARY_MAX_TOKENS = 900;

function formatTranscript(messages: MessageRecord[]): string {
  return messages.map((message) => {
    const role = message.role || "message";
    const timestamp = formatShanghaiDateTime(messageTime(message));
    return `[${role} ${timestamp}] ${message.content}`;
  }).join("\n");
}

function fallbackSummary(messages: MessageRecord[]): ChunkSummary {
  const text = messages.map((message) => message.content).join("\n").replace(/\s+/g, " ").trim();
  const summary = text.slice(0, 600) || "这段时间的对话没有足够内容可总结。";
  return {
    summary,
    keywords: summary.split(/[，。,.!?！？\s]+/).filter(Boolean).slice(0, 5),
    emotion: "neutral"
  };
}

function readWorkersAiText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const data = result as { response?: unknown; result?: unknown };
  if (typeof data.response === "string") return data.response;
  if (typeof data.result === "string") return data.result;
  return "";
}

function readOpenAICompatText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const data = result as { choices?: Array<{ message?: { content?: unknown }; text?: unknown }> };
  const choice = data.choices?.[0];
  if (typeof choice?.message?.content === "string") return choice.message.content;
  if (typeof choice?.text === "string") return choice.text;
  return "";
}

async function runSummaryModel(env: Env, model: string, prompt: string): Promise<string> {
  try {
    if (model.startsWith("@cf/")) {
      if (!env.AI) return "";
      const result = await env.AI.run(model as any, { prompt, max_tokens: SUMMARY_MAX_TOKENS, temperature: 0.2 });
      return readWorkersAiText(result);
    }

    const response = await callOpenAICompat(env, {
      model,
      messages: [
        {
          role: "system",
          content: "你是严格的 JSON 生成器。你只输出 JSON。"
        },
        {
          role: "user",
          content: prompt
        }
      ],
      max_tokens: SUMMARY_MAX_TOKENS,
      temperature: 0.2,
      stream: false
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error("auto diary summary model failed", { model, status: response.status, body: body.slice(0, 300) });
      return "";
    }
    return readOpenAICompatText(await response.json());
  } catch (error) {
    console.error("auto diary summary model error", { model, error });
    return "";
  }
}

function parseSummary(text: string, fallback: ChunkSummary): ChunkSummary | null {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== "object") return null;

  const raw = parsed as { summary?: unknown; keywords?: unknown; emotion?: unknown };
  const summary = typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : "";
  if (!summary) return null;

  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 5)
    : fallback.keywords;
  const emotion = typeof raw.emotion === "string" && raw.emotion.trim() ? raw.emotion.trim() : fallback.emotion;

  return { summary, keywords: keywords.length > 0 ? keywords : fallback.keywords, emotion };
}

function buildSummaryPrompt(messages: MessageRecord[], periodLabel: string): string {
  const transcript = formatTranscript(messages).slice(0, 12000);
  return `请把下面这一整段聊天窗口整理成一则中文日记式记忆。\n时间段：${periodLabel}（东八区）。\n要求：\n- 不是逐条流水账，也不是一句话概括。\n- 用第一人称或贴近日记的叙述，保留具体事件、关系、情绪变化、决定和待办。\n- 忽略无意义寒暄、重复催促、工具噪音。\n- 如果内容很少，也要说明上下文不足，不要编造。\n- 输出 JSON，格式：{"summary":"...","keywords":["..."],"emotion":"..."}\n\n聊天窗口：\n${transcript}`;
}

export async function summarizeChunk(env: Env, messages: MessageRecord[], periodLabel: string): Promise<ChunkSummary | null> {
  const fallback = fallbackSummary(messages);
  const model = env.AUTO_CHUNK_SUMMARY_MODEL || env.MEMORY_FILTER_MODEL || env.CHAT_MODEL || DEFAULT_SUMMARY_MODEL;
  const prompt = buildSummaryPrompt(messages, periodLabel);

  const primary = parseSummary(await runSummaryModel(env, model, prompt), fallback);
  if (primary) return primary;

  if (!model.startsWith("@cf/")) {
    const backup = parseSummary(await runSummaryModel(env, FALLBACK_WORKERS_SUMMARY_MODEL, prompt), fallback);
    if (backup) return backup;
  }

  console.error("auto diary summary unavailable; leaving messages unprocessed", {
    conversationId: messages[0]?.conversation_id,
    fromMessageId: messages[0]?.id,
    toMessageId: messages[messages.length - 1]?.id,
    messageCount: messages.length
  });
  return null;
}
