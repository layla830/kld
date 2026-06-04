import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, MessageRecord } from "../types";
import { extractJsonObject } from "../utils/jsonHelpers";
import { formatShanghaiDateTime, messageTime } from "./chunkPeriods";

export type LocalChunkExtract = {
  skip: boolean;
  summary: string;
  keywords: string[];
  important_quotes: string[];
};

const DEFAULT_LOCAL_CHUNK_MODEL = "deepseek/deepseek-v4-flash";
const LOCAL_CHUNK_MAX_TOKENS = 900;
const LOCAL_CHUNK_TRANSCRIPT_MAX_CHARS = 18000;
const MAX_KEYWORDS = 8;
const MAX_QUOTES = 3;

function formatTranscript(messages: MessageRecord[]): string {
  return messages.map((message) => {
    const speaker = message.role === "user" ? "她" : message.role === "assistant" ? "他" : message.role;
    return `[${speaker} ${formatShanghaiDateTime(messageTime(message))}] ${message.content}`;
  }).join("\n");
}

function sortMessages(messages: MessageRecord[]): MessageRecord[] {
  return [...messages].sort((left, right) => {
    const byTime = messageTime(left).localeCompare(messageTime(right));
    if (byTime !== 0) return byTime;
    return String(left.id || "").localeCompare(String(right.id || ""));
  });
}

function cleanModelText(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
}

function readOpenAICompatText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const data = result as { choices?: Array<{ message?: { content?: unknown }; text?: unknown }> };
  const choice = data.choices?.[0];
  if (typeof choice?.message?.content === "string") return choice.message.content;
  if (typeof choice?.text === "string") return choice.text;
  return "";
}

function readStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeSummary(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join("\n")
    .trim();
}

function fallbackExtract(messages: MessageRecord[]): LocalChunkExtract {
  const lines = messages
    .slice(0, 5)
    .map((message) => {
      const speaker = message.role === "user" ? "她" : "他";
      const content = message.content.replace(/\s+/g, " ").trim();
      return `${speaker}说：${content}`;
    })
    .filter((line) => line.length > 6);

  return {
    skip: lines.length === 0,
    summary: lines.slice(0, 3).join("\n").slice(0, 700),
    keywords: [],
    important_quotes: []
  };
}

function buildPrompt(messages: MessageRecord[], periodLabel: string): string {
  const transcript = formatTranscript(messages).slice(0, LOCAL_CHUNK_TRANSCRIPT_MAX_CHARS);
  return `把下面一段连续聊天整理成本地召回 chunk。

时间段：${periodLabel}（东八区）

要求：
- 输出 3-5 句中文，每句短而具体。
- 要有连续感，像在概括这一段聊天，不要拆成不相干的 facts 列表。
- 保留可搜索关键词、物品、梗、时间、地点和明确事件。
- 不写日记腔，不写“他们讨论了/表达了/关系如何”等空话。
- 只写原文明确出现的信息，不补环境、动作、表情、心理描写。
- 用第三人称，只用“她”和“他”。
- 如果全是无意义寒暄或没有可召回信息，skip=true。
- important_quotes 只放真正值得保留的原话，通常可以为空。

只输出 JSON，不要 markdown，不要解释。格式：
{
  "skip": false,
  "summary": "第一句。\\n第二句。\\n第三句。",
  "keywords": ["关键词1", "关键词2"],
  "important_quotes": ["原话1"]
}

聊天：
${transcript}`;
}

function buildRetryPrompt(messages: MessageRecord[], periodLabel: string): string {
  const transcript = formatTranscript(messages).slice(0, LOCAL_CHUNK_TRANSCRIPT_MAX_CHARS);
  return `请把这段聊天压缩成可搜索的本地召回摘要。
时间段：${periodLabel}

只输出 JSON：
{"skip":false,"summary":"第一句。\\n第二句。\\n第三句。","keywords":["关键词1"],"important_quotes":[]}

规则：summary 只写 2-3 句，保留主要梗和事实，不写解释，不补原文没有的内容。

聊天：
${transcript}`;
}

function parseExtract(text: string, fallback: LocalChunkExtract): LocalChunkExtract | null {
  const parsed = extractJsonObject(cleanModelText(text));
  if (!parsed || typeof parsed !== "object") return null;

  const raw = parsed as {
    skip?: unknown;
    summary?: unknown;
    keywords?: unknown;
    important_quotes?: unknown;
  };
  const skip = raw.skip === true;
  const summary = normalizeSummary(raw.summary);
  const keywords = readStringArray(raw.keywords, MAX_KEYWORDS);
  const importantQuotes = readStringArray(raw.important_quotes, MAX_QUOTES);

  if (skip) {
    return { skip: true, summary: "", keywords, important_quotes: importantQuotes };
  }
  if (!summary) return null;

  return {
    skip: false,
    summary,
    keywords,
    important_quotes: importantQuotes.length > 0 ? importantQuotes : fallback.important_quotes
  };
}

function parseLooseSummary(text: string): LocalChunkExtract | null {
  const cleaned = cleanModelText(text)
    .replace(/^["']|["']$/g, "")
    .trim();
  if (/^\s*[{[]/.test(cleaned) || /"(?:skip|summary|keywords|important_quotes)"\s*:/.test(cleaned)) {
    return null;
  }
  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)、])\s*/, "").trim())
    .filter((line) => !/"(?:skip|summary|keywords|important_quotes)"\s*:/.test(line))
    .filter((line) => line.length >= 8 && !/^[{}\[\],"]+$/.test(line))
    .slice(0, 3);
  if (lines.length === 0) return null;
  return {
    skip: false,
    summary: lines.join("\n"),
    keywords: [],
    important_quotes: []
  };
}

export async function extractLocalRecallChunk(
  env: Env,
  messages: MessageRecord[],
  periodLabel: string
): Promise<LocalChunkExtract | null> {
  const orderedMessages = sortMessages(messages);
  const fallback = fallbackExtract(orderedMessages);
  const model = env.CC_CONNECT_CHUNK_EXTRACT_MODEL || env.AUTO_CHUNK_SUMMARY_MODEL || env.CHAT_MODEL || env.MEMORY_MODEL || DEFAULT_LOCAL_CHUNK_MODEL;
  const prompt = buildPrompt(orderedMessages, periodLabel);

  try {
    const response = await callOpenAICompat(env, {
      model,
      messages: [
        {
          role: "system",
          content: "You are a strict JSON generator for concise Chinese conversation recall chunks. Output JSON only."
        },
        { role: "user", content: prompt }
      ],
      max_tokens: LOCAL_CHUNK_MAX_TOKENS,
      temperature: 0.1,
      stream: false
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error("local chunk extract model failed", { model, status: response.status, body: body.slice(0, 300) });
      return null;
    }

    const primaryText = readOpenAICompatText(await response.json());
    const primary = parseExtract(primaryText, fallback) || parseLooseSummary(primaryText);
    if (primary) return primary;

    const retryResponse = await callOpenAICompat(env, {
      model,
      messages: [
        {
          role: "system",
          content: "Return valid JSON only. No markdown."
        },
        { role: "user", content: buildRetryPrompt(orderedMessages, periodLabel) }
      ],
      max_tokens: 500,
      temperature: 0,
      stream: false
    });

    if (retryResponse.ok) {
      const retryText = readOpenAICompatText(await retryResponse.json());
      const retry = parseExtract(retryText, fallback) || parseLooseSummary(retryText);
      if (retry) return retry;
    }

    return fallback;
  } catch (error) {
    console.error("local chunk extract model error", { model, error });
    return null;
  }
}
