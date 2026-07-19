import {
  normalizeFactKey,
  normalizeArousal,
  normalizeResponsePosture,
  normalizeRiskLevel,
  normalizeTensionScore,
  normalizeThread,
  normalizeUrgencyLevel,
  normalizeValence
} from "../coordinates";
import type { ExtractedMemory } from "../extract";
import type {
  DailyDigestResult,
  DigestMemoryDelete,
  DigestMemoryUpdate,
  DigestRelationHint,
  ImportantExcerpt
} from "./schema";

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function clampScore(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : fallback;
}

export function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}

export function hasRepeatedMessageSupport(sourceMessageIds: string[]): boolean {
  return new Set(sourceMessageIds).size >= 2;
}

export function normalizeExtractedMemory(value: unknown): ExtractedMemory | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const content = readString(raw.content);
  if (!content) return null;

  return {
    type: readString(raw.type) || "note",
    content,
    importance: clampScore(raw.importance, 0.7),
    confidence: clampScore(raw.confidence, 0.82),
    tags: readStringArray(raw.tags),
    source_message_ids: readStringArray(raw.source_message_ids),
    fact_key: normalizeFactKey(raw.fact_key),
    thread: normalizeThread(raw.thread),
    risk_level: normalizeRiskLevel(raw.risk_level),
    urgency_level: normalizeUrgencyLevel(raw.urgency_level),
    tension_score: normalizeTensionScore(raw.tension_score),
    response_posture: normalizeResponsePosture(raw.response_posture),
    valence: normalizeValence(raw.valence),
    arousal: normalizeArousal(raw.arousal)
  };
}

export function normalizeDigestResult(value: unknown): DailyDigestResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;

  const sections = Array.isArray(raw.sections)
    ? raw.sections.flatMap((item): Array<{ heading?: string; content?: string }> => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        const heading = readString(record.heading) ?? undefined;
        const content = readString(record.content) ?? undefined;
        return heading || content ? [{ heading, content }] : [];
      })
    : undefined;

  const important_excerpts = Array.isArray(raw.important_excerpts)
    ? raw.important_excerpts.flatMap((item): ImportantExcerpt[] => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        const quote = readString(record.quote);
        if (!quote) return [];
        const sourceMessageIds = readStringArray(record.source_message_ids);
        if (!hasRepeatedMessageSupport(sourceMessageIds)) return [];
        return [
          {
            quote,
            reason: readString(record.reason) ?? undefined,
            tags: readStringArray(record.tags),
            source_message_ids: sourceMessageIds
          }
        ];
      })
    : undefined;

  const memories_to_update = Array.isArray(raw.memories_to_update)
    ? raw.memories_to_update.flatMap((item): DigestMemoryUpdate[] => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        const targetId = readString(record.target_id);
        if (!targetId) return [];
        return [
          {
            target_id: targetId,
            content: readString(record.content) ?? undefined,
            type: readString(record.type) ?? undefined,
            importance: typeof record.importance === "number" ? clampScore(record.importance, 0.7) : undefined,
            confidence: typeof record.confidence === "number" ? clampScore(record.confidence, 0.82) : undefined,
            tags: Array.isArray(record.tags) ? readStringArray(record.tags) : undefined,
            fact_key: record.fact_key === undefined ? undefined : normalizeFactKey(record.fact_key),
            thread: record.thread === undefined ? undefined : normalizeThread(record.thread),
            risk_level: record.risk_level === undefined ? undefined : normalizeRiskLevel(record.risk_level),
            urgency_level: record.urgency_level === undefined ? undefined : normalizeUrgencyLevel(record.urgency_level),
            tension_score: record.tension_score === undefined ? undefined : normalizeTensionScore(record.tension_score),
            response_posture:
              record.response_posture === undefined ? undefined : normalizeResponsePosture(record.response_posture),
            valence: record.valence === undefined ? undefined : normalizeValence(record.valence),
            arousal: record.arousal === undefined ? undefined : normalizeArousal(record.arousal)
          }
        ];
      })
    : undefined;

  const memories_to_delete = Array.isArray(raw.memories_to_delete)
    ? raw.memories_to_delete.flatMap((item): DigestMemoryDelete[] => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        const targetId = readString(record.target_id);
        return targetId ? [{ target_id: targetId, reason: readString(record.reason) ?? undefined }] : [];
      })
    : undefined;

  const relation_hints = Array.isArray(raw.relation_hints)
    ? raw.relation_hints.flatMap((item): DigestRelationHint[] => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        const sourceId = readString(record.source_id);
        const targetId = readString(record.target_id);
        const relationType = readString(record.relation_type);
        if (!sourceId || !targetId || !relationType) return [];
        return [
          {
            source_id: sourceId,
            target_id: targetId,
            relation_type: relationType,
            strength: typeof record.strength === "number" ? Math.min(Math.max(record.strength, 0), 1) : 0.6,
            reason: readString(record.reason) ?? undefined
          }
        ];
      })
    : undefined;

  return {
    date: readString(raw.date) ?? undefined,
    title: readString(raw.title) ?? undefined,
    summary: readString(raw.summary) ?? undefined,
    sections,
    important_excerpts,
    memories_to_add: Array.isArray(raw.memories_to_add)
      ? raw.memories_to_add.flatMap((item): ExtractedMemory[] => {
          const memory = normalizeExtractedMemory(item);
          return memory && hasRepeatedMessageSupport(memory.source_message_ids) ? [memory] : [];
        })
      : undefined,
    memories_to_update,
    memories_to_delete,
    relation_hints
  };
}
