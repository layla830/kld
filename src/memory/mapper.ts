import type { MemoryApiRecord, MemoryRecord } from "../types";

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function toMemoryApiRecord(record: MemoryRecord, score?: number): MemoryApiRecord {
  return {
    id: record.id,
    namespace: record.namespace,
    type: record.type,
    content: record.content,
    summary: record.summary,
    fact_key: record.fact_key,
    active_fact: Boolean(record.active_fact),
    thread: record.thread ?? null,
    risk_level: record.risk_level ?? null,
    urgency_level: record.urgency_level ?? null,
    tension_score: record.tension_score ?? null,
    response_posture: record.response_posture ?? null,
    audit_state: record.audit_state ?? null,
    valence: record.valence ?? null,
    arousal: record.arousal ?? null,
    importance: record.importance,
    confidence: record.confidence,
    status: record.status,
    pinned: Boolean(record.pinned),
    tags: parseJsonArray(record.tags),
    source: record.source,
    source_message_ids: parseJsonArray(record.source_message_ids),
    vector_id: record.vector_id,
    last_recalled_at: record.last_recalled_at,
    recall_count: record.recall_count,
    created_at: record.created_at,
    updated_at: record.updated_at,
    expires_at: record.expires_at,
    ...(score === undefined ? {} : { score })
  };
}
