import { listMessagesByNamespaceInRange } from "../db/messages";
import { getMemoryById, listMemories } from "../db/memories";
import { createMemoryEvent } from "../db/memoryEvents";
import { readCursor, writeCursor } from "../db/retention";
import { upsertSummary } from "../db/summaries";
import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, MemoryApiRecord, MemoryRecord, MessageRecord, OpenAIChatRequest, OpenAIChatResponse } from "../types";
import { extractJsonObject } from "../utils/jsonHelpers";
import {
  normalizeFactKey,
  normalizeArousal,
  normalizeResponsePosture,
  normalizeRiskLevel,
  normalizeTensionScore,
  normalizeThread,
  normalizeUrgencyLevel,
  normalizeValence
} from "./coordinates";
import type { ExtractedMemory } from "./extract";
import { toMemoryApiRecord } from "./search";
import {
  createSyncedMemory,
  deleteSyncedMemory,
} from "./state";

interface DigestMemoryUpdate {
  target_id: string;
  content?: string;
  type?: string;
  importance?: number;
  confidence?: number;
  tags?: string[];
  fact_key?: string | null;
  thread?: string | null;
  risk_level?: string | null;
  urgency_level?: string | null;
  tension_score?: number | null;
  response_posture?: string | null;
  valence?: number | null;
  arousal?: number | null;
}

interface DigestMemoryDelete {
  target_id: string;
  reason?: string;
}

interface ImportantExcerpt {
  quote: string;
  reason?: string;
  tags?: string[];
  source_message_ids?: string[];
}

interface DailyDigestResult {
  date?: string;
  title?: string;
  summary?: string;
  sections?: Array<{ heading?: string; content?: string }>;
  important_excerpts?: ImportantExcerpt[];
  memories_to_add?: ExtractedMemory[];
  memories_to_update?: DigestMemoryUpdate[];
  memories_to_delete?: DigestMemoryDelete[];
}

interface DailyDigestStats {
  date: string;
  mode: "dream";
  dryRun: boolean;
  processedMessages: number;
  addedMemories: number;
  updatedMemories: number;
  deletedMemories: number;
  updateReviewsQueued: number;
  deleteReviewsQueued: number;
  savedExcerpts: number;
  cleanedEmptyMemories: number;
  cursorAdvanced: boolean;
  hasMore: boolean;
}

type DailyDigestSkipReason =
  | "dream_disabled"
  | "already_done"
  | "no_messages"
  | "missing_model"
  | "model_error"
  | "model_invalid_json";

interface DailyDigestSkipped {
  ran: false;
  mode: "dream";
  date?: string;
  reason: DailyDigestSkipReason;
  startIso?: string;
  endIso?: string;
  cursor?: string | null;
  processedMessages?: number;
  model?: string;
  status?: number;
  finishReason?: string | null;
}

type DailyDigestRunResult = { ran: true; stats: DailyDigestStats; plan?: DailyDigestResult } | DailyDigestSkipped;

interface DigestModelCallResult {
  digest: DailyDigestResult | null;
  reason?: Extract<DailyDigestSkipReason, "missing_model" | "model_error" | "model_invalid_json">;
  model?: string;
  status?: number;
  finishReason?: string | null;
}

const DEFAULT_MAX_MESSAGES = 40;
const DEFAULT_MEMORY_CONTEXT_LIMIT = 40;
const DEFAULT_EXCERPT_LIMIT = 8;
const DEFAULT_EMPTY_MEMORY_MIN_CHARS = 4;
const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isDreamEnabled(env: Env): boolean {
  const flag = readString(env.ENABLE_DREAM);
  if (flag) return flag !== "false";
  return false;
}

function isDryRun(env: Env): boolean {
  const flag = readString(env.DREAM_DRY_RUN);
  if (flag) return flag !== "false";
  return true;
}

function readFirstEnvValue(...values: unknown[]): unknown {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readDreamModel(env: Env): string | null {
  return readString(readFirstEnvValue(env.DREAM_MODEL, env.MEMORY_MODEL, env.SUMMARY_MODEL));
}

function readDreamTimeZone(env: Env): string {
  return readString(readFirstEnvValue(env.DREAM_TIME_ZONE)) || DEFAULT_TIME_ZONE;
}

function readPositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : fallback;
  const numeric = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(Math.floor(numeric), 1), max);
}

function readDreamMaxMessages(env: Env): number {
  return readPositiveInt(readFirstEnvValue(env.DREAM_MAX_MESSAGES), DEFAULT_MAX_MESSAGES, 1000);
}

function readDreamMaxTokens(env: Env): number {
  return readPositiveInt(readFirstEnvValue(env.DREAM_MAX_TOKENS), 3000, 8000);
}

function readDreamMemoryContextLimit(env: Env): number {
  return readPositiveInt(readFirstEnvValue(env.DREAM_MEMORY_CONTEXT_LIMIT), DEFAULT_MEMORY_CONTEXT_LIMIT, 1000);
}

function readDreamExcerptLimit(env: Env): number {
  return readPositiveInt(readFirstEnvValue(env.DREAM_EXCERPT_LIMIT), DEFAULT_EXCERPT_LIMIT, 20);
}

function clampScore(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : fallback;
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}

function formatDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function getTargetDigestDateLabel(timeZone: string, now = new Date()): string {
  return formatDate(new Date(now.getTime() - ONE_DAY_MS), timeZone);
}

function parseDateLabel(dateLabel: string): { year: number; month: number; day: number } {
  const [year, month, day] = dateLabel.split("-").map((value) => Number(value));
  if (!year || !month || !day) {
    throw new Error(`Invalid date label: ${dateLabel}`);
  }
  return { year, month, day };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);

  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = Number(values.get("year"));
  const month = Number(values.get("month"));
  const day = Number(values.get("day"));
  const hour = Number(values.get("hour")) % 24;
  const minute = Number(values.get("minute"));
  const second = Number(values.get("second"));
  const zonedAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);

  return zonedAsUtc - date.getTime();
}

function zonedWallTimeToUtc(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  timeZone: string;
}): Date {
  const wallClockUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, input.second);
  let utc = wallClockUtc;

  for (let i = 0; i < 3; i += 1) {
    const offset = getTimeZoneOffsetMs(new Date(utc), input.timeZone);
    const next = wallClockUtc - offset;
    if (Math.abs(next - utc) < 1000) break;
    utc = next;
  }

  return new Date(utc);
}

function addDaysToDateLabel(dateLabel: string, days: number, timeZone: string): string {
  const { year, month, day } = parseDateLabel(dateLabel);
  const localNoonUtc = zonedWallTimeToUtc({ year, month, day, hour: 12, minute: 0, second: 0, timeZone });
  return formatDate(new Date(localNoonUtc.getTime() + days * ONE_DAY_MS), timeZone);
}

function getDateRangeForLabel(dateLabel: string, timeZone: string): { startIso: string; endIso: string } {
  const start = parseDateLabel(dateLabel);
  const end = parseDateLabel(addDaysToDateLabel(dateLabel, 1, timeZone));
  return {
    startIso: zonedWallTimeToUtc({ ...start, hour: 0, minute: 0, second: 0, timeZone }).toISOString(),
    endIso: zonedWallTimeToUtc({ ...end, hour: 0, minute: 0, second: 0, timeZone }).toISOString()
  };
}

function readDailyCursor(value: string | null, startIso: string, endIso: string): { done: boolean; after: string | null } {
  if (!value) return { done: false, after: null };
  if (value.startsWith("done:")) return { done: true, after: null };
  if (value >= startIso && value < endIso) return { done: false, after: value };
  return { done: false, after: null };
}

function normalizeExtractedMemory(value: unknown): ExtractedMemory | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const content = readString(raw.content);
  if (!content) return null;

  return {
    type: readString(raw.type) || "note",
    content,
    importance: clampScore(raw.importance, 0.7),
    confidence: clampScore(raw.confidence, 0.82),
    tags: readStringArray(raw.tags),
    source_message_ids: readStringArray(raw.source_message_ids),
    fact_key: normalizeFactKey(raw.fact_key),
    thread: normalizeThread(raw.thread),
    risk_level: normalizeRiskLevel(raw.risk_level),
    urgency_level: normalizeUrgencyLevel(raw.urgency_level),
    tension_score: normalizeTensionScore(raw.tension_score),
    response_posture: normalizeResponsePosture(raw.response_posture),
    valence: normalizeValence(raw.valence),
    arousal: normalizeArousal(raw.arousal)
  };
}

function normalizeDigestResult(value: unknown): DailyDigestResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;

  const sections = Array.isArray(raw.sections)
    ? raw.sections.flatMap((item): Array<{ heading?: string; content?: string }> => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        const heading = readString(record.heading) ?? undefined;
        const content = readString(record.content) ?? undefined;
        return heading || content ? [{ heading, content }] : [];
      })
    : undefined;

  const important_excerpts = Array.isArray(raw.important_excerpts)
    ? raw.important_excerpts.flatMap((item): ImportantExcerpt[] => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        const quote = readString(record.quote);
        if (!quote) return [];
        return [
          {
            quote,
            reason: readString(record.reason) ?? undefined,
            tags: readStringArray(record.tags),
            source_message_ids: readStringArray(record.source_message_ids)
          }
        ];
      })
    : undefined;

  const memories_to_update = Array.isArray(raw.memories_to_update)
    ? raw.memories_to_update.flatMap((item): DigestMemoryUpdate[] => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        const targetId = readString(record.target_id);
        if (!targetId) return [];
        return [
          {
            target_id: targetId,
            content: readString(record.content) ?? undefined,
            type: readString(record.type) ?? undefined,
            importance: typeof record.importance === "number" ? clampScore(record.importance, 0.7) : undefined,
            confidence: typeof record.confidence === "number" ? clampScore(record.confidence, 0.82) : undefined,
            tags: Array.isArray(record.tags) ? readStringArray(record.tags) : undefined,
            fact_key: record.fact_key === undefined ? undefined : normalizeFactKey(record.fact_key),
            thread: record.thread === undefined ? undefined : normalizeThread(record.thread),
            risk_level: record.risk_level === undefined ? undefined : normalizeRiskLevel(record.risk_level),
            urgency_level: record.urgency_level === undefined ? undefined : normalizeUrgencyLevel(record.urgency_level),
            tension_score: record.tension_score === undefined ? undefined : normalizeTensionScore(record.tension_score),
            response_posture:
              record.response_posture === undefined ? undefined : normalizeResponsePosture(record.response_posture),
            valence: record.valence === undefined ? undefined : normalizeValence(record.valence),
            arousal: record.arousal === undefined ? undefined : normalizeArousal(record.arousal)
          }
        ];
      })
    : undefined;

  const memories_to_delete = Array.isArray(raw.memories_to_delete)
    ? raw.memories_to_delete.flatMap((item): DigestMemoryDelete[] => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        const targetId = readString(record.target_id);
        return targetId ? [{ target_id: targetId, reason: readString(record.reason) ?? undefined }] : [];
      })
    : undefined;

  return {
    date: readString(raw.date) ?? undefined,
    title: readString(raw.title) ?? undefined,
    summary: readString(raw.summary) ?? undefined,
    sections,
    important_excerpts,
    memories_to_add: Array.isArray(raw.memories_to_add)
      ? raw.memories_to_add.flatMap((item): ExtractedMemory[] => {
          const memory = normalizeExtractedMemory(item);
          return memory ? [memory] : [];
        })
      : undefined,
    memories_to_update,
    memories_to_delete
  };
}

function formatTranscript(messages: MessageRecord[]): string {
  return messages
    .map((message) => {
      const role = message.role === "assistant" ? "我(助手)" : "用户";
      return `[${message.id}][${message.created_at}][${role}] ${truncate(message.content.trim(), 700)}`;
    })
    .join("\n\n");
}

function formatExistingMemories(memories: MemoryApiRecord[]): string {
  if (memories.length === 0) return "[]";
  return JSON.stringify(
    memories.map((memory) => ({
      id: memory.id,
      type: memory.type,
      content: truncate(memory.content, 260),
      importance: memory.importance,
      confidence: memory.confidence,
      pinned: memory.pinned,
      tags: memory.tags,
      fact_key: memory.fact_key,
      thread: memory.thread,
      risk_level: memory.risk_level,
      urgency_level: memory.urgency_level,
      tension_score: memory.tension_score,
      response_posture: memory.response_posture
    })),
    null,
    2
  );
}

function buildDigestPrompt(input: {
  dateLabel: string;
  startIso: string;
  endIso: string;
  messages: MessageRecord[];
  existingMemories: MemoryApiRecord[];
  excerptLimit: number;
  hasMore: boolean;
}): string {
  return [
    "你是 kld 的 nightly dream 记忆整理器。你的任务不是简单总结，而是在她休息时整理长期记忆。",
    "你会读取旧长期记忆和当天聊天 transcript，产出一份更干净、更一致、更有用的 memory store 更新计划。",
    "只输出 JSON，不要 markdown，不要解释，不要输出思考过程。",
    "",
    "Dream 目标：",
    "- 合并重复记忆，避免同一事实以多个版本长期存在。",
    "- 发现过时、被新信息否定、互相矛盾的旧记忆，并更新或删除。",
    "- 从聊天中提炼未来会影响回答的稳定偏好、项目状态、关系事实、承诺、边界和重要原文。",
    "- 形成下一次对话可直接使用的简洁记忆，而不是保存流水账。",
    "",
    "窗口：",
    `- 你只能处理 ${input.dateLabel} 这一天窗口内的聊天。窗口是 ${input.startIso} 到 ${input.endIso}。`,
    input.hasMore ? "- 这是当天的一批聊天，不是完整一天；只整理这一批里明确出现的信息。" : "- 这是当天最后一批或完整批次。",
    "",
    "总原则：",
    "- 原始聊天不要逐条变成记忆，只保留未来真的会用到的事实、偏好、边界、项目进展、承诺。",
    "- 宁可少记，也不要把临时语气、寒暄、重复话、空内容、调试内容写进长期记忆。",
    "- 当旧记忆和新信息冲突时，优先更新或删除旧记忆，不要并排留下互相打架的版本。",
    "- 当新信息只是旧记忆的更准确版本，优先 memories_to_update，不要 memories_to_add。",
    "- 当多条旧记忆重复，保留更完整的一条并删除重复项；必要时先 update 保留项。",
    "- pinned=true 的旧记忆不能删除，只能在 memories_to_update 中提出更保守的补充。",
    "- 站在“我=助手”的视角写。关于她，用“你……”；关于助手承诺，用“我需要……”。",
    "- 不要提到 D1、Vectorize、RAG、数据库、记忆系统、代理层等实现细节。",
    "",
    "Dream 输出格式：",
    "- title 是 12 字以内标题。",
    "- summary 写成一段简短自然中文，描述这次 dream 整理出了什么。",
    "- sections 最多 3 段，每段有 heading 和 content；没有必要可以给空数组。",
    `- important_excerpts 最多 ${input.excerptLimit} 条，quote 必须是值得保留的原文片段。`,
    "- memories_to_add 最多 8 条，每条要短、稳定、可复用。",
    "- memories_to_update 只针对给出的旧记忆 id。",
    "- memories_to_delete 只删除空、重复、明显过期或被新信息否定的旧记忆。",
    "- memories_to_add 可以附带 LMC-5 坐标：fact_key 是稳定事实槽，thread 是主题线，risk_level 只能 low/normal/medium/high，urgency_level 只能 low/normal/medium/high，tension_score 是 0-1，valence 是 -1 到 1（正=愉悦，负=难受），arousal 是 0-1（越高越激动），response_posture 是未来回应姿态。",
    "- fact_key 不确定就输出 null，不要为了分类硬编事实槽。",
    "- valence/arousal 不确定就输出 null，不要硬猜情绪。",
    "- 控制总输出长度，宁可少写也不要输出超长 JSON。",
    "",
    "输出 JSON 结构：",
    JSON.stringify({
      date: input.dateLabel,
      title: "夜间整理",
      summary: "这次 dream 合并了重复记忆，更新了项目状态，并保留了关键原文。",
      sections: [{ heading: "整理结果", content: "……" }],
      important_excerpts: [
        {
          quote: "她或助手说过的关键原文",
          reason: "为什么值得保留",
          tags: ["project"],
          source_message_ids: ["msg_x"]
        }
      ],
      memories_to_add: [
        {
          type: "project",
          content: "你正在简化 kld 的记忆写入策略。",
          importance: 0.86,
          confidence: 0.92,
          tags: ["project", "kld"],
          fact_key: "project:kld_memory_strategy",
          thread: "kld",
          risk_level: "normal",
          urgency_level: "normal",
          tension_score: 0.2,
          valence: null,
          arousal: null,
          response_posture: "技术讨论中直接推进，优先保持现有功能兼容",
          source_message_ids: ["msg_x"]
        }
      ],
      memories_to_update: [
        {
          target_id: "mem_x",
          content: "更新后的旧记忆正文",
          type: "project",
          importance: 0.88,
          confidence: 0.9,
          tags: ["project"]
        }
      ],
      memories_to_delete: [{ target_id: "mem_y", reason: "空内容或重复" }]
    }),
    "",
    "旧长期记忆候选：",
    formatExistingMemories(input.existingMemories),
    "",
    "今日原始聊天：",
    formatTranscript(input.messages)
  ].join("\n");
}

function formatDailySummary(result: DailyDigestResult, dateLabel: string, messages: MessageRecord[]): string {
  const parts = [
    `# ${result.date || dateLabel} ${result.title || "Dream 摘要"}`,
    "",
    result.summary || `${dateLabel} dream 共整理 ${messages.length} 条聊天。`
  ];

  for (const section of result.sections ?? []) {
    if (!section.heading && !section.content) continue;
    parts.push("", `## ${section.heading || "要点"}`, section.content || "");
  }

  return parts.join("\n").trim();
}

async function callDigestModel(
  env: Env,
  prompt: string,
  meta: { dateLabel: string; messageCount: number; memoryCount: number; hasMore: boolean }
): Promise<DigestModelCallResult> {
  const model = readDreamModel(env);
  if (!model) {
    console.error("dream: missing model");
    return { digest: null, reason: "missing_model" };
  }

  const request: OpenAIChatRequest = {
    model,
    messages: [
      { role: "system", content: "你是严格的 JSON 生成器。你只输出 JSON，不要输出思考过程。" },
      { role: "user", content: prompt }
    ],
    temperature: 0,
    max_tokens: readDreamMaxTokens(env),
    response_format: { type: "json_object" },
    stream: false
  };

  const startedAt = Date.now();
  console.log("dream: calling model", {
    date: meta.dateLabel,
    model,
    messageCount: meta.messageCount,
    memoryCount: meta.memoryCount,
    hasMore: meta.hasMore,
    promptChars: prompt.length,
    maxTokens: request.max_tokens
  });

  try {
    const response = await callOpenAICompat(env, request);
    const elapsedMs = Date.now() - startedAt;
    if (!response.ok) {
      console.error("dream: model returned non-ok", {
        date: meta.dateLabel,
        model,
        status: response.status,
        statusText: response.statusText,
        elapsedMs
      });
      return { digest: null, reason: "model_error", model, status: response.status };
    }
    const parsed = (await response.json()) as OpenAIChatResponse;
    const choice = parsed.choices?.[0];
    const message = choice?.message as ({ content?: unknown; reasoning_content?: unknown }) | undefined;
    const content = typeof message?.content === "string" ? message.content.trim() : "";
    const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "";
    const json = extractJsonObject(content || reasoning);
    if (!json) {
      console.error("dream: model returned invalid JSON", {
        date: meta.dateLabel,
        model,
        elapsedMs,
        finishReason: choice?.finish_reason ?? null,
        contentChars: content.length,
        reasoningChars: reasoning.length
      });
      return { digest: null, reason: "model_invalid_json", model, finishReason: choice?.finish_reason };
    }
    console.log("dream: model returned valid JSON", {
      date: meta.dateLabel,
      model,
      elapsedMs,
      finishReason: choice?.finish_reason ?? null,
      contentChars: content.length,
      reasoningChars: reasoning.length
    });
    return { digest: normalizeDigestResult(json), model };
  } catch (error) {
    console.error("dream model failed", {
      date: meta.dateLabel,
      model,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error && error.message ? error.message : String(error)
    });
    return { digest: null, reason: "model_error", model };
  }
}

async function cleanEmptyMemories(env: Env, namespace: string): Promise<number> {
  const minChars = readPositiveInt(env.EMPTY_MEMORY_MIN_CHARS, DEFAULT_EMPTY_MEMORY_MIN_CHARS, 20);
  let records: MemoryRecord[];
  try {
    records = await listMemories(env.DB, { namespace, status: "active", limit: 1000 });
  } catch (error) {
    console.error("dream: failed to list memories for cleanup", error);
    return 0;
  }
  const empty = records.filter((record) => !record.pinned && record.content.trim().length < minChars);

  for (const record of empty) {
    await deleteSyncedMemory(env, namespace, record.id);
  }

  return empty.length;
}

async function saveDailySummaryMemory(
  env: Env,
  input: { namespace: string; dateLabel: string; content: string; messageIds: string[] }
): Promise<void> {
  await createSyncedMemory(env, {
    namespace: input.namespace,
    type: "daily_summary",
    content: input.content,
    importance: 0.66,
    confidence: 0.9,
    thread: `timeline:${input.dateLabel}`,
    tags: ["dream-summary", "daily-summary", input.dateLabel],
    source: "dream",
    sourceMessageIds: input.messageIds
  });
}

function shouldSaveDailySummaryMemory(env: Env): boolean {
  return env.ENABLE_DAILY_SUMMARY_MEMORY === "true";
}

async function saveImportantExcerpts(
  env: Env,
  input: { namespace: string; dateLabel: string; excerpts: ImportantExcerpt[]; fallbackMessageIds: string[] }
): Promise<number> {
  let saved = 0;
  const limit = readDreamExcerptLimit(env);

  for (const excerpt of input.excerpts.slice(0, limit)) {
    const quote = readString(excerpt.quote);
    if (!quote) continue;
    const reason = readString(excerpt.reason);
    const content = [`【${input.dateLabel} 重要原文】`, quote, reason ? `保存原因：${reason}` : ""]
      .filter(Boolean)
      .join("\n");

    await createSyncedMemory(env, {
      namespace: input.namespace,
      type: "excerpt",
      content,
      importance: 0.72,
      confidence: 0.9,
      tags: uniqueStrings(["important-excerpt", input.dateLabel, ...(excerpt.tags ?? [])]),
      source: "dream",
      sourceMessageIds: excerpt.source_message_ids?.length ? excerpt.source_message_ids : input.fallbackMessageIds
    });
    saved += 1;
  }

  return saved;
}

async function queueMemoryMutationReviews(
  env: Env,
  input: { namespace: string; updates: DigestMemoryUpdate[]; deletes: DigestMemoryDelete[] }
): Promise<{ updateReviewsQueued: number; deleteReviewsQueued: number }> {
  const updates: DigestMemoryUpdate[] = [];
  const deletes: DigestMemoryDelete[] = [];

  for (const item of input.updates) {
    const existing = await getMemoryById(env.DB, { namespace: input.namespace, id: item.target_id });
    if (existing?.status === "active") updates.push(item);
  }
  for (const item of input.deletes) {
    const existing = await getMemoryById(env.DB, { namespace: input.namespace, id: item.target_id });
    if (existing?.status === "active" && !existing.pinned) deletes.push(item);
  }

  if (updates.length || deletes.length) {
    await createMemoryEvent(env.DB, {
      namespace: input.namespace,
      eventType: "dream_mutation_review",
      payload: {
        policy: "review_first",
        updates,
        deletes,
        note: "Dream may propose changes, but only an explicit audited approval may mutate existing memories."
      }
    });
  }
  return { updateReviewsQueued: updates.length, deleteReviewsQueued: deletes.length };
}

async function recordDryRunPlan(
  env: Env,
  input: { namespace: string; dateLabel: string; digest: DailyDigestResult; messageIds: string[] }
): Promise<void> {
  await createMemoryEvent(env.DB, {
    namespace: input.namespace,
    eventType: "dream_dry_run",
    payload: {
      date: input.dateLabel,
      title: input.digest.title,
      summary: input.digest.summary,
      memories_to_add: (input.digest.memories_to_add ?? []).map((memory) => ({
        type: memory.type,
        content: truncate(memory.content, 200),
        importance: memory.importance,
        fact_key: memory.fact_key,
        thread: memory.thread
      })),
      memories_to_update: input.digest.memories_to_update ?? [],
      memories_to_delete: input.digest.memories_to_delete ?? [],
      excerpt_count: (input.digest.important_excerpts ?? []).length,
      source_message_ids: input.messageIds.slice(0, 50)
    }
  });
}

export async function runDailyMemoryDigest(
  env: Env,
  namespace: string,
  options: { dateLabel?: string; force?: boolean } = {}
): Promise<DailyDigestRunResult> {
  if (!isDreamEnabled(env)) return { ran: false, mode: "dream", reason: "dream_disabled" };

  const dryRun = isDryRun(env);
  const timeZone = readDreamTimeZone(env);
  const dateLabel = readString(options.dateLabel) || getTargetDigestDateLabel(timeZone);
  const { startIso, endIso } = getDateRangeForLabel(dateLabel, timeZone);
  const cursorName = `dream:${namespace}:${dateLabel}`;
  const cursor = await readCursor(env.DB, cursorName);
  const cursorState = options.force ? { done: false, after: null } : readDailyCursor(cursor, startIso, endIso);
  if (cursorState.done) {
    return { ran: false, mode: "dream", date: dateLabel, reason: "already_done", startIso, endIso, cursor };
  }

  const maxMessages = readDreamMaxMessages(env);
  const messages = await listMessagesByNamespaceInRange(env.DB, {
    namespace,
    startCreatedAt: startIso,
    endCreatedAt: endIso,
    afterCreatedAt: cursorState.after,
    limit: maxMessages
  });
  if (messages.length === 0) {
    await writeCursor(env.DB, cursorName, `done:${cursorState.after ?? startIso}`);
    return { ran: false, mode: "dream", date: dateLabel, reason: "no_messages", startIso, endIso, cursor };
  }

  const lastMessage = messages[messages.length - 1];
  const hasMore = messages.length >= maxMessages;
  const memoryContextLimit = readDreamMemoryContextLimit(env);
  let existingMemories: MemoryApiRecord[] = [];
  try {
    const records = await listMemories(env.DB, { namespace, status: "active", limit: memoryContextLimit });
    existingMemories = records.map((record) => toMemoryApiRecord(record));
  } catch (error) {
    console.error("dream: failed to list existing memories", error);
  }

  const cleanedEmptyMemories = dryRun ? 0 : await cleanEmptyMemories(env, namespace);

  const prompt = buildDigestPrompt({
    dateLabel,
    startIso,
    endIso,
    messages,
    existingMemories,
    excerptLimit: readDreamExcerptLimit(env),
    hasMore
  });
  const modelResult = await callDigestModel(env, prompt, {
    dateLabel,
    messageCount: messages.length,
    memoryCount: existingMemories.length,
    hasMore
  });
  const digest = modelResult.digest;
  if (!digest) {
    console.error("dream: model did not return valid JSON; cursor not advanced", {
      reason: modelResult.reason,
      model: modelResult.model,
      status: modelResult.status
    });
    return {
      ran: false,
      mode: "dream",
      date: dateLabel,
      reason: modelResult.reason ?? "model_error",
      startIso,
      endIso,
      cursor,
      processedMessages: messages.length,
      model: modelResult.model,
      status: modelResult.status,
      finishReason: modelResult.finishReason
    };
  }

  const messageIds = messages.map((message) => message.id);

  if (dryRun) {
    await recordDryRunPlan(env, { namespace, dateLabel, digest, messageIds });
    await writeCursor(env.DB, cursorName, hasMore ? lastMessage.created_at : `done:${lastMessage.created_at}`);
    console.log("dream: dry-run plan recorded", { date: dateLabel, namespace, hasMore });
    return {
      ran: true,
      stats: {
        date: dateLabel,
        mode: "dream",
        dryRun: true,
        processedMessages: messages.length,
        addedMemories: 0,
        updatedMemories: 0,
        deletedMemories: 0,
        updateReviewsQueued: (digest.memories_to_update ?? []).length,
        deleteReviewsQueued: (digest.memories_to_delete ?? []).length,
        savedExcerpts: 0,
        cleanedEmptyMemories: 0,
        cursorAdvanced: true,
        hasMore
      },
      plan: digest
    };
  }

  const summaryContent = formatDailySummary(digest, dateLabel, messages);

  await upsertSummary(env.DB, {
    namespace,
    content: summaryContent,
    fromMessageId: messages[0]?.id ?? null,
    toMessageId: lastMessage.id,
    messageCount: messages.length
  });
  if (shouldSaveDailySummaryMemory(env)) {
    await saveDailySummaryMemory(env, { namespace, dateLabel, content: summaryContent, messageIds });
  }

  const mutationReviews = await queueMemoryMutationReviews(env, {
    namespace,
    updates: digest.memories_to_update ?? [],
    deletes: digest.memories_to_delete ?? []
  });

  let addedMemories = 0;
  for (const memory of digest.memories_to_add ?? []) {
    const saved = await createSyncedMemory(env, {
      namespace,
      type: memory.type,
      content: memory.content,
      importance: memory.importance,
      confidence: memory.confidence,
      tags: memory.tags,
      factKey: memory.fact_key,
      thread: memory.thread,
      riskLevel: memory.risk_level,
      urgencyLevel: memory.urgency_level,
      tensionScore: memory.tension_score,
      responsePosture: memory.response_posture,
      valence: memory.valence,
      arousal: memory.arousal,
      source: "dream",
      sourceMessageIds: memory.source_message_ids.length ? memory.source_message_ids : messageIds
    });
    if (saved) addedMemories += 1;
  }

  const savedExcerpts = await saveImportantExcerpts(env, {
    namespace,
    dateLabel,
    excerpts: digest.important_excerpts ?? [],
    fallbackMessageIds: messageIds
  });

  await writeCursor(env.DB, cursorName, hasMore ? lastMessage.created_at : `done:${lastMessage.created_at}`);

  return {
    ran: true,
    stats: {
      date: dateLabel,
      mode: "dream",
      dryRun: false,
      processedMessages: messages.length,
      addedMemories,
      updatedMemories: 0,
      deletedMemories: 0,
      updateReviewsQueued: mutationReviews.updateReviewsQueued,
      deleteReviewsQueued: mutationReviews.deleteReviewsQueued,
      savedExcerpts,
      cleanedEmptyMemories,
      cursorAdvanced: true,
      hasMore
    }
  };
}

