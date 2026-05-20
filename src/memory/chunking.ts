import { createMemory, updateMemory } from "../db/memories";
import { listUnprocessedChunkMessages, markMessagesChunkProcessed } from "../db/messages";
import type { ConversationChunkQueueMessage, Env, MessageRecord } from "../types";
import { createEmbedding, upsertMemoryEmbedding } from "./embedding";
import { searchVectorMemories } from "./vectorStore";

const DEFAULT_MAX_MESSAGES = 80;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const SEMANTIC_SPLIT_THRESHOLD = 0.55;
const SKIP_DUPLICATE_THRESHOLD = 0.92;
const REPLACE_DUPLICATE_THRESHOLD = 0.85;

interface ChunkSummary {
  summary: string;
  keywords: string[];
  emotion: string;
}

function maxMessages(env: Env, message: ConversationChunkQueueMessage): number {
  const configured = Number(env.AUTO_CHUNK_MAX_MESSAGES || DEFAULT_MAX_MESSAGES);
  const fallback = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_MESSAGES;
  const requested = message.maxMessages && message.maxMessages > 0 ? message.maxMessages : fallback;
  return Math.min(Math.max(Math.floor(requested), 1), 200);
}

function messageTime(message: MessageRecord): number {
  const parsed = Date.parse(message.created_at);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cosineSimilarity(a: number[] | null, b: number[] | null): number | null {
  if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return null;
  return dot / Math.sqrt(normA * normB);
}

function formatTranscript(messages: MessageRecord[]): string {
  return messages
    .map((message) => {
      const role = message.role === "assistant" ? "assistant" : "user";
      return `${role}: ${message.content.trim()}`;
    })
    .join("\n");
}

function fallbackSummary(messages: MessageRecord[]): ChunkSummary {
  const userTexts = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean);
  const source = (userTexts[0] || messages[0]?.content || "对话片段").replace(/\s+/g, " ").slice(0, 120);
  const keywords = [...new Set(source.match(/[a-zA-Z0-9_+-]{3,}|[\u4e00-\u9fff]{2,}/g) ?? [])].slice(0, 5);
  return {
    summary: source,
    keywords: keywords.length > 0 ? keywords : ["对话"],
    emotion: "neutral"
  };
}

function extractJsonObject(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Workers AI models may wrap JSON in prose.
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

function readWorkersAiText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const value = result as {
    response?: unknown;
    output?: unknown;
    result?: unknown;
    choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
  };

  if (typeof value.response === "string") return value.response;
  if (typeof value.output === "string") return value.output;
  if (typeof value.result === "string") return value.result;
  const firstChoice = value.choices?.[0];
  if (typeof firstChoice?.message?.content === "string") return firstChoice.message.content;
  if (typeof firstChoice?.text === "string") return firstChoice.text;
  return "";
}

function parseSummary(text: string, fallback: ChunkSummary): ChunkSummary {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== "object") return fallback;

  const raw = parsed as { summary?: unknown; keywords?: unknown; emotion?: unknown };
  const summary = typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : fallback.summary;
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 5)
    : fallback.keywords;
  const emotion = typeof raw.emotion === "string" && raw.emotion.trim() ? raw.emotion.trim() : fallback.emotion;

  return { summary, keywords: keywords.length > 0 ? keywords : fallback.keywords, emotion };
}

async function summarizeChunk(env: Env, messages: MessageRecord[]): Promise<ChunkSummary> {
  const fallback = fallbackSummary(messages);
  if (!env.AI) return fallback;

  const model = env.AUTO_CHUNK_SUMMARY_MODEL || env.MEMORY_FILTER_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  const transcript = formatTranscript(messages).slice(0, 6000);
  const prompt = [
    "你是对话记忆分块摘要器。请把下面的连续对话片段压缩成稳定、可检索的长期记忆。",
    "只输出 JSON，不要 markdown，不要解释。",
    "字段：summary（一句话，中文，保留关键事实和关系动态），keywords（3到5个中文关键词），emotion（一个短标签，如 calm/tense/playful/sad/intimate/neutral）。",
    "不要添加对话里没有的新事实。",
    "",
    transcript
  ].join("\n");

  try {
    const result = await env.AI.run(model as any, { prompt, max_tokens: 400, temperature: 0.2 });
    return parseSummary(readWorkersAiText(result), fallback);
  } catch (error) {
    console.error("conversation chunk summary failed", error);
    return fallback;
  }
}

async function splitIntoChunks(env: Env, messages: MessageRecord[]): Promise<MessageRecord[][]> {
  if (messages.length === 0) return [];

  const chunks: MessageRecord[][] = [];
  let current: MessageRecord[] = [messages[0]];
  let previousEmbedding = await createEmbedding(env, messages[0].content);

  for (let i = 1; i < messages.length; i += 1) {
    const previous = messages[i - 1];
    const message = messages[i];
    const gapMs = messageTime(message) - messageTime(previous);
    const embedding = await createEmbedding(env, message.content);
    const similarity = cosineSimilarity(previousEmbedding, embedding);
    const shouldSplit = gapMs >= TWO_HOURS_MS || (similarity !== null && similarity < SEMANTIC_SPLIT_THRESHOLD);

    if (shouldSplit && current.length > 0) {
      chunks.push(current);
      current = [];
    }

    current.push(message);
    previousEmbedding = embedding;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

function buildMemoryContent(input: { summary: ChunkSummary; messages: MessageRecord[] }): string {
  const from = input.messages[0]?.created_at || "";
  const to = input.messages[input.messages.length - 1]?.created_at || from;
  return [
    input.summary.summary,
    `时间范围：${from} 至 ${to}`,
    `情感标签：${input.summary.emotion}`,
    `关键词：${input.summary.keywords.join("、")}`
  ].join("\n");
}

async function persistChunkMemory(
  env: Env,
  input: { namespace: string; source: string; messages: MessageRecord[]; summary: ChunkSummary }
): Promise<void> {
  const content = buildMemoryContent(input);
  const matches = await searchVectorMemories(env, {
    namespace: input.namespace,
    query: content,
    types: ["auto_chunk"],
    topK: 3
  });
  const best = matches?.[0];
  const sourceMessageIds = input.messages.map((message) => message.id);
  const tags = ["auto_chunk", ...input.summary.keywords, `emotion:${input.summary.emotion}`];

  if (best && best.score >= SKIP_DUPLICATE_THRESHOLD) return;

  if (best && best.score >= REPLACE_DUPLICATE_THRESHOLD) {
    const updated = await updateMemory(env.DB, {
      namespace: input.namespace,
      id: best.id,
      patch: {
        content,
        summary: input.summary.summary,
        importance: Math.max(best.importance, 0.62),
        confidence: Math.max(best.confidence, 0.78),
        tags,
        sourceMessageIds
      }
    });
    if (updated) await upsertMemoryEmbedding(env, updated);
    return;
  }

  const created = await createMemory(env.DB, {
    namespace: input.namespace,
    type: "auto_chunk",
    content,
    summary: input.summary.summary,
    importance: 0.62,
    confidence: 0.78,
    tags,
    source: input.source,
    sourceMessageIds
  });
  await upsertMemoryEmbedding(env, created);
}

export async function runConversationChunking(env: Env, message: ConversationChunkQueueMessage): Promise<void> {
  const messages = await listUnprocessedChunkMessages(env.DB, {
    namespace: message.namespace,
    conversationId: message.conversationId,
    limit: maxMessages(env, message)
  });
  if (messages.length === 0) return;

  const chunks = await splitIntoChunks(env, messages);
  const processedIds: string[] = [];

  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    const summary = await summarizeChunk(env, chunk);
    await persistChunkMemory(env, {
      namespace: message.namespace,
      source: message.source,
      messages: chunk,
      summary
    });
    processedIds.push(...chunk.map((item) => item.id));
  }

  await markMessagesChunkProcessed(env.DB, {
    namespace: message.namespace,
    ids: processedIds
  });
}
