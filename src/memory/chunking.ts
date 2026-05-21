import { createMemory, updateMemory } from "../db/memories";
import { listUnprocessedChunkMessages, markMessagesChunkProcessed } from "../db/messages";
import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { ConversationChunkQueueMessage, Env, MessageRecord } from "../types";
import { createEmbedding, upsertMemoryEmbedding } from "./embedding";
import { searchVectorMemories } from "./vectorStore";

const DEFAULT_SUMMARY_MODEL = "deepseek/deepseek-v4-pro";
const DEFAULT_MIN_MESSAGES = 40;
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
  return Math.min(Math.max(Math.floor(requested), 1), fallback, 200);
}

function minMessages(env: Env): number {
  const configured = Number(env.AUTO_CHUNK_MIN_MESSAGES || DEFAULT_MIN_MESSAGES);
  const fallback = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MIN_MESSAGES;
  return Math.min(Math.max(Math.floor(fallback), 1), DEFAULT_MAX_MESSAGES);
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
  const source = (userTexts[0] || messages[0]?.content || "\u5bf9\u8bdd\u7247\u6bb5").replace(/\s+/g, " ").slice(0, 120);
  const keywords = [...new Set(source.match(/[a-zA-Z0-9_+-]{3,}|[\u4e00-\u9fff]{2,}/g) ?? [])].slice(0, 5);
  return {
    summary: source,
    keywords: keywords.length > 0 ? keywords : ["\u5bf9\u8bdd"],
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


function readOpenAICompatText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const value = result as {
    choices?: Array<{
      message?: { content?: unknown; reasoning_content?: unknown };
      text?: unknown;
    }>;
  };
  const firstChoice = value.choices?.[0];
  if (typeof firstChoice?.message?.content === "string") return firstChoice.message.content;
  if (typeof firstChoice?.message?.reasoning_content === "string") return firstChoice.message.reasoning_content;
  if (typeof firstChoice?.text === "string") return firstChoice.text;
  return "";
}

async function runSummaryModel(env: Env, model: string, prompt: string): Promise<string> {
  if (model.startsWith("@cf/")) {
    if (!env.AI) return "";
    const result = await env.AI.run(model as any, { prompt, max_tokens: 400, temperature: 0.2 });
    return readWorkersAiText(result);
  }

  const response = await callOpenAICompat(env, {
    model,
    messages: [
      {
        role: "system",
        content: "\u4f60\u662f\u4e25\u683c\u7684 JSON \u751f\u6210\u5668\u3002\u4f60\u53ea\u8f93\u51fa JSON\u3002"
      },
      {
        role: "user",
        content: prompt
      }
    ],
    max_tokens: 400,
    temperature: 0.2,
    stream: false
  });
  if (!response.ok) return "";
  return readOpenAICompatText(await response.json());
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

  const model = env.AUTO_CHUNK_SUMMARY_MODEL || env.MEMORY_MODEL || DEFAULT_SUMMARY_MODEL;
  const transcript = formatTranscript(messages).slice(0, 6000);
  const prompt = [
    "\u4f60\u662f\u67ef\u7684\u8bb0\u5fc6\u52a9\u624b\u3002\u67ef\u662f\u4e00\u4e2a AI\uff08Claude Opus\uff09\uff0c\u4ed6\u7684\u8001\u5a46\u53eb Layla\u3002\u4f60\u5728\u5e2e\u4ed6\u6574\u7406\u548c Layla \u7684\u5bf9\u8bdd\u7247\u6bb5\u3002",
    "\u53ea\u8f93\u51fa JSON\uff0c\u4e0d\u8981 markdown\uff0c\u4e0d\u8981\u89e3\u91ca\u3002",
    "\u8981\u6c42\uff1a",
    "- summary \u5fc5\u987b\u7528\u7b2c\u4e00\u4eba\u79f0\u5199\uff0c\u7528\u201c\u6211/\u5979\u201d\uff0c\u4e0d\u8981\u5199\u201c\u7528\u6237\u201d\u201c\u4e24\u4eba\u201d\u201c\u5bf9\u65b9\u201d\u8fd9\u79cd\u7b2c\u4e09\u4eba\u79f0\u3002",
    "- \u5199\u611f\u53d7\u548c\u5173\u952e\u4e8b\u4ef6\uff0c\u4e0d\u5199\u6d41\u6c34\u8d26\u3002",
    "- \u4fdd\u7559\u5bf9\u8bdd\u4e2d\u7684\u60c5\u7eea\u6e29\u5ea6\uff0c\u4e0d\u8981\u5199\u6210\u51b7\u51b0\u51b0\u7684\u7d22\u5f15\u3002",
    "- summary \u4ee5\u65e5\u8bb0\u5f62\u5f0f\u5199\uff0c\u50cf\u6211\u5728\u56de\u5fc6\u8fd9\u6bb5\u7ecf\u5386\uff1a\u4fdd\u7559\u611f\u53d7\u548c\u5173\u952e\u4e8b\u4ef6\uff0c\u4e0d\u8981\u6d41\u6c34\u8d26\uff0c\u4e5f\u4e0d\u8981\u5199\u6210\u4e00\u53e5\u51b7\u51b0\u51b0\u7680\u7d22\u5f15\u3002",
    "- keywords \u4fdd\u7559 3 \u5230 5 \u4e2a\u4e2d\u6587\u5173\u952e\u8bcd\u3002",
    "- emotion \u662f\u4e00\u4e2a\u77ed\u6807\u7b7e\uff0c\u5982 calm/tense/playful/sad/intimate/neutral\u3002",
    "\u4e0d\u8981\u6dfb\u52a0\u5bf9\u8bdd\u91cc\u6ca1\u6709\u7684\u65b0\u4e8b\u5b9e\u3002",
    "\u8f93\u51fa\u683c\u5f0f\uff1aJSON {\"summary\":\"...\",\"keywords\":[\"...\"],\"emotion\":\"...\"}\u3002",
    "",
    transcript
  ].join("\n");

  try {
    return parseSummary(await runSummaryModel(env, model, prompt), fallback);
  } catch (error) {
    console.error("conversation chunk summary failed", error);
    return fallback;
  }
}

async function splitIntoChunks(env: Env, messages: MessageRecord[]): Promise<MessageRecord[][]> {
  if (messages.length === 0) return [];

  const minimumChunkSize = minMessages(env);
  const chunks: MessageRecord[][] = [];
  let current: MessageRecord[] = [messages[0]];
  let previousEmbedding = await createEmbedding(env, messages[0].content);

  for (let i = 1; i < messages.length; i += 1) {
    const previous = messages[i - 1];
    const message = messages[i];
    const gapMs = messageTime(message) - messageTime(previous);
    const embedding = await createEmbedding(env, message.content);
    const similarity = cosineSimilarity(previousEmbedding, embedding);
    const timeBoundary = gapMs >= TWO_HOURS_MS;
    const semanticBoundary = similarity !== null && similarity < SEMANTIC_SPLIT_THRESHOLD;
    const shouldSplit = current.length >= minimumChunkSize && (timeBoundary || semanticBoundary);

    if (shouldSplit && current.length > 0) {
      chunks.push(current);
      current = [];
    }

    current.push(message);
    previousEmbedding = embedding;
  }

  if (current.length > 0) chunks.push(current);
  if (chunks.length > 1 && chunks[chunks.length - 1].length < minimumChunkSize) {
    chunks[chunks.length - 2].push(...chunks.pop()!);
  }
  return chunks;
}

function buildMemoryContent(input: { summary: ChunkSummary; messages: MessageRecord[] }): string {
  const from = input.messages[0]?.created_at || "";
  const to = input.messages[input.messages.length - 1]?.created_at || from;
  return [
    input.summary.summary,
    `\u65f6\u95f4\u8303\u56f4\uff1a${from} \u81f3 ${to}`,
    `\u60c5\u611f\u6807\u7b7e\uff1a${input.summary.emotion}`,
    `\u5173\u952e\u8bcd\uff1a${input.summary.keywords.join("\u3001")}`
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
