import { replaceTimelineSequenceRelations } from "../db/memoryRelations";
import type { MemoryRecord } from "../types";

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

export async function rebuildTimelineSequenceForMemory(
  db: D1Database,
  memory: MemoryRecord
): Promise<{ group: string | null; memories: number; expected: number; inserted: number }> {
  if (!memory.thread || !memory.fact_key) {
    return { group: null, memories: 0, expected: 0, inserted: 0 };
  }
  const rows = await db.prepare(
    `SELECT * FROM memories
     WHERE namespace = ? AND status = 'active' AND thread = ? AND fact_key = ?
       AND tags LIKE '%"date:%'`
  ).bind(memory.namespace, memory.thread, memory.fact_key).all<MemoryRecord>();
  const dated = (rows.results ?? [])
    .map((item) => ({ memory: item, date: dateTag(item.tags) }))
    .filter((item): item is { memory: MemoryRecord; date: string } => Boolean(item.date))
    .sort((a, b) => a.date.localeCompare(b.date) || a.memory.id.localeCompare(b.memory.id));

  const edges: Array<{ sourceMemoryId: string; targetMemoryId: string }> = [];
  for (let index = 1; index < dated.length; index += 1) {
    const previous = dated[index - 1];
    const current = dated[index];
    if (previous.date === current.date) continue;
    edges.push({
      sourceMemoryId: previous.memory.id,
      targetMemoryId: current.memory.id
    });
  }

  const group = JSON.stringify([memory.thread, memory.fact_key]);
  const result = await replaceTimelineSequenceRelations(db, {
    namespace: memory.namespace,
    groupKey: group,
    thread: memory.thread,
    factKey: memory.fact_key,
    edges
  });
  return { group, memories: dated.length, ...result };
}
