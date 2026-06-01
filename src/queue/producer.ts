import { listUnprocessedChunkMessages } from "../db/messages";
import type { Env, QueueMessage } from "../types";
import { handleQueueMessage } from "./consumer";

const DEFAULT_CHUNK_THRESHOLD = 10;

function allowQueueFallback(env: Env): boolean {
  return env.ALLOW_QUEUE_FALLBACK === "true";
}

/**
 * Send a queue message. Uses real Cloudflare Queue when MEMORY_QUEUE binding
 * is available. Direct handling is only allowed by explicit local/dev opt-in.
 */
async function sendQueueMessage(env: Env, message: QueueMessage): Promise<void> {
  if (env.MEMORY_QUEUE) {
    await env.MEMORY_QUEUE.send(message);
    return;
  }

  if (allowQueueFallback(env)) {
    await handleQueueMessage(message, env);
    return;
  }

  console.warn("MEMORY_QUEUE binding missing; skipped background queue message", {
    type: message.type,
    namespace: message.namespace
  });
}

function chunkThreshold(env: Env): number {
  const value = Number(env.AUTO_CHUNK_MIN_MESSAGES || DEFAULT_CHUNK_THRESHOLD);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_CHUNK_THRESHOLD;
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
  if (env.ENABLE_AUTO_MEMORY === "false") return;
  if ((env.MEMORY_MODE || "external") === "none") return;
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
  if (env.ENABLE_AUTO_MEMORY === "false") return;
  if ((env.MEMORY_MODE || "external") === "none") return;

  const threshold = chunkThreshold(env);
  const candidates = await listUnprocessedChunkMessages(env.DB, {
    namespace: input.namespace,
    conversationId: input.conversationId,
    limit: Math.max(threshold, Number(env.AUTO_CHUNK_MAX_MESSAGES || threshold))
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
  const message: QueueMessage = {
    type: "retention",
    namespace,
  };

  await sendQueueMessage(env, message);
}
