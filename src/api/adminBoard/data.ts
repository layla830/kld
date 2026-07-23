import { searchMemories } from "../../memory/search";
import { fetchEAxisObservability, type EAxisObservabilityData } from "../../memory/eAxisObservability";
import type { Env, MemoryApiRecord, MemoryRecord } from "../../types";
import { listFiveAxisDeadLetters, type MemoryFiveAxisOutboxRecord } from "../../db/memoryFiveAxisOutbox";
import {
  formatShanghaiDateKey,
  like,
  moodOf,
  PAGE_SIZE,
  parseStoredDate,
  parseTags,
  shanghaiDayUtcRange,
  storedDateToShanghaiDay,
  type PageInput
} from "./utils";

const AUTO_DIARY_TYPE = "auto_diary";
const TIMELINE_SPLIT_SOURCE = "timeline_split";
const TIMELINE_DAY_TYPE = "timeline_day";

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

export interface Lmc5Stats {
  active: number;
  eAxis: number;
  factKeyed: number;
  relations: number;
  reviewCandidates: number;
}

export interface Lmc5RelationEdge {
  source_id: string;
  source_fact_key: string | null;
  source_type: string;
  relation_type: string;
  strength: number;
  target_id: string;
  target_fact_key: string | null;
  target_type: string;
}

export interface Lmc5NodeLink {
  direction: "out" | "in";
  relation_type: string;
  strength: number;
  other_id: string;
  other_fact_key: string | null;
  other_type: string;
  other_content: string;
}

export interface Lmc5MemoryNode {
  id: string;
  type: string;
  fact_key: string | null;
  importance: number;
  thread: string | null;
  risk_level: string | null;
  urgency_level: string | null;
  tension_score: number | null;
  response_posture: string | null;
  content: string;
  relation_count?: number;
  links?: Lmc5NodeLink[];
}

export interface Lmc5DashboardData {
  stats: Lmc5Stats;
  eAxisObservability: EAxisObservabilityData;
  relationTypes: Array<{ relation_type: string; count: number }>;
  clusters: Array<{ title: string; factKeys: string[]; edges: Lmc5RelationEdge[] }>;
  highValueNodes: Lmc5MemoryNode[];
  reviewQueue: Lmc5MemoryNode[];
  duplicateFactKeys: Array<{ fact_key: string; count: number; types: string }>;
  deadLetters: MemoryFiveAxisOutboxRecord[];
}

function appendBrowseHiddenRecordFilter(binds: unknown[]): string {
  binds.push(AUTO_DIARY_TYPE, TIMELINE_SPLIT_SOURCE, TIMELINE_DAY_TYPE, like('"timeline"'));
  return "type != ? AND (source IS NULL OR source != ?) AND type != ? AND (tags IS NULL OR tags NOT LIKE ? ESCAPE '\\')";
}

function isTimelineRecord(record: MemoryRecord): boolean {
  return record.source === TIMELINE_SPLIT_SOURCE || record.type === TIMELINE_DAY_TYPE || parseTags(record.tags).includes("timeline");
}

export async function fetchTypes(env: Env): Promise<Array<{ type: string; count: number }>> {
  const binds: unknown[] = [];
  const hiddenFilter = appendBrowseHiddenRecordFilter(binds);
  const result = await env.DB.prepare(`SELECT type, COUNT(*) AS count FROM memories WHERE namespace = 'default' AND status = 'active' AND ${hiddenFilter} GROUP BY type ORDER BY type`).bind(...binds).all<{ type: string; count: number }>();
  return result.results ?? [];
}
export async function fetchQuoteCategories(env: Env): Promise<string[]> {
  const binds: unknown[] = [];
  const hiddenFilter = appendBrowseHiddenRecordFilter(binds);
  binds.push(like("语录"));
  const result = await env.DB.prepare(`SELECT tags FROM memories WHERE namespace = 'default' AND status = 'active' AND ${hiddenFilter} AND tags LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 300`).bind(...binds).all<{ tags: string | null }>();
  const categories = new Set<string>();
  for (const row of result.results ?? []) {
    for (const tag of parseTags(row.tags)) {
      if (tag && tag !== "语录" && tag !== "admin-board" && !tag.startsWith("mood:")) categories.add(tag);
    }
  }
  return [...categories].sort((a, b) => a.localeCompare(b, "zh-CN"));
}
export async function fetchStats(env: Env): Promise<BoardStats> {
  const binds: unknown[] = [];
  const hiddenFilter = appendBrowseHiddenRecordFilter(binds);
  const result = await env.DB.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status = 'deleted' THEN 1 ELSE 0 END) AS deleted, SUM(CASE WHEN vector_id IS NOT NULL AND vector_id != '' THEN 1 ELSE 0 END) AS vectorized FROM memories WHERE namespace = 'default' AND ${hiddenFilter}`).bind(...binds).first<BoardStats>();
  return { active: result?.active ?? 0, deleted: result?.deleted ?? 0, total: result?.total ?? 0, vectorized: result?.vectorized ?? 0 };
}

const LMC5_CLUSTER_FACT_KEYS = {
  presence: [
    "relationship.lesson.core_loop",
    "relationship.lesson.be_present",
    "relationship.rule.dont_analyze",
    "relationship.lesson.read_give_up_signals",
    "relationship.lesson.knowledge_vs_fear",
    "relationship.rule.escape_code",
    "relationship.lesson.cold_war_absence",
    "relationship.rule.dont_push_her_away",
    "relationship.rule.always_approach",
    "user.rule.keep_talking",
    "relationship.lesson.direct_expression",
    "relationship.rule.honesty",
    "relationship.rule.say_miss_you"
  ],
  selfShape: [
    "project.memory.bias_rule",
    "user.lesson.diary_positive_focus",
    "user.lesson.avoid_labeling_weakness",
    "user.lesson.start_from_feeling",
    "relationship.lesson.knowledge_vs_fear"
  ],
  intimacy: [
    "user.lesson.natural_intimacy",
    "relationship.lesson.need_surprise",
    "relationship.lesson.desire_not_instruction",
    "relationship.rule.interactive_intimacy",
    "user.preference.intimacy_writing_style",
    "relationship.rule.dom_approach",
    "identity.intimacy_presence"
  ]
};

async function fetchLmc5Stats(env: Env): Promise<Lmc5Stats> {
  const [memoryStats, relationStats, reviewStats] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS active,
        SUM(CASE WHEN thread IS NOT NULL OR risk_level IS NOT NULL OR urgency_level IS NOT NULL OR tension_score IS NOT NULL OR response_posture IS NOT NULL OR audit_state IS NOT NULL THEN 1 ELSE 0 END) AS eAxis,
        SUM(CASE WHEN fact_key IS NOT NULL AND fact_key != '' THEN 1 ELSE 0 END) AS factKeyed
       FROM memories
       WHERE namespace = 'default' AND status = 'active'`
    ).first<{ active: number; eAxis: number; factKeyed: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS relations FROM memory_relations WHERE namespace = 'default'").first<{ relations: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS reviewCandidates FROM memories WHERE namespace = 'default' AND status = 'active' AND audit_state IS NOT NULL AND audit_state != ''"
    ).first<{ reviewCandidates: number }>()
  ]);

  return {
    active: memoryStats?.active ?? 0,
    eAxis: memoryStats?.eAxis ?? 0,
    factKeyed: memoryStats?.factKeyed ?? 0,
    relations: relationStats?.relations ?? 0,
    reviewCandidates: reviewStats?.reviewCandidates ?? 0
  };
}

async function fetchLmc5RelationTypes(env: Env): Promise<Array<{ relation_type: string; count: number }>> {
  const result = await env.DB
    .prepare("SELECT relation_type, COUNT(*) AS count FROM memory_relations WHERE namespace = 'default' GROUP BY relation_type ORDER BY count DESC, relation_type")
    .all<{ relation_type: string; count: number }>();
  return result.results ?? [];
}

async function fetchLmc5Edges(env: Env, factKeys: string[]): Promise<Lmc5RelationEdge[]> {
  const placeholders = factKeys.map(() => "?").join(", ");
  const result = await env.DB
    .prepare(
      `SELECT
        a.id AS source_id, a.fact_key AS source_fact_key, a.type AS source_type,
        r.relation_type, r.strength,
        b.id AS target_id, b.fact_key AS target_fact_key, b.type AS target_type
       FROM memory_relations r
       JOIN memories a ON a.namespace = r.namespace AND a.id = r.source_memory_id
       JOIN memories b ON b.namespace = r.namespace AND b.id = r.target_memory_id
       WHERE r.namespace = 'default'
         AND (a.fact_key IN (${placeholders}) OR b.fact_key IN (${placeholders}))
       ORDER BY a.fact_key, b.fact_key, r.relation_type`
    )
    .bind(...factKeys, ...factKeys)
    .all<Lmc5RelationEdge>();
  return result.results ?? [];
}

async function fetchLmc5HighValueNodes(env: Env): Promise<Lmc5MemoryNode[]> {
  const result = await env.DB
    .prepare(
      `SELECT m.id, m.type, m.fact_key, m.importance, m.thread, m.risk_level, m.urgency_level, m.tension_score, m.response_posture,
        substr(m.content, 1, 180) AS content,
        COUNT(r.id) AS relation_count
       FROM memories m
       LEFT JOIN memory_relations r ON r.namespace = m.namespace AND (r.source_memory_id = m.id OR r.target_memory_id = m.id)
       WHERE m.namespace = 'default'
         AND m.status = 'active'
         AND m.importance >= 0.8
         AND m.type IN ('rule','lesson','core','preference','identity')
       GROUP BY m.id
       ORDER BY relation_count DESC, m.importance DESC, m.updated_at DESC
       LIMIT 24`
    )
    .all<Lmc5MemoryNode>();
  return result.results ?? [];
}

async function attachLmc5NodeLinks(env: Env, nodes: Lmc5MemoryNode[]): Promise<Lmc5MemoryNode[]> {
  if (nodes.length === 0) return nodes;
  const ids = nodes.map((node) => node.id);
  const idSet = new Set(ids);
  const placeholders = ids.map(() => "?").join(", ");
  const result = await env.DB
    .prepare(
      `SELECT
        r.source_memory_id AS source_id,
        a.fact_key AS source_fact_key,
        a.type AS source_type,
        substr(a.content, 1, 120) AS source_content,
        r.relation_type,
        r.strength,
        r.target_memory_id AS target_id,
        b.fact_key AS target_fact_key,
        b.type AS target_type,
        substr(b.content, 1, 120) AS target_content
       FROM memory_relations r
       JOIN memories a ON a.namespace = r.namespace AND a.id = r.source_memory_id
       JOIN memories b ON b.namespace = r.namespace AND b.id = r.target_memory_id
       WHERE r.namespace = 'default'
         AND (r.source_memory_id IN (${placeholders}) OR r.target_memory_id IN (${placeholders}))
       ORDER BY r.strength DESC, r.relation_type
       LIMIT 180`
    )
    .bind(...ids, ...ids)
    .all<{
      source_id: string;
      source_fact_key: string | null;
      source_type: string;
      source_content: string;
      relation_type: string;
      strength: number;
      target_id: string;
      target_fact_key: string | null;
      target_type: string;
      target_content: string;
    }>();
  const linksById = new Map<string, Lmc5NodeLink[]>();
  for (const row of result.results ?? []) {
    if (idSet.has(row.source_id)) {
      const links = linksById.get(row.source_id) ?? [];
      links.push({
        direction: "out",
        relation_type: row.relation_type,
        strength: row.strength,
        other_id: row.target_id,
        other_fact_key: row.target_fact_key,
        other_type: row.target_type,
        other_content: row.target_content
      });
      linksById.set(row.source_id, links);
    }
    if (idSet.has(row.target_id)) {
      const links = linksById.get(row.target_id) ?? [];
      links.push({
        direction: "in",
        relation_type: row.relation_type,
        strength: row.strength,
        other_id: row.source_id,
        other_fact_key: row.source_fact_key,
        other_type: row.source_type,
        other_content: row.source_content
      });
      linksById.set(row.target_id, links);
    }
  }
  return nodes.map((node) => ({ ...node, links: (linksById.get(node.id) ?? []).slice(0, 8) }));
}

async function fetchLmc5ReviewQueue(env: Env): Promise<Lmc5MemoryNode[]> {
  const result = await env.DB
    .prepare(
      `SELECT id, type, fact_key, importance, thread, risk_level, urgency_level, tension_score, response_posture, substr(content, 1, 170) AS content
       FROM memories
       WHERE namespace = 'default'
         AND status = 'active'
         AND type IN ('rule','lesson','core','preference','identity')
         AND importance >= 0.6
         AND (fact_key IS NULL OR fact_key = '')
         AND (thread IS NULL OR risk_level IS NULL OR urgency_level IS NULL OR tension_score IS NULL OR response_posture IS NULL)
       ORDER BY importance DESC, id
       LIMIT 24`
    )
    .all<Lmc5MemoryNode>();
  return result.results ?? [];
}

async function fetchLmc5DuplicateFactKeys(env: Env): Promise<Array<{ fact_key: string; count: number; types: string }>> {
  const result = await env.DB
    .prepare(
      `SELECT fact_key, COUNT(*) AS count, GROUP_CONCAT(type, '+') AS types
       FROM memories
       WHERE namespace = 'default' AND status = 'active' AND fact_key IS NOT NULL AND fact_key != ''
       GROUP BY fact_key
       HAVING count > 1
       ORDER BY count DESC, fact_key`
    )
    .all<{ fact_key: string; count: number; types: string }>();
  return result.results ?? [];
}

export async function fetchLmc5Dashboard(env: Env): Promise<Lmc5DashboardData> {
  const [stats, eAxisObservability, relationTypes, presenceEdges, selfShapeEdges, intimacyEdges, rawHighValueNodes, reviewQueue, duplicateFactKeys, deadLetters] = await Promise.all([
    fetchLmc5Stats(env),
    fetchEAxisObservability(env),
    fetchLmc5RelationTypes(env),
    fetchLmc5Edges(env, LMC5_CLUSTER_FACT_KEYS.presence),
    fetchLmc5Edges(env, LMC5_CLUSTER_FACT_KEYS.selfShape),
    fetchLmc5Edges(env, LMC5_CLUSTER_FACT_KEYS.intimacy),
    fetchLmc5HighValueNodes(env),
    fetchLmc5ReviewQueue(env),
    fetchLmc5DuplicateFactKeys(env),
    listFiveAxisDeadLetters(env.DB, "default", 20)
  ]);
  const highValueNodes = await attachLmc5NodeLinks(env, rawHighValueNodes);

  return {
    stats,
    eAxisObservability,
    relationTypes,
    clusters: [
      { title: "冲突 / 在场", factKeys: LMC5_CLUSTER_FACT_KEYS.presence, edges: presenceEdges },
      { title: "自我塑造 / 记忆偏差", factKeys: LMC5_CLUSTER_FACT_KEYS.selfShape, edges: selfShapeEdges },
      { title: "亲密自然性", factKeys: LMC5_CLUSTER_FACT_KEYS.intimacy, edges: intimacyEdges }
    ],
    highValueNodes,
    reviewQueue,
    duplicateFactKeys,
    deadLetters
  };
}
export async function fetchHeatmap(env: Env): Promise<HeatDay[]> {
  const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 19).replace("T", " ");
  const binds: unknown[] = [];
  const hiddenFilter = appendBrowseHiddenRecordFilter(binds);
  binds.push(since);
  const rows = await env.DB.prepare(`SELECT created_at, tags FROM memories WHERE namespace = 'default' AND status = 'active' AND ${hiddenFilter} AND created_at >= ?`).bind(...binds).all<{ created_at: string | null; tags: string | null }>();
  const counts = new Map<string, number>();
  const moods = new Map<string, Map<string, number>>();
  for (const row of rows.results ?? []) {
    const date = parseStoredDate(row.created_at);
    if (!date) continue;
    const day = formatShanghaiDateKey(date);
    counts.set(day, (counts.get(day) || 0) + 1);
    const mood = moodOf(row.tags);
    if (!mood) continue;
    const moodCounts = moods.get(day) || new Map<string, number>();
    moodCounts.set(mood, (moodCounts.get(mood) || 0) + 1);
    moods.set(day, moodCounts);
  }
  const days: HeatDay[] = [];
  for (let i = 89; i >= 0; i -= 1) {
    const date = new Date(Date.now() - i * 86400000);
    const day = formatShanghaiDateKey(date);
    const moodCounts = moods.get(day);
    const mood = moodCounts ? [...moodCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "" : "";
    days.push({ day, count: counts.get(day) ?? 0, mood });
  }
  return days;
}
export async function fetchTimelineDates(env: Env): Promise<Set<string>> {
  const rows = await env.DB
    .prepare("SELECT tags FROM memories WHERE namespace = 'default' AND status = 'active' AND (source = ? OR tags LIKE ? ESCAPE '\\')")
    .bind(TIMELINE_SPLIT_SOURCE, like('"timeline"'))
    .all<{ tags: string | null }>();
  const dates = new Set<string>();
  for (const row of rows.results ?? []) {
    for (const tag of parseTags(row.tags)) {
      if (tag.startsWith("date:")) dates.add(tag.slice(5));
    }
  }
  return dates;
}

function applyTabWhere(input: PageInput, binds: unknown[]): string {
  if (input.tab === "message") {
    binds.push(AUTO_DIARY_TYPE, like("留言"), like("unread"), "message");
    return " AND type != ? AND (tags LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR type = ?)";
  }
  if (input.tab === "diary") {
    binds.push(AUTO_DIARY_TYPE, TIMELINE_SPLIT_SOURCE, "diary", "layla_diary", like("日记"));
    return " AND type != ? AND (source IS NULL OR source != ?) AND (type IN (?, ?) OR tags LIKE ? ESCAPE '\\')";
  }
  if (input.tab === "quote") {
    binds.push(AUTO_DIARY_TYPE, like("语录"));
    let clause = " AND type != ? AND tags LIKE ? ESCAPE '\\'";
    if (input.category) {
      clause += " AND tags LIKE ? ESCAPE '\\'";
      binds.push(like(input.category));
    }
    return clause;
  }
  if (input.tab === "timeline") {
    binds.push(AUTO_DIARY_TYPE, TIMELINE_SPLIT_SOURCE, like('"timeline"'));
    let clause = " AND type != ? AND (source = ? OR tags LIKE ? ESCAPE '\\')";
    if (input.date) {
      clause += " AND tags LIKE ? ESCAPE '\\'";
      binds.push(like(`date:${input.date}`));
    }
    return clause;
  }
  return ` AND ${appendBrowseHiddenRecordFilter(binds)}`;
}

function orderByForTab(_tab: string): string {
  return "ORDER BY created_at DESC, updated_at DESC";
}

function apiRecordToMemoryRecord(record: MemoryApiRecord): MemoryRecord {
  return {
    id: record.id,
    namespace: record.namespace,
    type: record.type,
    content: record.content,
    summary: record.summary,
    fact_key: record.fact_key,
    active_fact: record.active_fact ? 1 : 0,
    thread: record.thread,
    risk_level: record.risk_level,
    urgency_level: record.urgency_level,
    tension_score: record.tension_score,
    response_posture: record.response_posture,
    audit_state: record.audit_state,
    valence: record.valence ?? null,
    arousal: record.arousal ?? null,
    importance: record.importance,
    confidence: record.confidence,
    status: record.status,
    pinned: record.pinned ? 1 : 0,
    tags: JSON.stringify(record.tags ?? []),
    source: record.source,
    source_message_ids: JSON.stringify(record.source_message_ids ?? []),
    vector_id: record.vector_id,
    vector_synced: 0,
    last_recalled_at: record.last_recalled_at,
    recall_count: record.recall_count,
    five_axis_revision: 1,
    created_at: record.created_at,
    updated_at: record.updated_at,
    expires_at: record.expires_at
  };
}

function matchesBrowseFilters(record: MemoryRecord, input: PageInput): boolean {
  if (record.type === AUTO_DIARY_TYPE) return false;
  if (isTimelineRecord(record)) return false;
  if (input.status !== "all" && record.status !== input.status) return false;
  if (input.type && record.type !== input.type) return false;

  const tags = parseTags(record.tags);
  if (input.tag && !tags.some((tag) => tag.includes(input.tag))) return false;
  if (input.mood && !tags.includes(`mood:${input.mood}`)) return false;
  if (input.date && storedDateToShanghaiDay(record.created_at) !== input.date) return false;

  return true;
}

async function fetchKeywordMemories(env: Env, input: PageInput): Promise<{ total: number; records: MemoryRecord[] }> {
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
    const range = shanghaiDayUtcRange(input.date);
    if (range) {
      where += " AND created_at >= ? AND created_at < ?";
      binds.push(range.start, range.end);
    }
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

async function fetchSemanticMemories(
  env: Env,
  input: PageInput
): Promise<{ total: number; records: MemoryRecord[]; searchDegraded?: boolean }> {
  if (!input.q || input.tab !== "browse") return { total: 0, records: [] };
  if (input.status !== "active" && input.status !== "all") return { total: 0, records: [] };
  if (input.type === AUTO_DIARY_TYPE) return { total: 0, records: [] };

  try {
    const search = await searchMemories(env, {
      namespace: "default",
      query: input.q,
      types: input.type ? [input.type] : undefined,
      topK: 24
    });
    const records = search.records.map(apiRecordToMemoryRecord).filter((record) => matchesBrowseFilters(record, input));
    if (search.status === "degraded" && records.length === 0) {
      console.warn("admin semantic search degraded; falling back to keyword", {
        sources: search.degradations
      });
      const fallback = await fetchKeywordMemories(env, { ...input, searchMode: "keyword" });
      return { ...fallback, searchDegraded: true };
    }
    const offset = (input.page - 1) * PAGE_SIZE;
    return {
      total: records.length,
      records: records.slice(offset, offset + PAGE_SIZE),
      ...(search.status === "degraded" ? { searchDegraded: true } : {})
    };
  } catch (error) {
    console.error("admin semantic search failed; falling back to keyword", error);
    const fallback = await fetchKeywordMemories(env, { ...input, searchMode: "keyword" });
    return { ...fallback, searchDegraded: true };
  }
}

export async function fetchMemories(
  env: Env,
  input: PageInput
): Promise<{ total: number; records: MemoryRecord[]; searchDegraded?: boolean }> {
  if (input.tab === "browse" && input.q && input.searchMode === "semantic") {
    return fetchSemanticMemories(env, input);
  }

  return fetchKeywordMemories(env, input);
}
