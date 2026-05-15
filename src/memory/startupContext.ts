import type { MemoryRecord } from "../types";

interface StartupMemory {
  id: string;
  type: string;
  content: string;
  importance: number;
  pinned: boolean;
  tags: string[];
  created_at: string;
}

interface StartupGuidance {
  content: string;
  source: string[];
}

const DYNAMIC_STARTUP_RULES_SINCE = "2026-05-07T16:00:00.000Z";

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

function compactText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars).trimEnd()}...`;
}

function toStartupMemory(record: MemoryRecord): StartupMemory {
  const tags = parseJsonArray(record.tags);
  return {
    id: record.id,
    type: record.type,
    content: compactText((record.summary || record.content).trim(), 520),
    importance: record.importance,
    pinned: Boolean(record.pinned),
    tags,
    created_at: (record.created_at || "").slice(0, 10)
  };
}

function toStartupGuidance(record: MemoryRecord): StartupGuidance {
  const tags = parseJsonArray(record.tags);
  return {
    content: compactText((record.summary || record.content).trim(), 160),
    source: [record.id, ...tags.filter((tag) => tag !== "startup_rule").slice(0, 3)]
  };
}

async function queryStartupMemories(db: D1Database, sql: string, binds: unknown[] = []): Promise<StartupMemory[]> {
  const result = await db.prepare(sql).bind(...binds).all<MemoryRecord>();
  return (result.results ?? []).map((record) => toStartupMemory(record));
}

async function queryStartupRules(db: D1Database, namespace: string): Promise<StartupGuidance[]> {
  const result = await db.prepare(
    `SELECT * FROM memories
     WHERE namespace = ? AND status = 'active'
       AND created_at >= ?
       AND (type = 'startup_rule' OR tags LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')
     ORDER BY pinned DESC, importance DESC, updated_at DESC, created_at DESC
     LIMIT 5`
  ).bind(namespace, DYNAMIC_STARTUP_RULES_SINCE, likePattern("启动规则"), likePattern("startup_rule")).all<MemoryRecord>();
  return (result.results ?? []).map((record) => toStartupGuidance(record));
}

async function queryRecentRulesAndLessons(db: D1Database, namespace: string): Promise<StartupGuidance[]> {
  const result = await db.prepare(
    `SELECT * FROM memories
     WHERE namespace = ? AND status = 'active'
       AND type IN ('rule', 'lesson')
     ORDER BY created_at DESC, updated_at DESC
     LIMIT 5`
  ).bind(namespace).all<MemoryRecord>();
  return (result.results ?? []).map((record) => toStartupGuidance(record));
}

export async function buildStartupContext(db: D1Database, namespace = "default"): Promise<Record<string, unknown>> {
  const startupRules = await queryStartupRules(db, namespace);
  const recentRulesAndLessons = await queryRecentRulesAndLessons(db, namespace);
  const pinned = await queryStartupMemories(
    db,
    `SELECT * FROM memories
     WHERE namespace = ? AND status = 'active' AND pinned = 1
     ORDER BY importance DESC, updated_at DESC, created_at DESC
     LIMIT 12`,
    [namespace]
  );
  const currentHandoff = await queryStartupMemories(
    db,
    `SELECT * FROM memories
     WHERE namespace = ? AND status = 'active'
       AND (tags LIKE '%handoff%' OR tags LIKE '%交接%')
     ORDER BY updated_at DESC
     LIMIT 2`,
    [namespace]
  );
  const recentDiary = await queryStartupMemories(
    db,
    `SELECT * FROM memories
     WHERE namespace = ? AND status = 'active' AND type IN ('diary', 'layla_diary')
     ORDER BY created_at DESC
     LIMIT 3`,
    [namespace]
  );

  return {
    startup_version: "2.7-database-pinned-startup",
    startup_rules_since: DYNAMIC_STARTUP_RULES_SINCE,
    startup_rules_count: startupRules.length,
    recent_rules_and_lessons_count: recentRulesAndLessons.length,
    pinned_count: pinned.length,
    current_handoff_count: currentHandoff.length,
    recent_diary_count: recentDiary.length,
    startup_rules: startupRules,
    recent_rules_and_lessons: recentRulesAndLessons,
    pinned,
    current_handoff: currentHandoff,
    recent_diary: recentDiary
  };
}
