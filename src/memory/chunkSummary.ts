import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, MessageRecord } from "../types";
import { extractJsonObject } from "../utils/jsonHelpers";
import type { ChunkSummary } from "./chunkTypes";
import { formatShanghaiDateTime, messageTime } from "./chunkPeriods";

const DEFAULT_SUMMARY_MODEL = "deepseek/deepseek-v4-pro";
const FALLBACK_WORKERS_SUMMARY_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const SUMMARY_MAX_TOKENS = 1800;
const TRANSCRIPT_MAX_CHARS = 60000;
const LONG_WINDOW_MESSAGE_COUNT = 160;
const SEGMENT_MESSAGE_LIMIT = 120;
const SEGMENT_TRANSCRIPT_MAX_CHARS = 14000;
const SEGMENT_CONCURRENCY = 3;
const MAX_SEGMENTS = 10;

function formatTranscript(messages: MessageRecord[]): string {
  return messages.map((message) => {
    const role = message.role || "message";
    const timestamp = formatShanghaiDateTime(messageTime(message));
    return `[${role} ${timestamp}] ${message.content}`;
  }).join("\n");
}

function sortMessagesChronologically(messages: MessageRecord[]): MessageRecord[] {
  return [...messages].sort((left, right) => {
    const leftTime = messageTime(left).getTime();
    const rightTime = messageTime(right).getTime();
    if (leftTime !== rightTime) return leftTime - rightTime;
    return String(left.id || "").localeCompare(String(right.id || ""));
  });
}

function fallbackSummary(messages: MessageRecord[]): ChunkSummary {
  const text = messages.map((message) => message.content).join("\n").replace(/\s+/g, " ").trim();
  const summary = text.slice(0, 900) || "这段时间的对话没有足够内容可写成日记。";
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

function parseNotes(text: string): string[] {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== "object") return [];
  const raw = parsed as { notes?: unknown };
  if (!Array.isArray(raw.notes)) return [];
  return raw.notes
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function notesFallbackSummary(notes: string[], fallback: ChunkSummary): ChunkSummary | null {
  const summary = notes.join(" ").replace(/\s+/g, " ").trim().slice(0, 900);
  if (summary.length < 120) return null;
  return { summary, keywords: fallback.keywords, emotion: fallback.emotion };
}

function isTooShortForLongWindow(summary: ChunkSummary, messageCount: number): boolean {
  return messageCount >= 80 && summary.summary.length < 350;
}

function messageChunks(messages: MessageRecord[]): MessageRecord[][] {
  const chunks: MessageRecord[][] = [];
  for (let index = 0; index < messages.length; index += SEGMENT_MESSAGE_LIMIT) {
    chunks.push(messages.slice(index, index + SEGMENT_MESSAGE_LIMIT));
  }
  return chunks;
}

function buildSegmentPrompt(messages: MessageRecord[], periodLabel: string, index: number, total: number): string {
  const transcript = formatTranscript(messages).slice(0, SEGMENT_TRANSCRIPT_MAX_CHARS);
  return `这是“${periodLabel}”里的第 ${index + 1}/${total} 段聊天。请只提取这段里值得写进日记的关键片段。
要求：
- 输出 1-4 条 notes，每条 40-140 个中文字符。
- 每条 note 必须以该片段里真实出现的东八区时间开头，例如“00:35 她问……”。
- 严格按聊天片段出现顺序输出 notes，不要把后发生的事提前。
- 保留原话、动作、情绪转折和前因后果。
- 不要总结腔，不要写“讨论了/表达了/关系紧张”。
- 不要编造，只写这段里明确出现的内容。
- 输出 JSON，格式：{"notes":["..."]}

聊天片段：
${transcript}`;
}

function buildSummaryPrompt(messages: MessageRecord[], periodLabel: string): string {
  const transcript = formatTranscript(messages).slice(0, TRANSCRIPT_MAX_CHARS);
  return `请把下面这一整段聊天写成一篇中文日记。
时间段：${periodLabel}（东八区）。
要求：
- 这是一个完整时间段的日记，不管窗口很长也只输出一篇，不要拆成多条，不要加小标题。
- 必须严格按照聊天窗口里的时间顺序写，不要为了戏剧效果重排事件。
- 如果聊天窗口很长，先在心里找出 2-4 个关键片段或转折点，再按原始时间顺序合成一篇连贯日记。
- 写画面，不写结论。优先保留她和他的原话，尤其是有力量的句子。
- 写感受，不写流水账。不要写“讨论了X”，要写这个话题里谁被打动了、谁沉默了、谁先伸手了。
- 找出转折点，写清楚情绪为什么转向。
- 区分吵架和靠近：吵架不是“关系紧张”，是她在拉他回来；靠近不是“关系缓和”，是有人先动了。
- 200-900 个中文字符；内容少可以低于 200，内容很多不要少于 500。不要硬凑，也不要压成两句话。
- 第三人称，只用“她”和“他”。
- 不要标题、不要关键词、不要情感标签、不要列表。
- 输出 JSON，格式：{"summary":"..."}

聊天窗口：
${transcript}`;
}

function buildFinalPromptFromNotes(notes: string[], periodLabel: string): string {
  return `请把下面这些按时间顺序提取出来的关键片段，合成一篇中文日记。
时间段：${periodLabel}（东八区）。
要求：
- 只输出一篇完整日记，不要拆成多条，不要小标题。
- 必须严格按“关键片段”的编号顺序写；编号就是时间顺序，禁止把前面的片段挪到后面，禁止倒叙。
- 如果片段开头有时间，如“00:35”，必须用这个时间判断先后；可以不把时间写进正文，但叙事顺序必须一致。
- 写出 2-4 个转折点之间的前因后果，尤其要保留后半段发生的争执、修正、决定。
- 写画面和原话，不写抽象结论。不要写“讨论了/表达了/关系紧张/互动/沟通”。
- 第三人称，只用“她”和“他”。
- 300-900 个中文字符。内容很多不要少于 500。
- 不要标题、不要关键词、不要情感标签、不要列表。
- 输出 JSON，格式：{"summary":"..."}

关键片段：
${notes.map((note, index) => `${index + 1}. ${note}`).join("\n")}`;
}

async function summarizeLongChunk(env: Env, model: string, messages: MessageRecord[], periodLabel: string, fallback: ChunkSummary): Promise<ChunkSummary | null> {
  const chunks = messageChunks(messages).slice(0, MAX_SEGMENTS);
  const noteGroups: string[][] = [];
  for (let index = 0; index < chunks.length; index += SEGMENT_CONCURRENCY) {
    const batch = chunks.slice(index, index + SEGMENT_CONCURRENCY);
    noteGroups.push(...await Promise.all(batch.map(async (chunk, offset) => {
      const chunkIndex = index + offset;
      const prompt = buildSegmentPrompt(chunk, periodLabel, chunkIndex, chunks.length);
      return parseNotes(await runSummaryModel(env, model, prompt));
    })));
  }
  const notes = noteGroups.flat();

  if (notes.length === 0) return null;
  const final = parseSummary(await runSummaryModel(env, model, buildFinalPromptFromNotes(notes, periodLabel)), fallback);
  if (final && !isTooShortForLongWindow(final, messages.length)) return final;
  return notesFallbackSummary(notes, fallback);
}

export async function summarizeChunk(env: Env, messages: MessageRecord[], periodLabel: string): Promise<ChunkSummary | null> {
  const orderedMessages = sortMessagesChronologically(messages);
  const fallback = fallbackSummary(orderedMessages);
  const model = env.AUTO_CHUNK_SUMMARY_MODEL || env.CHAT_MODEL || env.MEMORY_MODEL || DEFAULT_SUMMARY_MODEL;
  const isLongWindow = orderedMessages.length >= LONG_WINDOW_MESSAGE_COUNT;

  if (isLongWindow) {
    const longSummary = await summarizeLongChunk(env, model, orderedMessages, periodLabel, fallback);
    if (longSummary) return longSummary;
    console.error("auto diary long-window summary unavailable; leaving messages unprocessed", {
      conversationId: orderedMessages[0]?.conversation_id,
      fromMessageId: orderedMessages[0]?.id,
      toMessageId: orderedMessages[orderedMessages.length - 1]?.id,
      messageCount: orderedMessages.length
    });
    return null;
  }

  const prompt = buildSummaryPrompt(orderedMessages, periodLabel);
  const primary = parseSummary(await runSummaryModel(env, model, prompt), fallback);
  if (primary && !isTooShortForLongWindow(primary, orderedMessages.length)) return primary;

  if (!model.startsWith("@cf/")) {
    const backup = parseSummary(await runSummaryModel(env, FALLBACK_WORKERS_SUMMARY_MODEL, prompt), fallback);
    if (backup && !isTooShortForLongWindow(backup, orderedMessages.length)) return backup;
  }

  if (primary) return primary;

  console.error("auto diary summary unavailable; leaving messages unprocessed", {
    conversationId: messages[0]?.conversation_id,
    fromMessageId: messages[0]?.id,
    toMessageId: messages[messages.length - 1]?.id,
    messageCount: messages.length
  });
  return null;
}
