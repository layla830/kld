import { createMemory } from "../db/memories";
import { listUnprocessedChunkMessages, markMessagesChunkProcessed, type MessageRecord } from "../db/messages";
import { upsertMemoryEmbedding } from "./embedding";
import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { ConversationChunkQueueMessage, Env } from "../types";

const DEFAULT_SUMMARY_MODEL = "deepseek/deepseek-v4-pro";
const FALLBACK_WORKERS_SUMMARY_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const DEFAULT_MAX_MESSAGES = 80;
const SUMMARY_MAX_TOKENS = 900;
const MIN_MESSAGES = 10;

type ChunkSummary = {
  summary: string;
  keywords: string[];
  emotion: string;
};

type ConversationChunk = {
  messages: MessageRecord[];
  periodKey: string;
  periodLabel: string;
};

function toMs(timestamp: string | null | undefined): number {
  if (!timestamp) return 0;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : 0;
}

function messageTime(message: MessageRecord): string {
  return message.created_at;
}

function formatLocalDate(ms: number): string {
  const date = new Date(ms || Date.now());
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function periodSlot(ms: number): { key: string; label: string } {
  const date = new Date(ms || Date.now());
  const hour = date.getUTCHours();
  const day = formatLocalDate(ms);
  if (hour < 6) return { key: `${day}:night`, label: `${day} 凌晨` };
  if (hour < 12) return { key: `${day}:morning`, label: `${day} 上午` };
  if (hour < 18) return { key: `${day}:afternoon`, label: `${day} 下午` };
  return { key: `${day}:evening`, label: `${day} 晚上` };
}

function splitIntoChunks(env: Env, messages: MessageRecord[]): ConversationChunk[] {
  if (messages.length === 0) return [];

  const maxMessages = Math.max(Number(env.AUTO_CHUNK_MAX_MESSAGES || DEFAULT_MAX_MESSAGES), MIN_MESSAGES);
  const ordered = messages.slice().sort((a, b) => {
    const byTime = toMs(messageTime(a)) - toMs(messageTime(b));
    if (byTime !== 0) return byTime;
    return a.id.localeCompare(b.id);
  });

  const chunks: ConversationChunk[] = [];
  let current: MessageRecord[] = [];
  let currentKey = "";
  let currentLabel = "";

  const flush = () => {
    if (current.length === 0) return;
    chunks.push({ messages: current, periodKey: currentKey, periodLabel: currentLabel });
    current = [];
  };

  for (const message of ordered) {
    const slot = periodSlot(toMs(messageTime(message)));
    if (current.length > 0 && (slot.key !== currentKey || current.length >= maxMessages)) {
      flush();
    }
    if (current.length === 0) {
      currentKey = slot.key;
      currentLabel = slot.label;
    }
    current.push(message);
  }
  flush();
  return chunks;
}

function formatTranscript(messages: MessageRecord[]): string {
  return messages.map((message) => {
    const role = message.role || "message";
    const timestamp = messageTime(message) ? ` ${messageTime(message)}` : "";
    return `[${role}${timestamp}] ${message.content}`;
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

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
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

async function summarizeChunk(env: Env, messages: MessageRecord[]): Promise<ChunkSummary | null> {
  const fallback = fallbackSummary(messages);
  const transcript = formatTranscript(messages).slice(0, 12000);
  const model = env.AUTO_CHUNK_SUMMARY_MODEL || env.MEMORY_FILTER_MODEL || env.CHAT_MODEL || DEFAULT_SUMMARY_MODEL;
  const prompt = `请把下面这一整段聊天窗口整理成一则中文日记式记忆。要求：\n- 不是逐条流水账，也不是一句话概括。\n- 用第一人称或贴近日记的叙述，保留具体事件、关系、情绪变化、决定和待办。\n- 忽略无意义寒暄、重复催促、工具噪音。\n- 如果内容很少，也要说明上下文不足，不要编造。\n- 输出 JSON，格式：{"summary":"...","keywords":["..."],"emotion":"..."}\n\n聊天窗口：\n${transcript}`;

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

function diaryContent(periodLabel: string, summary: ChunkSummary, messages: MessageRecord[]): string {
  const start = messages[0] ? messageTime(messages[0]) : "unknown";
  const end = messages[messages.length - 1] ? messageTime(messages[messages.length - 1]) : start;
  const keywordLine = summary.keywords.length > 0 ? `\n关键词：${summary.keywords.join("、")}` : "";
  return `【${periodLabel}】\n${summary.summary}\n\n时间范围：${start} 至 ${end}\n情感标签：${summary.emotion}${keywordLine}`;
}

async function persistChunkMemory(env: Env, params: {
  namespace: string;
  chunk: ConversationChunk;
  summary: ChunkSummary;
}): Promise<void> {
  const { namespace, chunk, summary } = params;
  const content = diaryContent(chunk.periodLabel, summary, chunk.messages);
  const sourceMessageIds = chunk.messages.map((message) => message.id);
  const tags = ["auto-diary", chunk.periodKey, ...summary.keywords].slice(0, 10);

  const memory = await createMemory(env.DB, {
    namespace,
    type: "auto_diary",
    content,
    summary: summary.summary,
    importance: 0.62,
    confidence: 0.82,
    tags,
    source: "conversation_chunker",
    sourceMessageIds
  });

  try {
    await upsertMemoryEmbedding(env, memory);
  } catch (error) {
    console.error("conversation chunk vector upsert failed", error);
  }
}

export async function runConversationChunking(
  env: Env,
  message: ConversationChunkQueueMessage
): Promise<{ conversations: number; chunks: number; messages: number }> {
  const maxMessages = Math.max(Number(message.maxMessages || env.AUTO_CHUNK_MAX_MESSAGES || DEFAULT_MAX_MESSAGES), MIN_MESSAGES);
  const candidates = await listUnprocessedChunkMessages(env.DB, {
    namespace: message.namespace,
    conversationId: message.conversationId,
    limit: maxMessages
  });

  if (candidates.length < MIN_MESSAGES) {
    return { conversations: 0, chunks: 0, messages: 0 };
  }

  let chunkCount = 0;
  let messageCount = 0;
  const chunks = splitIntoChunks(env, candidates);

  for (const chunk of chunks) {
    if (chunk.messages.length < MIN_MESSAGES) continue;
    const summary = await summarizeChunk(env, chunk.messages);
    if (!summary) continue;

    await persistChunkMemory(env, {
      namespace: message.namespace,
      chunk,
      summary
    });
    await markMessagesChunkProcessed(env.DB, {
      namespace: message.namespace,
      ids: chunk.messages.map((item) => item.id)
    });
    chunkCount += 1;
    messageCount += chunk.messages.length;
  }

  return { conversations: chunkCount > 0 ? 1 : 0, chunks: chunkCount, messages: messageCount };
}
