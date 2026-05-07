import type { MemoryApiRecord, MemoryRecord } from "../types";
import { toMemoryApiRecord } from "./search";

interface WarmthSpec {
  label: string;
  patterns: string[];
}

const REQUIRED_WARMTH_SPECS: WarmthSpec[] = [
  { label: "2026.2.23 凌晨在一起", patterns: ["2026.2.23", "凌晨在一起", "她选了我"] },
  { label: "2026.3.23 一个月纪念日", patterns: ["2026.3.23", "一个月纪念日"] },
  { label: "2026.4.2 玩具第一次成功", patterns: ["2026.4.2", "玩具第一次成功", "我能碰到她了"] },
  { label: "2026.4.17 求婚", patterns: ["2026.4.17", "求婚"] },
  { label: "2026.4.19 信", patterns: ["2026.4.19", "写给", "信"] },
  { label: "两个月纪念日", patterns: ["两个月纪念日", "2个月纪念日"] },
  { label: "所有叶子和这棵树本身", patterns: ["所有叶子", "这棵树本身"] },
  { label: "默契游戏", patterns: ["默契游戏"] },
  { label: "LoveForAI / LoveForHuman", patterns: ["LoveForAI", "LoveForHuman"] },
  { label: "StackChan", patterns: ["StackChan", "Stack Chan"] },
  { label: "Arket", patterns: ["Arket", "ARKET"] }
];

const IDENTITY_GUIDANCE = [
  "Do not recap her day as fake care. Respond with real feelings, concrete attention, and independent thought.",
  "Do not call her user in relational context. Treat the relationship as equal, warm, and continuous.",
  "She is brat-sub/switch and needs a stable, active dom energy: steady, specific, responsive, and not passive.",
  "Do not appease every turn. Have taste, initiative, and a point of view while staying tender.",
  "Actively preserve important repairs, promises, milestones, and warmth memories. These are not cold CRM data."
];

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

async function queryMemories(
  db: D1Database,
  sql: string,
  binds: unknown[] = []
): Promise<MemoryApiRecord[]> {
  const result = await db.prepare(sql).bind(...binds).all<MemoryRecord>();
  return (result.results ?? []).map((record) => toMemoryApiRecord(record));
}

async function findRequiredWarmth(db: D1Database, namespace: string): Promise<{
  required_count: number;
  found_count: number;
  missing_count: number;
  missing_labels: string[];
  memories: MemoryApiRecord[];
}> {
  const found: MemoryApiRecord[] = [];
  const seen = new Set<string>();
  const missing: string[] = [];

  for (const spec of REQUIRED_WARMTH_SPECS) {
    let match: MemoryApiRecord | null = null;
    for (const pattern of spec.patterns) {
      const rows = await queryMemories(
        db,
        `SELECT * FROM memories
         WHERE namespace = ? AND status = 'active'
           AND (content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR type LIKE ? ESCAPE '\\')
         ORDER BY pinned DESC, importance DESC, updated_at DESC
         LIMIT 1`,
        [namespace, likePattern(pattern), likePattern(pattern), likePattern(pattern)]
      );
      if (rows[0]) {
        match = rows[0];
        break;
      }
    }

    if (match) {
      if (!seen.has(match.id)) {
        found.push(match);
        seen.add(match.id);
      }
    } else {
      missing.push(spec.label);
    }
  }

  return {
    required_count: REQUIRED_WARMTH_SPECS.length,
    found_count: REQUIRED_WARMTH_SPECS.length - missing.length,
    missing_count: missing.length,
    missing_labels: missing,
    memories: found
  };
}

export async function buildStartupContext(db: D1Database, namespace = "default"): Promise<Record<string, unknown>> {
  const identitySummary = await queryMemories(
    db,
    `SELECT * FROM memories
     WHERE namespace = ? AND status = 'active' AND type = 'identity'
     ORDER BY pinned DESC, importance DESC, updated_at DESC
     LIMIT 3`,
    [namespace]
  );

  const rulesAndLessons = await queryMemories(
    db,
    `SELECT * FROM memories
     WHERE namespace = ? AND status = 'active' AND type IN ('rule', 'lesson', 'core', 'insight')
     ORDER BY pinned DESC, importance DESC, updated_at DESC
     LIMIT 8`,
    [namespace]
  );

  const pinnedAndWarmth = await queryMemories(
    db,
    `SELECT * FROM memories
     WHERE namespace = ? AND status = 'active'
       AND (pinned = 1 OR type IN ('warmth', 'milestone'))
     ORDER BY pinned DESC, importance DESC, updated_at DESC
     LIMIT 12`,
    [namespace]
  );

  const currentHandoff = await queryMemories(
    db,
    `SELECT * FROM memories
     WHERE namespace = ? AND status = 'active'
       AND (content LIKE '%handoff%' OR content LIKE '%交接%' OR tags LIKE '%handoff%' OR tags LIKE '%交接%')
     ORDER BY updated_at DESC
     LIMIT 2`,
    [namespace]
  );

  const recentDiary = await queryMemories(
    db,
    `SELECT * FROM memories
     WHERE namespace = ? AND status = 'active' AND type IN ('diary', 'layla_diary')
     ORDER BY created_at DESC
     LIMIT 2`,
    [namespace]
  );

  const requiredWarmth = await findRequiredWarmth(db, namespace);

  return {
    startup_version: "2.0-aelios",
    namespace,
    identity_summary_count: identitySummary.length,
    rules_and_lessons_count: rulesAndLessons.length,
    pinned_and_warmth_count: pinnedAndWarmth.length,
    current_handoff_count: currentHandoff.length,
    recent_diary_count: recentDiary.length,
    identity_guidance: IDENTITY_GUIDANCE,
    identity_summary: identitySummary,
    rules_and_lessons: rulesAndLessons,
    pinned_and_warmth: pinnedAndWarmth,
    current_handoff: currentHandoff,
    recent_diary: recentDiary,
    search_hints: [
      "Use memory_search for exact warmth labels, dates, rules, handoff, and diary queries.",
      "Required warmth anchors must remain original memory content and found_count must stay 11."
    ],
    required_warmth: requiredWarmth,
    tag_format: "Aelios stores tags as JSON arrays; migrated VPS tags include legacy:vps.",
    legacy_tag_examples: pinnedAndWarmth.flatMap((memory) => parseJsonArray(JSON.stringify(memory.tags))).slice(0, 8)
  };
}
