import { replaceTimelineSequenceRelations } from "../db/memoryRelations";
import type { MemoryRecord } from "../types";
import { nowIso } from "../utils/time";
import { isFiveAxisMemoryTypeEligible } from "./fiveAxis/eligibility";

interface TimelineGroup {
  thread: string;
  factKey: string;
}

interface TimelineMembershipRecord {
  thread: string;
  fact_key: string;
}

interface TimelineGroupResult {
  group: string;
  memories: number;
  expected: number;
  inserted: number;
}

function dateTag(tagsJson: string | null): string | null {
  try {
    const tags = JSON.parse(tagsJson || "[]") as unknown;
    if (!Array.isArray(tags)) return null;
    const dates = tags
      .filter((tag): tag is string => typeof tag === "string" && /^date:20\d{2}-\d{2}-\d{2}$/.test(tag))
      .map((tag) => tag.slice(5));
    return dates.length === 1 ? dates[0] : null;
  } catch {
    return null;
  }
}

function groupKey(group: TimelineGroup): string {
  return JSON.stringify([group.thread, group.factKey]);
}

async function rebuildTimelineGroup(
  db: D1Database,
  namespace: string,
  group: TimelineGroup
): Promise<TimelineGroupResult> {
  const rows = await db.prepare(
    `SELECT * FROM memories
     WHERE namespace = ? AND status = 'active' AND thread = ? AND fact_key = ?
       AND type NOT IN ('diary', 'layla_diary', 'auto_diary', 'dream_review')
       AND tags LIKE '%"date:%'`
  ).bind(namespace, group.thread, group.factKey).all<MemoryRecord>();
  const dated = (rows.results ?? [])
    .map((item) => ({ memory: item, date: dateTag(item.tags) }))
    .filter((item): item is { memory: MemoryRecord; date: string } => Boolean(item.date))
    .sort((a, b) => a.date.localeCompare(b.date) || a.memory.id.localeCompare(b.memory.id));

  const edges: Array<{ sourceMemoryId: string; targetMemoryId: string }> = [];
  for (let index = 1; index < dated.length; index += 1) {
    const previous = dated[index - 1];
    const current = dated[index];
    if (previous.date === current.date) continue;
    edges.push({ sourceMemoryId: previous.memory.id, targetMemoryId: current.memory.id });
  }

  const key = groupKey(group);
  const result = await replaceTimelineSequenceRelations(db, {
    namespace,
    groupKey: key,
    thread: group.thread,
    factKey: group.factKey,
    edges
  });
  return { group: key, memories: dated.length, ...result };
}

export async function rebuildTimelineSequenceForMemory(
  db: D1Database,
  memory: MemoryRecord
): Promise<{
  group: string | null;
  previousGroup: string | null;
  groupsRebuilt: TimelineGroupResult[];
  memories: number;
  expected: number;
  inserted: number;
}> {
  const previous = await db.prepare(
    `SELECT thread, fact_key FROM memory_timeline_memberships
     WHERE namespace = ? AND memory_id = ?`
  ).bind(memory.namespace, memory.id).first<TimelineMembershipRecord>();
  const previousGroup = previous ? { thread: previous.thread, factKey: previous.fact_key } : null;
  const currentGroup = memory.status === "active" && isFiveAxisMemoryTypeEligible(memory.type)
    && memory.thread && memory.fact_key && dateTag(memory.tags)
    ? { thread: memory.thread, factKey: memory.fact_key }
    : null;

  const groups = new Map<string, TimelineGroup>();
  if (previousGroup) groups.set(groupKey(previousGroup), previousGroup);
  if (currentGroup) groups.set(groupKey(currentGroup), currentGroup);
  const groupsRebuilt: TimelineGroupResult[] = [];
  for (const group of groups.values()) {
    groupsRebuilt.push(await rebuildTimelineGroup(db, memory.namespace, group));
  }

  if (currentGroup) {
    await db.prepare(
      `INSERT INTO memory_timeline_memberships
       (namespace, memory_id, thread, fact_key, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(namespace, memory_id) DO UPDATE SET
         thread = excluded.thread, fact_key = excluded.fact_key, updated_at = excluded.updated_at`
    ).bind(memory.namespace, memory.id, currentGroup.thread, currentGroup.factKey, nowIso()).run();
  } else if (previousGroup) {
    await db.prepare(
      "DELETE FROM memory_timeline_memberships WHERE namespace = ? AND memory_id = ?"
    ).bind(memory.namespace, memory.id).run();
  }

  const currentKey = currentGroup ? groupKey(currentGroup) : null;
  const currentResult = groupsRebuilt.find((result) => result.group === currentKey)
    ?? groupsRebuilt[0]
    ?? { memories: 0, expected: 0, inserted: 0 };
  return {
    group: currentKey,
    previousGroup: previousGroup ? groupKey(previousGroup) : null,
    groupsRebuilt,
    memories: currentResult.memories,
    expected: currentResult.expected,
    inserted: currentResult.inserted
  };
}
