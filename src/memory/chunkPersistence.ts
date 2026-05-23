import { createMemory } from "../db/memories";
import { upsertMemoryEmbedding } from "./embedding";
import type { Env, MemoryRecord } from "../types";
import type { ChunkSummary, ConversationChunk } from "./chunkTypes";
import { formatShanghaiDateTime, messageTime } from "./chunkPeriods";

function diaryContent(periodLabel: string, summary: ChunkSummary, chunk: ConversationChunk): string {
  const messages = chunk.messages;
  const start = messages[0] ? formatShanghaiDateTime(messageTime(messages[0])) : "unknown";
  const end = messages[messages.length - 1] ? formatShanghaiDateTime(messageTime(messages[messages.length - 1])) : start;
  const keywordLine = summary.keywords.length > 0 ? `\n关键词：${summary.keywords.join("、")}` : "";
  return `【${periodLabel}】\n${summary.summary}\n\n时间范围：${start} 至 ${end}（东八区）\n情感标签：${summary.emotion}${keywordLine}`;
}

export async function persistChunkMemory(env: Env, params: {
  namespace: string;
  source: string;
  chunk: ConversationChunk;
  summary: ChunkSummary;
}): Promise<MemoryRecord> {
  const { namespace, source, chunk, summary } = params;
  const content = diaryContent(chunk.periodLabel, summary, chunk);
  const sourceMessageIds = chunk.messages.map((message) => message.id);
  const tags = ["auto-diary", "自动日记", chunk.periodKey, ...summary.keywords].slice(0, 10);

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
