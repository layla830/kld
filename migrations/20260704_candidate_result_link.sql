-- This migration sorts before 20260704_memory_candidates.sql. Production had
-- the table already because the migrations were deployed incrementally, but a
-- fresh database applies files lexically and otherwise fails on the ALTER.
-- Keep the historical filename (Wrangler records it) and make it bootstrap-safe.
CREATE TABLE IF NOT EXISTS memory_candidates (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT 'default',
  external_key TEXT NOT NULL,
  dream_date TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT,
  target_id TEXT,
  payload_json TEXT NOT NULL,
  source_chunk_ids_json TEXT NOT NULL DEFAULT '[]',
  source_chunks_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  validation_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(namespace, external_key)
);

ALTER TABLE memory_candidates ADD COLUMN result_memory_id TEXT;

CREATE INDEX IF NOT EXISTS idx_memory_candidates_result
ON memory_candidates(namespace, result_memory_id);

UPDATE memory_candidates
SET status = 'deferred_relation', updated_at = datetime('now')
WHERE action = 'relation' AND status IN ('pending', 'needs_subject_review');
