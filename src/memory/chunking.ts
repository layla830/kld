import { createMemory, updateMemory } from "../db/memories";
import { listUnprocessedChunkMessages, markMessagesChunkProcessed, type MessageRecord } from "../db/messages";
import { embedTexts, upsertVector } from "../services/vectorize";
import { callOpenAICompat } from "../services/openaiCompat";
import type { Env } from "../types";

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
  startTs: number;
  endTs: number;
  periodKey: string;
  periodLabel: string;
};

function toMs(timestamp: string | null | undefined): number {
  if (!timestamp) return 0;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : 0;
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
    const byTime = toMs(a.timestamp) - toMs(b.timestamp);
    if (byTime !== 0) return byTime;
    return a.id.localeCompare(b.id);
  });

  const chunks: ConversationChunk[] = [];
  let current: MessageRecord[] = [];
  let currentKey = "";
  let currentLabel = "";

  const flush = () => {
    if (current.length === 0) return;
    const startTs = toMs(current[0]?.timestamp);
    const endTs = toMs(current[current.length - 1]?.timestamp);
    chunks.push({ messages: current, startTs, endTs, periodKey: currentKey, periodLabel: currentLabel });
    current = [];
  };

  for (const message of ordered) {
    const slot = periodSlot(toMs(message.timestamp));
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
    const timestamp = message.timestamp ? ` ${message.timestamp}` : "";
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
  const start = messages[0]?.timestamp || "unknown";
  const end = messages[messages.length - 1]?.timestamp || start;
  const keywordLine = summary.keywords.length > 0 ? `\n关键词：${summary.keywords.join("、")}` : "";
  return `【${periodLabel}】\n${summary.summary}\n\n时间范围：${start} 至 ${end}\n情感标签：${summary.emotion}${keywordLine}`;
}

function digestId(messages: MessageRecord[]): string {
  const first = messages[0]?.id || "start";
  const last = messages[messages.length - 1]?.id || first;
  return `${first}:${last}`;
}

function diaryKey(conversationId: string, periodKey: string, messages: MessageRecord[]): string {
  return `auto-diary:${conversationId}:${periodKey}:${digestId(messages)}`;
}

async function persistChunkMemory(env: Env, params: {
  namespace: string;
  userId: string;
  conversationId: string;
  chunk: ConversationChunk;
  summary: ChunkSummary;
}): Promise<void> {
  const { namespace, userId, conversationId, chunk, summary } = params;
  const key = diaryKey(conversationId, chunk.periodKey, chunk.messages);
  const content = diaryContent(chunk.periodLabel, summary, chunk.messages);
  const now = new Date().toISOString();
  const metadata = {
    conversation_id: conversationId,
    source: "cc-connect",
    auto_generated: true,
    diary_period: chunk.periodKey,
    period_label: chunk.periodLabel,
    start_timestamp: chunk.messages[0]?.timestamp || null,
    end_timestamp: chunk.messages[chunk.messages.length - 1]?.timestamp || null,
    message_count: chunk.messages.length,
    message_digest: digestId(chunk.messages),
    keywords: summary.keywords,
    emotion: summary.emotion
  };

  const memory = await createMemory(env, {
    namespace,
    user_id: userId,
    type: "auto_diary",
    content,
    metadata,
    importance: 0.62,
    salience: 0.62,
    access_count: 0,
    source: "conversation_chunker",
    source_ref: key,
    created_at: now,
    updated_at: now
  });

  await updateMemory(env, memory.id, { supersedes: null });

  try {
    const [embedding] = await embedTexts(env, [content]);
    if (embedding) {
      await upsertVector(env, {
        id: memory.id,
        values: embedding,
        metadata: {
          namespace,
          user_id: userId,
          type: "auto_diary",
          content,
          source_ref: key,
          created_at: now
        }
      });
    }
  } catch (error) {
    console.error("conversation chunk vector upsert failed", error);
  }
}

export async function runConversationChunking(env: Env): Promise<{ conversations: number; chunks: number; messages: number }> {
  const maxMessages = Math.max(Number(env.AUTO_CHUNK_MAX_MESSAGES || DEFAULT_MAX_MESSAGES), MIN_MESSAGES);
  const candidates = await listUnprocessedChunkMessages(env, maxMessages * 4);
  const grouped = new Map<string, MessageRecord[]>();

  for (const message of candidates) {
    const key = `${message.namespace}\u0000${message.user_id}\u0000${message.conversation_id}`;
    const group = grouped.get(key) || [];
    group.push(message);
    grouped.set(key, group);
  }

  let chunkCount = 0;
  let messageCount = 0;
  let conversationCount = 0;

  for (const group of grouped.values()) {
    const messages = group.sort((a, b) => {
      const byTime = toMs(a.timestamp) - toMs(b.timestamp);
      if (byTime !== 0) return byTime;
      return a.id.localeCompare(b.id);
    });
    if (messages.length < MIN_MESSAGES) continue;
    const first = messages[0];
    if (!first) continue;

    conversationCount += 1;
    const chunks = await splitIntoChunks(env, messages);
    for (const chunk of chunks) {
      if (chunk.messages.length < MIN_MESSAGES) continue;
      const summary = await summarizeChunk(env, chunk.messages);
      if (!summary) continue;
      await persistChunkMemory(env, {
        namespace: first.namespace,
        userId: first.user_id,
        conversationId: first.conversation_id,
        chunk,
        summary
      });
      await markMessagesChunkProcessed(env, chunk.messages.map((message) => message.id));
      chunkCount += 1;
      messageCount += chunk.messages.length;
    }
  }

  return { conversations: conversationCount, chunks: chunkCount, messages: messageCount };
}
