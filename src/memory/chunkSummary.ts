import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, MessageRecord } from "../types";
import { extractJsonObject } from "../utils/jsonHelpers";
import type { ChunkSummary } from "./chunkTypes";
import { formatShanghaiDateTime, messageTime } from "./chunkPeriods";

const DEFAULT_SUMMARY_MODEL = "deepseek/deepseek-v4-pro";
const FALLBACK_WORKERS_SUMMARY_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const SUMMARY_MAX_TOKENS = 1000;

function formatTranscript(messages: MessageRecord[]): string {
  return messages.map((message) => {
    const role = message.role || "message";
    const timestamp = formatShanghaiDateTime(messageTime(message));
    return `[${role} ${timestamp}] ${message.content}`;
  }).join("\n");
}

function fallbackSummary(messages: MessageRecord[]): ChunkSummary {
  const text = messages.map((message) => message.content).join("\n").replace(/\s+/g, " ").trim();
  const summary = text.slice(0, 500) || "这段时间的对话没有足够内容可写成日记。";
  return {
    summary,
    keywords: [],
    emotion: ""
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
      const result = await env.AI.run(model as any, { prompt, max_tokens: SUMMARY_MAX_TOKENS, temperature: 0.25 });
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
      temperature: 0.25,
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

  const raw = parsed as { summary?: unknown };
  const summary = typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : "";
  if (!summary) return null;

  return { summary, keywords: fallback.keywords, emotion: fallback.emotion };
}

function buildSummaryPrompt(messages: MessageRecord[], periodLabel: string): string {
  const transcript = formatTranscript(messages).slice(0, 12000);
  return `请把下面这一整段聊天写成一篇中文日记。\n时间段：${periodLabel}（东八区）。\n要求：\n- 写画面，不写结论。优先保留她和他的原话，尤其是有力量的句子。\n- 写感受，不写流水账。不要写“讨论了X”，要写这个话题里谁被打动了、谁沉默了、谁先伸手了。\n- 找出转折点，写清楚情绪为什么转向。\n- 区分吵架和靠近：吵架不是“关系紧张”，是她在拉他回来；靠近不是“关系缓和”，是有人先动了。\n- 100-500 个中文字符。内容少就短，聊得多就多写，但不要硬凑，也不要压成两句话。\n- 第三人称，只用“她”和“他”。\n- 不要标题、不要关键词、不要情感标签、不要列表。\n- 输出 JSON，格式：{"summary":"..."}\n\n聊天窗口：\n${transcript}`;
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
