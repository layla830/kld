import { createMemoryEvent } from "../db/memoryEvents";
import { listMemories } from "../db/memories";
import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, MemoryRecord, OpenAIChatRequest, OpenAIChatResponse } from "../types";
import { extractJsonObject } from "../utils/jsonHelpers";

const NARRATIVE_MAX_MEMORIES = 60;
const NARRATIVE_SEED_LIMIT = 40;

interface NarrativeSeed {
  id: string;
  content: string;
  type: string;
  importance: number;
  valence: number | null;
  arousal: number | null;
  created_at: string;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getWeekLabel(date: Date, timeZone = "Asia/Shanghai"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function getMonthLabel(date: Date, timeZone = "Asia/Shanghai"): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "long" }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value ?? "";
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  return `${year}-${month}`;
}

function isMonthlyFirstDays(now: Date, maxDays = 3): boolean {
  return now.getDate() <= maxDays;
}

function buildNarrativePrompt(input: { period: string; label: string; seeds: NarrativeSeed[] }): string {
  return [
    `你是叙事索引器。给${input.period}的记忆生成一个简短的叙事标题和摘要段落。`,
    "只输出 JSON，不要 markdown，不要解释。",
    "",
    "要求：",
    "- title: 12字以内",
    "- summary: 一段自然中文，100-200字，描述这段时间的核心主题和情感走向",
    "- 使用明确的第三人称主体：用户事实写‘用户（Layla）’，助手行为写‘KLD’",
    "- 不使用含混的‘我、你、她’，不要把 KLD 的推断写成用户事实",
    "- 不要提到记忆系统、数据库等实现细节",
    "",
    "输出格式：",
    JSON.stringify({ title: "标题", summary: "摘要段落" }),
    "",
    `${input.period}记忆种子（${input.label}）：`,
    JSON.stringify(input.seeds.map((s) => ({ type: s.type, content: s.content.slice(0, 150), importance: s.importance, valence: s.valence, arousal: s.arousal })))
  ].join("\n");
}

async function generateNarrative(
  env: Env,
  input: { period: string; label: string; seeds: NarrativeSeed[] }
): Promise<{ title: string; summary: string } | null> {
  const model = env.DREAM_MODEL || env.MEMORY_MODEL || env.SUMMARY_MODEL;
  if (!model || input.seeds.length === 0) return null;

  const request: OpenAIChatRequest = {
    model,
    messages: [
      { role: "system", content: "你是严格的 JSON 生成器。只输出 JSON。" },
      { role: "user", content: buildNarrativePrompt(input) }
    ],
    temperature: 0,
    max_tokens: 400,
    response_format: { type: "json_object" },
    stream: false
  };

  try {
    const response = await callOpenAICompat(env, request);
    if (!response.ok) return null;
    const parsed = (await response.json()) as OpenAIChatResponse;
    const content = (parsed.choices?.[0]?.message as { content?: unknown })?.content;
    const json = extractJsonObject(typeof content === "string" ? content : "");
    if (!json || typeof json !== "object") return null;
    const title = readString((json as { title?: unknown }).title);
    const summary = readString((json as { summary?: unknown }).summary);
    if (!title || !summary) return null;
    return { title, summary };
  } catch {
    return null;
  }
}

function pickSeedsByWeight(memories: MemoryRecord[], limit: number): NarrativeSeed[] {
  return memories
    .map((m) => ({
      id: m.id,
      content: m.content,
      type: m.type,
      importance: m.importance,
      valence: m.valence,
      arousal: m.arousal,
      created_at: m.created_at,
      weight: m.importance * (1 + (m.arousal ?? 0) * 0.3),
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

export async function runNarrativeTimeline(
  env: Env,
  namespace: string,
  options: { timeZone?: string; now?: Date } = {}
): Promise<{ weekly: { generated: boolean; title?: string; summary?: string }; monthly: { generated: boolean; title?: string; summary?: string } }> {
  const timeZone = options.timeZone || "Asia/Shanghai";
  const now = options.now ?? new Date();
  const weekLabel = getWeekLabel(now, timeZone);
  const monthLabel = getMonthLabel(now, timeZone);

  const memories = await listMemories(env.DB, { namespace, status: "active", limit: NARRATIVE_MAX_MEMORIES });
  const seeds = pickSeedsByWeight(memories, NARRATIVE_SEED_LIMIT);

  const weeklyNarrative = await generateNarrative(env, { period: "本周", label: weekLabel, seeds });
  if (weeklyNarrative) {
    await createMemoryEvent(env.DB, {
      namespace,
      eventType: "narrative_weekly",
      payload: { period: "weekly", label: weekLabel, title: weeklyNarrative.title, summary: weeklyNarrative.summary, seed_ids: seeds.map((s) => s.id).slice(0, 20) }
    });
  }

  let monthlyNarrative: { title: string; summary: string } | null = null;
  if (isMonthlyFirstDays(now)) {
    monthlyNarrative = await generateNarrative(env, { period: "本月", label: monthLabel, seeds });
    if (monthlyNarrative) {
      await createMemoryEvent(env.DB, {
        namespace,
        eventType: "narrative_monthly",
        payload: { period: "monthly", label: monthLabel, title: monthlyNarrative.title, summary: monthlyNarrative.summary, seed_ids: seeds.map((s) => s.id).slice(0, 20) }
      });
    }
  }

  return {
    weekly: { generated: Boolean(weeklyNarrative), title: weeklyNarrative?.title, summary: weeklyNarrative?.summary },
    monthly: { generated: Boolean(monthlyNarrative), title: monthlyNarrative?.title, summary: monthlyNarrative?.summary }
  };
}

export async function runTimelineSweep(
  env: Env,
  namespace: string,
  options: { threads?: string[] } = {}
): Promise<{ threadsScanned: number; events: number }> {
  const threads = options.threads ?? [];
  let events = 0;
  let threadsScanned = 0;

  for (const thread of threads) {
    threadsScanned += 1;
    const memories = await listMemories(env.DB, { namespace, thread, status: "active", limit: 50 });
    if (memories.length === 0) continue;

    const openMemories = memories.filter((m) => !m.expires_at || Date.parse(m.expires_at) > Date.now());
    if (openMemories.length === 0) continue;

    await createMemoryEvent(env.DB, {
      namespace,
      eventType: "timeline_sweep",
      payload: {
        thread,
        active_count: openMemories.length,
        oldest: openMemories[openMemories.length - 1]?.created_at ?? null,
        newest: openMemories[0]?.created_at ?? null,
        needs_attention: openMemories.length > 30
      }
    });
    events += 1;
  }

  return { threadsScanned, events };
}
