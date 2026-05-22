import type { MessageRecord } from "../db/messages";

export type ChunkSummary = {
  summary: string;
  keywords: string[];
  emotion: string;
};

export type ConversationChunk = {
  messages: MessageRecord[];
  periodKey: string;
  periodLabel: string;
};
