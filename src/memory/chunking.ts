import { listUnprocessedChunkMessages, markMessagesChunkProcessed } from "../db/messages";
import type { ConversationChunkQueueMessage, Env } from "../types";
import { pruneProcessedCcConnectMessages } from "./ccConnectRetention";
import { DEFAULT_MAX_MESSAGES, MIN_CHUNK_MESSAGES, splitIntoPeriodChunks } from "./chunkPeriods";
import { persistChunkMemory } from "./chunkPersistence";
import { summarizeChunk } from "./chunkSummary";

function maxMessages(env: Env, message: ConversationChunkQueueMessage): number {
  return Math.max(Number(message.maxMessages || env.AUTO_CHUNK_MAX_MESSAGES || DEFAULT_MAX_MESSAGES), MIN_CHUNK_MESSAGES);
}

export async function runConversationChunking(
  env: Env,
  message: ConversationChunkQueueMessage
): Promise<{ conversations: number; chunks: number; messages: number }> {
  const candidates = await listUnprocessedChunkMessages(env.DB, {
    namespace: message.namespace,
    conversationId: message.conversationId,
    limit: maxMessages(env, message)
  });

  if (candidates.length < MIN_CHUNK_MESSAGES) {
    return { conversations: 0, chunks: 0, messages: 0 };
  }

  let chunkCount = 0;
  let messageCount = 0;
  const chunks = splitIntoPeriodChunks(env, candidates);

  for (const chunk of chunks) {
    if (chunk.messages.length < MIN_CHUNK_MESSAGES) continue;
    const summary = await summarizeChunk(env, chunk.messages, chunk.periodLabel);
    if (!summary) continue;

    await persistChunkMemory(env, {
      namespace: message.namespace,
      source: message.source,
      chunk,
      summary
    });
    await markMessagesChunkProcessed(env.DB, {
      namespace: message.namespace,
      ids: chunk.messages.map((item) => item.id)
    });
    chunkCount += 1;
    messageCount += chunk.messages.length;
  }

  if (chunkCount > 0 && message.source === "cc-connect") {
    await pruneProcessedCcConnectMessages(env, message.namespace);
  }

  return { conversations: chunkCount > 0 ? 1 : 0, chunks: chunkCount, messages: messageCount };
}
