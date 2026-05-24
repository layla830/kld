import { createMemory } from "../db/memories";
import { upsertMemoryEmbedding } from "./embedding";
import type { Env, MemoryRecord } from "../types";
import type { ChunkSummary, ConversationChunk } from "./chunkTypes";

function diaryContent(periodLabel: string, summary: ChunkSummary): string {
  return `【${periodLabel}】\n${summary.summary}`;
}

function dateTagForChunk(chunk: ConversationChunk): string | null {
  const source = `${chunk.periodKey} ${chunk.periodLabel}`;
  const match = source.match(/\b\d{4}-\d{2}-\d{2}\b/);
  return match?.[0] ?? null;
}

export async function persistChunkMemory(env: Env, params: {
  namespace: string;
  source: string;
  chunk: ConversationChunk;
  summary: ChunkSummary;
}): Promise<MemoryRecord> {
  const { namespace, source, chunk, summary } = params;
  const content = diaryContent(chunk.periodLabel, summary);
  const sourceMessageIds = chunk.messages.map((message) => message.id);
  const dateTag = dateTagForChunk(chunk);
  const tags = ["auto-diary", "自动日记", dateTag, chunk.periodKey].filter((tag): tag is string => Boolean(tag));

  const memory = await createMemory(env.DB, {
    namespace,
    type: "auto_diary",
    content,
    summary: summary.summary,
    importance: 0.62,
    confidence: 0.82,
    tags,
    source,
    sourceMessageIds
  });

  try {
    await upsertMemoryEmbedding(env, memory);
  } catch (error) {
    console.error("conversation chunk vector upsert failed", error);
  }

  return memory;
}
