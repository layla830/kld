ALTER TABLE memory_candidates ADD COLUMN result_memory_id TEXT;

CREATE INDEX IF NOT EXISTS idx_memory_candidates_result
ON memory_candidates(namespace, result_memory_id);

UPDATE memory_candidates
SET status = 'deferred_relation', updated_at = datetime('now')
WHERE action = 'relation' AND status IN ('pending', 'needs_subject_review');
