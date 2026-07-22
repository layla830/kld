import { getMemoryById, listMemories } from "../../db/memories";
import { createMemoryEvent } from "../../db/memoryEvents";
import { createSyncedMemory, deleteSyncedMemory } from "../state";
import { queueRelationReviewCandidate } from "../relationReview";
import { isMemoryDreamDeleteProtected } from "../dreamCandidatePolicy";
import type { Env, MemoryRecord, MessageRecord } from "../../types";
import { readString, truncate, uniqueStrings } from "./parser";
import type {
  DailyDigestResult,
  DigestMemoryDelete,
  DigestMemoryUpdate,
  ImportantExcerpt
} from "./schema";

export async function cleanEmptyMemories(env: Env, namespace: string, minChars: number): Promise<number> {
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

export function formatDailySummary(result: DailyDigestResult, dateLabel: string, messages: MessageRecord[]): string {
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

export async function saveDailySummaryMemory(
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

export async function saveImportantExcerpts(
  env: Env,
  input: { namespace: string; dateLabel: string; excerpts: ImportantExcerpt[]; fallbackMessageIds: string[]; limit: number }
): Promise<number> {
  let saved = 0;

  for (const excerpt of input.excerpts.slice(0, input.limit)) {
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

export async function queueMemoryMutationReviews(
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
    if (existing?.status === "active" && !isMemoryDreamDeleteProtected(existing)) deletes.push(item);
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

export async function recordDryRunPlan(
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

export async function recordDreamSnapshot(
  env: Env,
  input: { namespace: string; dateLabel: string; memoryIds: string[]; memorySnapshot: Array<{ id: string; content: string; type: string; status: string; importance: number }> }
): Promise<void> {
  await createMemoryEvent(env.DB, {
    namespace: input.namespace,
    eventType: "dream_snapshot",
    payload: {
      date: input.dateLabel,
      memory_count: input.memoryIds.length,
      snapshot: input.memorySnapshot.slice(0, 200)
    }
  });
}

export async function collectSnapshot(
  env: Env,
  namespace: string
): Promise<{ ids: string[]; snapshot: Array<{ id: string; content: string; type: string; status: string; importance: number }> }> {
  const records = await listMemories(env.DB, { namespace, status: "active", limit: 500 });
  return {
    ids: records.map((r) => r.id),
    snapshot: records.map((r) => ({ id: r.id, content: truncate(r.content, 120), type: r.type, status: r.status, importance: r.importance }))
  };
}
