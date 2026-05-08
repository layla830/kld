import type { Env, MemoryRecord } from "../../types";
import { like, moodOf, PAGE_SIZE, parseTags, type PageInput } from "./utils";

export interface HeatDay {
  day: string;
  count: number;
  mood: string;
}

export interface BoardStats {
  active: number;
  deleted: number;
  total: number;
  vectorized: number;
}

export async function fetchTypes(env: Env): Promise<Array<{ type: string; count: number }>> {
  const result = await env.DB.prepare("SELECT type, COUNT(*) AS count FROM memories WHERE namespace = 'default' AND status = 'active' GROUP BY type ORDER BY type").all<{ type: string; count: number }>();
  return result.results ?? [];
}

export async function fetchQuoteCategories(env: Env): Promise<string[]> {
  const result = await env.DB.prepare("SELECT tags FROM memories WHERE namespace = 'default' AND status = 'active' AND tags LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 300").bind(like("语录")).all<{ tags: string | null }>();
  const categories = new Set<string>();
  for (const row of result.results ?? []) {
    for (const tag of parseTags(row.tags)) {
      if (tag && tag !== "语录" && tag !== "admin-board" && !tag.startsWith("mood:")) categories.add(tag);
    }
  }
  return [...categories].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

export async function fetchStats(env: Env): Promise<BoardStats> {
  const result = await env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status = 'deleted' THEN 1 ELSE 0 END) AS deleted, SUM(CASE WHEN vector_id IS NOT NULL AND vector_id != '' THEN 1 ELSE 0 END) AS vectorized FROM memories WHERE namespace = 'default'").first<BoardStats>();
  return { active: result?.active ?? 0, deleted: result?.deleted ?? 0, total: result?.total ?? 0, vectorized: result?.vectorized ?? 0 };
}

export async function fetchHeatmap(env: Env): Promise<HeatDay[]> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 89);
  const rows = await env.DB.prepare("SELECT created_at, tags FROM memories WHERE namespace = 'default' AND status = 'active' AND created_at >= ?").bind(since.toISOString().slice(0, 10)).all<{ created_at: string | null; tags: string | null }>();
  const counts = new Map<string, number>();
  const moods = new Map<string, Map<string, number>>();
  for (const row of rows.results ?? []) {
    if (!row.created_at) continue;
    const day = row.created_at.slice(0, 10);
    counts.set(day, (counts.get(day) || 0) + 1);
    const mood = moodOf(row.tags);
    if (!mood) continue;
    const moodCounts = moods.get(day) || new Map<string, number>();
    moodCounts.set(mood, (moodCounts.get(mood) || 0) + 1);
    moods.set(day, moodCounts);
  }
  const days: HeatDay[] = [];
  for (let i = 89; i >= 0; i -= 1) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - i);
    const day = date.toISOString().slice(0, 10);
    const moodCounts = moods.get(day);
    const mood = moodCounts ? [...moodCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "" : "";
    days.push({ day, count: counts.get(day) ?? 0, mood });
  }
  return days;
}

function applyTabWhere(input: PageInput, binds: unknown[]): string {
  if (input.tab === "message") {
    binds.push(like("留言"), like("unread"), "message");
    return " AND (tags LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR type = ?)";
  }
  if (input.tab === "diary") {
    binds.push("diary", "layla_diary", like("日记"));
    return " AND (type IN (?, ?) OR tags LIKE ? ESCAPE '\\')";
  }
  if (input.tab === "quote") {
    binds.push(like("语录"));
    let clause = " AND tags LIKE ? ESCAPE '\\'";
    if (input.category) {
      clause += " AND tags LIKE ? ESCAPE '\\'";
      binds.push(like(input.category));
    }
    return clause;
  }
  return "";
}

function orderByForTab(tab: string): string {
  return tab === "message" || tab === "diary" || tab === "quote"
    ? "ORDER BY created_at DESC, updated_at DESC"
    : "ORDER BY pinned DESC, updated_at DESC, created_at DESC";
}

export async function fetchMemories(env: Env, input: PageInput): Promise<{ total: number; records: MemoryRecord[] }> {
  let where = "WHERE namespace = 'default'";
  const binds: unknown[] = [];

  if (input.status !== "all") {
    where += " AND status = ?";
    binds.push(input.status);
  }
  where += applyTabWhere(input, binds);

  if (input.type && input.tab === "browse") {
    where += " AND type = ?";
    binds.push(input.type);
  }
  if (input.tag && input.tab === "browse") {
    where += " AND tags LIKE ? ESCAPE '\\'";
    binds.push(like(input.tag));
  }
  if (input.mood && input.tab === "browse") {
    where += " AND tags LIKE ? ESCAPE '\\'";
    binds.push(like(`mood:${input.mood}`));
  }
  if (input.date && input.tab === "browse") {
    where += " AND substr(created_at, 1, 10) = ?";
    binds.push(input.date);
  }
  if (input.q) {
    const pattern = like(input.q);
    where += " AND (content LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR type LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')";
    binds.push(pattern, pattern, pattern, pattern, pattern);
  }

  const offset = (input.page - 1) * PAGE_SIZE;
  const orderBy = orderByForTab(input.tab);
  const [total, result] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM memories ${where}`).bind(...binds).first<{ count: number }>(),
    env.DB.prepare(`SELECT * FROM memories ${where} ${orderBy} LIMIT ? OFFSET ?`).bind(...binds, PAGE_SIZE, offset).all<MemoryRecord>()
  ]);

  return { total: total?.count ?? 0, records: result.results ?? [] };
}
