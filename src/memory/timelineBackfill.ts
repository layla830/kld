import type { Env, MemoryRecord } from "../types";
import { upsertMemoryCandidate } from "../db/memoryCandidates";

export interface TimelineDateProposal {
  id: string;
  thread: string | null;
  fact_key: string | null;
  date: string;
  before_tags: string[];
  tags: string[];
}

export interface TimelineEdgeProposal {
  source_id: string;
  target_id: string;
  thread: string;
  source_date: string;
  target_date: string;
}

function parseTags(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function validDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function extractExplicitDates(text: string): string[] {
  const dates = new Set<string>();
  for (const match of text.matchAll(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) {
    const date = validDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (date) dates.add(date);
  }
  for (const match of text.matchAll(/(20\d{2})年(\d{1,2})月(\d{1,2})日/g)) {
    const date = validDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (date) dates.add(date);
  }
  return [...dates].sort();
}

export async function runTimelineBackfill(env: Env, namespace: string): Promise<{
  scanned: number;
  dated: number;
  ambiguous: number;
  proposals: TimelineDateProposal[];
  edges: TimelineEdgeProposal[];
}> {
  const rows = await env.DB.prepare(
    `SELECT * FROM memories
     WHERE namespace = ? AND status = 'active'
       AND type != 'dream_review'
       AND (tags IS NULL OR tags NOT LIKE '%"date:%')
     ORDER BY updated_at DESC
     LIMIT 100`
  ).bind(namespace).all<MemoryRecord>();

  const proposals: TimelineDateProposal[] = [];
  let ambiguous = 0;
  for (const memory of rows.results ?? []) {
    const dates = extractExplicitDates(memory.content);
    if (dates.length > 1) {
      ambiguous += 1;
      continue;
    }
    if (dates.length !== 1) continue;
    const beforeTags = parseTags(memory.tags);
    proposals.push({
      id: memory.id,
      thread: memory.thread,
      fact_key: memory.fact_key,
      date: dates[0],
      before_tags: beforeTags,
      tags: [...new Set([...beforeTags, `date:${dates[0]}`, "timeline"])]
    });
  }

  const byFact = new Map<string, TimelineDateProposal[]>();
  for (const proposal of proposals) {
    if (!proposal.thread || !proposal.fact_key) continue;
    const key = `${proposal.thread}\u0000${proposal.fact_key}`;
    const list = byFact.get(key) ?? [];
    list.push(proposal);
    byFact.set(key, list);
  }

  const edges: TimelineEdgeProposal[] = [];
  for (const list of byFact.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    for (let index = 1; index < list.length; index += 1) {
      const previous = list[index - 1];
      const current = list[index];
      if (previous.date === current.date) continue;
      edges.push({
        source_id: previous.id,
        target_id: current.id,
        thread: current.thread!,
        source_date: previous.date,
        target_date: current.date
      });
    }
  }

  return { scanned: (rows.results ?? []).length, dated: proposals.length, ambiguous, proposals, edges };
}

export async function queueTimelineBackfill(env: Env, namespace: string): Promise<{
  scanned: number;
  dated: number;
  ambiguous: number;
  queued: number;
}> {
  const result = await runTimelineBackfill(env, namespace);
  const dreamDate = new Date().toISOString().slice(0, 10);
  for (const proposal of result.proposals) {
    await upsertMemoryCandidate(env.DB, namespace, {
      externalKey: `timeline-date:${proposal.id}:${proposal.date}`,
      dreamDate,
      action: "timeline_date",
      subject: "memory_timeline",
      targetId: proposal.id,
      payload: {
        _kind: "timeline_date",
        date: proposal.date,
        thread: proposal.thread,
        fact_key: proposal.fact_key,
        before_tags: proposal.before_tags,
        tags: proposal.tags
      },
      sourceChunkIds: [],
      sourceChunks: [],
      status: "pending"
    });
  }
  return { scanned: result.scanned, dated: result.dated, ambiguous: result.ambiguous, queued: result.proposals.length };
}
