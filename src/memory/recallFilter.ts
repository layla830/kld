import type { Env, MemoryApiRecord, MemoryRecord } from "../types";
import { toMemoryApiRecord } from "./search";
import { BROAD_TIME_QUERY_RE } from "./recallIntent";
import { dateNeedles, likeNeedle, matchesAnyNeedle, supportNeedles, topicNeedles } from "./recallNeedles";

const BROAD_EVENT_QUESTION_RE = /说了什么|聊了什么|在聊什么|弄什么|做什么|干什么|怎么样|发生了什么|发生什么|怎么聊/;

function isTimeSummaryCandidate(memory: MemoryApiRecord): boolean {
  const meta = `${memory.type} ${memory.tags.join(" ")} ${memory.source || ""}`;
  return /auto_diary|timeline|quote|diary|summary|日记|总结|conversation_message|date:\d{4}-\d{2}-\d{2}/i.test(meta);
}

function isTimelineDay(memory: MemoryApiRecord): boolean {
  return /timeline_day|day_summary/i.test(`${memory.type} ${memory.tags.join(" ")}`);
}

function mergeUniqueMemories(primary: MemoryApiRecord[], secondary: MemoryApiRecord[]): MemoryApiRecord[] {
  const seen = new Set<string>();
  const merged: MemoryApiRecord[] = [];
  for (const memory of [...primary, ...secondary]) {
    if (seen.has(memory.id)) continue;
    seen.add(memory.id);
    merged.push(memory);
  }
  return merged;
}

function hasMatchingTimelineDay(memories: MemoryApiRecord[], needles: string[]): boolean {
  return memories.some((memory) => isTimelineDay(memory) && matchesAnyNeedle(memory, needles));
}

async function fetchDatedTimelineCandidates(
  env: Env,
  input: { namespace: string; needles: string[]; limit: number }
): Promise<MemoryApiRecord[]> {
  const needles = input.needles.slice(0, 8);
  if (needles.length === 0) return [];

  const clauses: string[] = [];
  const binds: unknown[] = [input.namespace];
  for (const needle of needles) {
    clauses.push("content LIKE ? ESCAPE '\\'", "summary LIKE ? ESCAPE '\\'", "tags LIKE ? ESCAPE '\\'", "created_at LIKE ? ESCAPE '\\'", "updated_at LIKE ? ESCAPE '\\'");
    const like = likeNeedle(needle);
    binds.push(like, like, like, like, like);
  }
  binds.push(input.limit);

  const result = await env.DB.prepare(
    `SELECT * FROM memories
     WHERE namespace = ?
       AND status = 'active'
       AND type NOT IN ('diary', 'layla_diary', 'auto_diary')
       AND (type = 'timeline_day' OR tags LIKE '%day_summary%' OR tags LIKE '%timeline%')
       AND (${clauses.join(" OR ")})
     ORDER BY importance DESC, updated_at DESC
     LIMIT ?`
  ).bind(...binds).all<MemoryRecord>();

  return (result.results ?? [])
    .map((record) => toMemoryApiRecord(record, 1))
    .filter((memory) => isTimeSummaryCandidate(memory) && matchesAnyNeedle(memory, needles));
}

export async function addDatedTimelineCandidates(
  env: Env,
  input: { namespace: string; rawQuery: string; memories: MemoryApiRecord[]; topK: number }
): Promise<MemoryApiRecord[]> {
  const needles = dateNeedles(input.rawQuery);
  if (needles.length === 0 || hasMatchingTimelineDay(input.memories, needles)) return input.memories;

  const dated = await fetchDatedTimelineCandidates(env, {
    namespace: input.namespace,
    needles,
    limit: Math.max(input.topK * 4, 12)
  });
  return dated.length > 0 ? mergeUniqueMemories(dated, input.memories) : input.memories;
}

export function filterUnsupportedRecallMemories(memories: MemoryApiRecord[], searchQuery: string, rawQuery: string): MemoryApiRecord[] {
  const dateTerms = dateNeedles(rawQuery);
  if (dateTerms.length > 0) {
    const dated = memories.filter((memory) => matchesAnyNeedle(memory, dateTerms));
    if (dated.length === 0) return [];
    if (BROAD_TIME_QUERY_RE.test(rawQuery) || BROAD_EVENT_QUESTION_RE.test(rawQuery)) {
      return dated.filter(isTimeSummaryCandidate);
    }

    const topicTerms = topicNeedles(`${rawQuery} ${searchQuery}`);
    const datedWithTopic = dated.filter((memory) => matchesAnyNeedle(memory, topicTerms));
    return datedWithTopic.length > 0 ? datedWithTopic : dated;
  }

  if (BROAD_TIME_QUERY_RE.test(rawQuery)) return memories.filter(isTimeSummaryCandidate);

  const needles = supportNeedles(rawQuery, searchQuery);
  if (needles.length === 0) return memories;

  const supported = memories.filter((memory) => matchesAnyNeedle(memory, needles));
  return supported.length > 0 ? supported : memories;
}
