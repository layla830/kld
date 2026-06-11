-- Track whether a memory's embedding is present and current in Vectorize.
-- 0 = needs (re)embedding; retention resyncs these in batches.
ALTER TABLE memories ADD COLUMN vector_synced INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_memories_vector_synced
ON memories(namespace, status, vector_synced);
