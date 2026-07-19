import type { ExtractedMemory } from "../extract";

export interface DigestMemoryUpdate {
  target_id: string;
  content?: string;
  type?: string;
  importance?: number;
  confidence?: number;
  tags?: string[];
  fact_key?: string | null;
  thread?: string | null;
  risk_level?: string | null;
  urgency_level?: string | null;
  tension_score?: number | null;
  response_posture?: string | null;
  valence?: number | null;
  arousal?: number | null;
}

export interface DigestMemoryDelete {
  target_id: string;
  reason?: string;
}

export interface DigestRelationHint {
  source_id: string;
  target_id: string;
  relation_type: string;
  strength?: number;
  reason?: string;
}

export interface ImportantExcerpt {
  quote: string;
  reason?: string;
  tags?: string[];
  source_message_ids?: string[];
}

export interface DailyDigestResult {
  date?: string;
  title?: string;
  summary?: string;
  sections?: Array<{ heading?: string; content?: string }>;
  important_excerpts?: ImportantExcerpt[];
  memories_to_add?: ExtractedMemory[];
  memories_to_update?: DigestMemoryUpdate[];
  memories_to_delete?: DigestMemoryDelete[];
  relation_hints?: DigestRelationHint[];
}

export interface DailyDigestStats {
  date: string;
  mode: "dream";
  dryRun: boolean;
  processedMessages: number;
  addedMemories: number;
  updatedMemories: number;
  deletedMemories: number;
  updateReviewsQueued: number;
  deleteReviewsQueued: number;
  savedExcerpts: number;
  cleanedEmptyMemories: number;
  cursorAdvanced: boolean;
  hasMore: boolean;
}

export type DailyDigestSkipReason =
  | "dream_disabled"
  | "already_done"
  | "no_messages"
  | "missing_model"
  | "model_error"
  | "model_invalid_json";

export interface DailyDigestSkipped {
  ran: false;
  mode: "dream";
  date?: string;
  reason: DailyDigestSkipReason;
  startIso?: string;
  endIso?: string;
  cursor?: string | null;
  processedMessages?: number;
  model?: string;
  status?: number;
  finishReason?: string | null;
}

export type DailyDigestRunResult = { ran: true; stats: DailyDigestStats; plan?: DailyDigestResult } | DailyDigestSkipped;

export interface DigestModelCallResult {
  digest: DailyDigestResult | null;
  reason?: Extract<DailyDigestSkipReason, "missing_model" | "model_error" | "model_invalid_json">;
  model?: string;
  status?: number;
  finishReason?: string | null;
}
