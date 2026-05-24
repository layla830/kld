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
    const leftTime = new Date(messageTime(left)).getTime();
    const rightTime = new Date(messageTime(right)).getTime();
    if (leftTime !== rightTime) return leftTime - rightTime;
    return String(left.id || "").localeCompare(String(right.id || ""));
  });
}

function fallbackSummary(messages: MessageRecord[]): ChunkSummary {
  const text = messages.map((message) => message.content).join("\n").replace(/\s+/g, " ").trim();
  const summary = text.slice(0, 900) || "这段时间的对话没有足够内容可写成日记。";
  return { summary, keywords: [], emotion: "" };
}

function cleanModelText(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
}

function unwrapSummaryText(text: string): string {
  const cleaned = cleanModelText(text);
  const match = cleaned.match(/^\{\s*"summary"\s*:\s*"([\s\S]*)"\s*\}\s*$/);
  if (!match) return cleaned;
  return match[1].replace(/\\n/g, "\n").replace(/\\"/g, "\"").replace(/\\\\/g, "\\").trim();
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
      const result = await env.AI.run(model as any, { prompt, max_tokens: SUMMARY_MAX_TOKENS, temperature: 0.15 });
      return readWorkersAiText(result);
    }
    const response = await callOpenAICompat(env, {
      model,
      messages: [{ role: "system", content: "你是严格的 JSON 生成器和纪实整理助手。你只输出 JSON，不创作小说，不补写原文没有的信息。" }, { role: "user", content: prompt }],
      max_tokens: SUMMARY_MAX_TOKENS,
      temperature: 0.15,
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
  if (parsed && typeof parsed === "object") {
    const raw = parsed as { summary?: unknown };
    const summary = typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : "";
    if (summary) return { summary, keywords: fallback.keywords, emotion: fallback.emotion };
  }
  const summary = unwrapSummaryText(text);
  if (summary.length < 80) return null;
  return { summary, keywords: fallback.keywords, emotion: fallback.emotion };
}

function parseNotes(text: string): string[] {
  const parsed = extractJsonObject(text);
  if (parsed && typeof parsed === "object") {
    const raw = parsed as { notes?: unknown };
    if (Array.isArray(raw.notes)) {
      const notes = raw.notes.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 4);
      if (notes.length > 0) return notes;
    }
  }
  return cleanModelText(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.、)]|note\s*\d*[:：])\s*/i, "").trim())
    .filter((line) => line.length >= 20 && !/^[{\[\]}]+$/.test(line))
    .slice(0, 4);
}

function notesFallbackSummary(notes: string[], fallback: ChunkSummary): ChunkSummary | null {
  const summary = notes.join(" ").replace(/\s+/g, " ").trim().slice(0, 900);
  if (summary.length < 120) return null;
  return { summary, keywords: fallback.keywords, emotion: fallback.emotion };
}

function isTooShortForLongWindow(summary: ChunkSummary, messageCount: number): boolean {
  return messageCount >= 80 && summary.summary.length < 300;
}

function messageChunks(messages: MessageRecord[]): MessageRecord[][] {
  const chunks: MessageRecord[][] = [];
  for (let index = 0; index < messages.length; index += SEGMENT_MESSAGE_LIMIT) chunks.push(messages.slice(index, index + SEGMENT_MESSAGE_LIMIT));
  return chunks;
}

function buildSegmentPrompt(messages: MessageRecord[], periodLabel: string, index: number, total: number): string {
  const transcript = formatTranscript(messages).slice(0, SEGMENT_TRANSCRIPT_MAX_CHARS);
  return `这是“${periodLabel}”里的第 ${index + 1}/${total} 段聊天。请只提取这段里值得写进日记的关键事实。
要求：
- 输出 1-4 条 notes，每条 30-120 个中文字符。
- 每条 note 必须以该片段里真实出现的东八区时间开头，例如“00:35 她说……”。
- 严格按聊天片段出现顺序输出 notes，不要把后发生的事提前。
- 只写原文明确出现的内容：原话、明确表达的感受、明确发生的转折。
- 禁止小说化补写：不要添加原文没有的身体动作、表情、环境、光线、姿势、沉默、眼神、比喻。
- 不要总结腔，不要写“讨论了/表达了/关系紧张”。
- 不要编造、不要润色成剧情，只做纪实整理。
- 输出 JSON，格式：{"notes":["..."]}

聊天片段：
${transcript}`;
}

function buildSummaryPrompt(messages: MessageRecord[], periodLabel: string): string {
  const transcript = formatTranscript(messages).slice(0, TRANSCRIPT_MAX_CHARS);
  return `请把下面这一整段聊天整理成一篇中文纪实日记。
时间段：${periodLabel}（东八区）。
要求：
- 这是一篇事实日记，不是小说。只写聊天里明确出现的信息。
- 必须严格按照聊天窗口里的时间顺序写，不要为了戏剧效果重排事件。
- 可以保留她和他的原话，尤其是有力量的句子；原文没有的句子不要改写成引号。
- 可以写感受和转折，但必须来自原文明确表达；不要替他们推断心理。
- 禁止添加原文没有的身体动作、亲密动作、表情、环境、光线、姿势、沉默、眼神、比喻和修辞。
- 不要把“她说/他说”扩写成场景，不要把文字聊天改写成现实房间里的连续动作。
- 区分吵架和靠近，但用原文证据写，不要用“关系紧张/关系缓和/互动/沟通”这类空话。
- 100-500 个中文字符；内容很多可以到 700，但不要为凑字数加细节。
- 第三人称，只用“她”和“他”。
- 不要标题、不要关键词、不要情感标签、不要列表。
- 输出 JSON，格式：{"summary":"..."}

聊天窗口：
${transcript}`;
}

function buildFinalPromptFromNotes(notes: string[], periodLabel: string): string {
  return `请把下面这些按时间顺序提取出来的关键事实，合成一篇中文纪实日记。
时间段：${periodLabel}（东八区）。
要求：
- 只输出一篇完整日记，不要拆成多条，不要小标题。
- 必须严格按“关键片段”的编号顺序写；编号就是时间顺序，禁止倒叙或重排。
- 这是事实日记，不是小说。只能使用 notes 里已有的信息和原话。
- 禁止添加 notes 没有的身体动作、表情、环境、光线、姿势、沉默、眼神、比喻和修辞。
- 可以写转折和靠近，但必须基于 notes 的明确内容，不要脑补心理和场景。
- 不要写“讨论了/表达了/关系紧张/互动/沟通”这类空话。
- 第三人称，只用“她”和“他”。
- 100-500 个中文字符；内容很多可以到 700，但不要为凑字数加细节。
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
    noteGroups.push(...await Promise.all(batch.map(async (chunk, offset) => parseNotes(await runSummaryModel(env, model, buildSegmentPrompt(chunk, periodLabel, index + offset, chunks.length))))));
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
    console.error("auto diary long-window summary unavailable; leaving messages unprocessed", { conversationId: orderedMessages[0]?.conversation_id, fromMessageId: orderedMessages[0]?.id, toMessageId: orderedMessages[orderedMessages.length - 1]?.id, messageCount: orderedMessages.length });
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
  console.error("auto diary summary unavailable; leaving messages unprocessed", { conversationId: messages[0]?.conversation_id, fromMessageId: messages[0]?.id, toMessageId: messages[messages.length - 1]?.id, messageCount: messages.length });
  return null;
}
