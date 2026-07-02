-- Three-state vector sync status for Dream/nightly maintenance.
-- Existing memories: active+vector_synced=1 -> 'synced'; active+0 -> 'pending'; non-active -> 'deleted'.
-- The legacy vector_synced INTEGER column is kept for backward compatibility;
-- new code reads/writes vector_sync_status. Legacy code can keep using vector_synced.
ALTER TABLE memories ADD COLUMN vector_sync_status TEXT;

UPDATE memories
SET vector_sync_status = CASE
  WHEN status = 'active' AND vector_synced = 1 THEN 'synced'
  WHEN status = 'active' THEN 'pending'
  ELSE 'deleted'
END
WHERE vector_sync_status IS NULL;

-- Backfill not-null via a generated default for any future NULL writes is not
-- supported cleanly on D1, so enforce at app layer. Index for patrol queries.
CREATE INDEX IF NOT EXISTS idx_memories_vector_sync_status
ON memories(namespace, status, vector_sync_status);
