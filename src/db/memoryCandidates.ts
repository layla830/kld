import { newId } from "../utils/ids";
import { nowIso } from "../utils/time";

export interface MemoryCandidateRecord {
  id: string;
  namespace: string;
  external_key: string;
  dream_date: string;
  action: string;
  subject: string | null;
  target_id: string | null;
  payload_json: string;
  source_chunk_ids_json: string;
  source_chunks_json: string;
  status: string;
  validation_error: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  target_content?: string | null;
  target_type?: string | null;
  target_status?: string | null;
}

export interface CandidateInput {
  externalKey: string;
  dreamDate: string;
  action: string;
  subject?: string | null;
  targetId?: string | null;
  payload: Record<string, unknown>;
  sourceChunkIds: number[];
  sourceChunks?: Array<Record<string, unknown>>;
  status: "pending" | "needs_subject_review";
  validationError?: string | null;
}

export async function upsertMemoryCandidate(db: D1Database, namespace: string, input: CandidateInput): Promise<void> {
  const now = nowIso();
  await db.prepare(
    `INSERT INTO memory_candidates
      (id, namespace, external_key, dream_date, action, subject, target_id, payload_json,
       source_chunk_ids_json, source_chunks_json, status, validation_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(namespace, external_key) DO UPDATE SET
       payload_json=excluded.payload_json, source_chunk_ids_json=excluded.source_chunk_ids_json,
       source_chunks_json=excluded.source_chunks_json, subject=excluded.subject,
       validation_error=excluded.validation_error, updated_at=excluded.updated_at`
  ).bind(
    newId("cand"), namespace, input.externalKey, input.dreamDate, input.action,
    input.subject ?? null, input.targetId ?? null, JSON.stringify(input.payload),
    JSON.stringify(input.sourceChunkIds), JSON.stringify(input.sourceChunks ?? []),
    input.status, input.validationError ?? null, now, now
  ).run();
}

export async function listMemoryCandidates(db: D1Database, namespace: string, limit = 100): Promise<MemoryCandidateRecord[]> {
  const result = await db.prepare(
    `SELECT c.*, m.content AS target_content, m.type AS target_type, m.status AS target_status
     FROM memory_candidates c
     LEFT JOIN memories m ON m.namespace = c.namespace AND m.id = c.target_id
     WHERE c.namespace = ? AND c.status IN ('pending','needs_subject_review')
     ORDER BY c.dream_date DESC, c.created_at DESC LIMIT ?`
  ).bind(namespace, limit).all<MemoryCandidateRecord>();
  return result.results ?? [];
}

export async function getMemoryCandidate(db: D1Database, namespace: string, id: string): Promise<MemoryCandidateRecord | null> {
  return (await db.prepare("SELECT * FROM memory_candidates WHERE namespace = ? AND id = ?")
    .bind(namespace, id).first<MemoryCandidateRecord>()) ?? null;
}

export async function resolveMemoryCandidate(db: D1Database, namespace: string, id: string, status: "approved" | "rejected"): Promise<boolean> {
  const now = nowIso();
  const result = await db.prepare(
    "UPDATE memory_candidates SET status = ?, resolved_at = ?, updated_at = ? WHERE namespace = ? AND id = ? AND status IN ('pending','needs_subject_review')"
  ).bind(status, now, now, namespace, id).run();
  return (result.meta.changes ?? 0) > 0;
}
