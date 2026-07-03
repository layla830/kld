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

CREATE INDEX IF NOT EXISTS idx_memory_candidates_review
ON memory_candidates(namespace, status, dream_date, created_at);
