import type { MessageRecord } from "../types";

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
