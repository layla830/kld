import { listUnprocessedChunkMessages } from "../db/messages";
import type { Env, MemoryRecord, QueueMessage } from "../types";
import { handleQueueMessage } from "./consumer";
import { dateFromDiary } from "../memory/diarySplit";
import { loadChunkingConfig, loadFiveAxisConfig, loadMemoryConfig, systemClock } from "../config/runtime";
import { listDueFiveAxisOutbox, markFiveAxisOutboxQueued } from "../db/memoryFiveAxisOutbox";

function allowQueueFallback(env: Env): boolean {
  return loadChunkingConfig(env).queueFallbackEnabled;
}

/**
 * Send a queue message. Uses real Cloudflare Queue when MEMORY_QUEUE binding
 * is available. Direct handling is only allowed by explicit local/dev opt-in.
 */
async function sendQueueMessage(env: Env, message: QueueMessage): Promise<boolean> {
  if (env.MEMORY_QUEUE) {
    await env.MEMORY_QUEUE.send(message);
    return true;
  }

  if (allowQueueFallback(env)) {
    await handleQueueMessage(message, env);
    return true;
  }

  console.warn("MEMORY_QUEUE binding missing; skipped background queue message", {
    type: message.type,
    namespace: message.namespace
  });
  return false;
}

function chunkThreshold(env: Env): number {
  return loadChunkingConfig(env).minMessages;
}

function chunkWindowLimit(env: Env, threshold: number): number {
  return Math.max(threshold, loadChunkingConfig(env).maxMessages);
}

function keyPart(value: string | number | undefined): string {
  return encodeURIComponent(String(value ?? ""));
}

function memoryMaintenanceKey(input: {
  namespace: string;
  conversationId: string;
  fromMessageId: string;
  toMessageId: string;
}): string {
  return [
    "memory_maintenance",
    input.namespace,
    input.conversationId,
    input.fromMessageId,
    input.toMessageId
  ].map(keyPart).join(":");
}

function conversationChunkKey(input: {
  namespace: string;
  conversationId: string;
  source: string;
  firstMessageId: string;
  lastMessageId: string;
  count: number;
}): string {
  return [
    "conversation_chunk",
    input.namespace,
    input.conversationId,
    input.source,
    input.firstMessageId,
    input.lastMessageId,
    input.count
  ].map(keyPart).join(":");
}

function retentionKey(input: { namespace: string; day: string }): string {
  return ["retention", input.namespace, input.day].map(keyPart).join(":");
}

export async function enqueueMemoryMaintenanceIfNeeded(
  env: Env,
  input: {
    namespace: string;
    conversationId: string;
    fromMessageId?: string;
    toMessageId: string;
    source: string;
  }
): Promise<void> {
  const config = loadMemoryConfig(env);
  if (!config.autoMemoryEnabled || config.mode === "none") return;
  if (!input.fromMessageId) return;

  const message: QueueMessage = {
    type: "memory_maintenance",
    namespace: input.namespace,
    conversationId: input.conversationId,
    fromMessageId: input.fromMessageId,
    toMessageId: input.toMessageId,
    source: input.source,
    idempotencyKey: memoryMaintenanceKey({
      namespace: input.namespace,
      conversationId: input.conversationId,
      fromMessageId: input.fromMessageId,
      toMessageId: input.toMessageId
    })
  };

  await sendQueueMessage(env, message);
  await enqueueConversationChunkingIfNeeded(env, {
    namespace: input.namespace,
    conversationId: input.conversationId,
    source: input.source
  });
}

export async function enqueueConversationChunkingIfNeeded(
  env: Env,
  input: {
    namespace: string;
    conversationId: string;
    source: string;
    force?: boolean;
  }
): Promise<void> {
  const config = loadMemoryConfig(env);
  if (!config.autoMemoryEnabled || config.mode === "none") return;

  const threshold = chunkThreshold(env);
  const candidates = await listUnprocessedChunkMessages(env.DB, {
    namespace: input.namespace,
    conversationId: input.conversationId,
    limit: chunkWindowLimit(env, threshold)
  });
  const unprocessedCount = candidates.length;
  if (unprocessedCount < threshold && !input.force) return;
  if (unprocessedCount <= 0) return;

  const firstMessage = candidates[0];
  const lastMessage = candidates[candidates.length - 1];

  await sendQueueMessage(env, {
    type: "conversation_chunk",
    namespace: input.namespace,
    conversationId: input.conversationId,
    source: input.source,
    maxMessages: Math.max(unprocessedCount, threshold),
    idempotencyKey: conversationChunkKey({
      namespace: input.namespace,
      conversationId: input.conversationId,
      source: input.source,
      firstMessageId: firstMessage.id,
      lastMessageId: lastMessage.id,
      count: unprocessedCount
    })
  });
}

export async function enqueueRetentionIfNeeded(
  env: Env,
  namespace: string
): Promise<void> {
  const day = systemClock.today("UTC");
  const message: QueueMessage = {
    type: "retention",
    namespace,
    idempotencyKey: retentionKey({ namespace, day })
  };

  await sendQueueMessage(env, message);
}

export async function enqueueMemoryVectorSync(env: Env, memories: MemoryRecord[]): Promise<void> {
  const unique = [...new Map(memories.map((memory) => [memory.id, memory])).values()];
  const byNamespace = new Map<string, MemoryRecord[]>();
  for (const memory of unique) byNamespace.set(memory.namespace, [...(byNamespace.get(memory.namespace) ?? []), memory]);
  for (const [namespace, records] of byNamespace) {
    for (let offset = 0; offset < records.length; offset += 3) {
      const batch = records.slice(offset, offset + 3);
      const signature = batch.map((memory) => `${memory.id}:${memory.updated_at}:${memory.status}`).join("|");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signature));
      const hash = [...new Uint8Array(digest)].slice(0, 8).map((byte) => byte.toString(16).padStart(2, "0")).join("");
      await sendQueueMessage(env, {
        type: "memory_vector_sync",
        namespace,
        memoryIds: batch.map((memory) => memory.id),
        jobId: `vector:${hash}`
      });
    }
  }
}

function isSplittableDiary(memory: MemoryRecord): boolean {
  return memory.status === "active" && ["diary", "layla_diary"].includes(memory.type);
}

export async function enqueueDiarySplitIfNeeded(env: Env, memory: MemoryRecord): Promise<boolean> {
  if (!isSplittableDiary(memory)) return false;
  await sendQueueMessage(env, {
    type: "diary_split",
    namespace: memory.namespace,
    diaryId: memory.id,
    jobId: `diary-split:${memory.id}`
  });
  return true;
}

export async function enqueueMissedDiarySplits(env: Env, namespace: string, limit = 2): Promise<number> {
  const boundedLimit = Math.min(Math.max(limit, 1), 3);
  const rows = await env.DB.prepare(
    `SELECT m.* FROM memories m
     WHERE m.namespace = ? AND m.status = 'active' AND m.type IN ('diary','layla_diary')
       AND m.created_at <= ?
       AND NOT EXISTS (
         SELECT 1 FROM memory_events e
         WHERE e.namespace = m.namespace AND e.memory_id = m.id AND e.event_type = 'diary_split_v2_complete'
       )
       AND NOT EXISTS (
         SELECT 1 FROM memories split
         WHERE split.namespace = m.namespace AND split.status IN ('active','review') AND split.source = 'timeline_split'
           AND EXISTS (SELECT 1 FROM json_each(split.tags) WHERE value = 'origin:' || m.id)
       )
       AND NOT EXISTS (SELECT 1 FROM json_each(m.tags) WHERE value = 'has_timeline_split')
     ORDER BY m.created_at ASC LIMIT 25`
  ).bind(namespace, new Date(systemClock.nowMs() - 5 * 60_000).toISOString()).all<MemoryRecord>();
  const eligible = (rows.results ?? []).filter((memory) => dateFromDiary(memory)).slice(0, boundedLimit);
  for (const memory of eligible) await enqueueDiarySplitIfNeeded(env, memory);
  return eligible.length;
}

export async function enqueuePendingFiveAxisProjections(env: Env, limit = 5): Promise<number> {
  if (!loadFiveAxisConfig(env).enabled) return 0;
  const due = await listDueFiveAxisOutbox(env.DB, limit);
  let queued = 0;
  for (const item of due) {
    const memoryRevision = item.memory_revision ?? 1;
    const message: QueueMessage = {
      type: "memory_five_axis_projection",
      namespace: item.namespace,
      memoryId: item.memory_id,
      memoryUpdatedAt: item.memory_updated_at,
      memoryRevision,
      outboxId: item.id,
      idempotencyKey: `five-axis:${item.id}:r${memoryRevision}`
    };
    if (!(await sendQueueMessage(env, message))) continue;
    await markFiveAxisOutboxQueued(env.DB, item.id);
    queued += 1;
  }
  return queued;
}
