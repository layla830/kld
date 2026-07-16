CREATE TABLE IF NOT EXISTS memory_candidate_axis_runs (
  namespace TEXT NOT NULL,
  candidate_external_key TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  memory_revision INTEGER NOT NULL,
  axis TEXT NOT NULL CHECK (axis IN ('X', 'Y', 'Z', 'E', 'M')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (namespace, candidate_external_key, memory_id, memory_revision, axis),
  FOREIGN KEY (namespace, candidate_external_key)
    REFERENCES memory_candidates(namespace, external_key) ON DELETE CASCADE,
  FOREIGN KEY (namespace, memory_id, memory_revision, axis)
    REFERENCES memory_five_axis_runs(namespace, memory_id, memory_revision, axis) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_candidate_axis_runs_run
ON memory_candidate_axis_runs(namespace, memory_id, memory_revision, axis);

CREATE INDEX IF NOT EXISTS idx_memory_candidate_axis_runs_candidate
ON memory_candidate_axis_runs(namespace, candidate_external_key);

-- Existing pending-review runs predate explicit candidate linkage. Recover the
-- narrowest stable ownership key available for each axis so old rows do not
-- remain permanent audit orphans after this migration.
INSERT OR IGNORE INTO memory_candidate_axis_runs (
  namespace, candidate_external_key, memory_id, memory_revision, axis, created_at
)
SELECT
  candidate.namespace, candidate.external_key,
  run.memory_id, run.memory_revision, run.axis, candidate.created_at
FROM memory_candidates AS candidate
JOIN memory_five_axis_runs AS run
  ON run.namespace = candidate.namespace
 AND run.status = 'pending_review'
LEFT JOIN memories AS memory
  ON memory.namespace = run.namespace
 AND memory.id = run.memory_id
WHERE
  (run.axis = 'X' AND candidate.action = 'timeline_date'
    AND run.memory_id = candidate.target_id)
  OR
  (run.axis = 'E' AND candidate.action = 'update'
    AND run.memory_id = candidate.target_id
    AND json_extract(candidate.payload_json, '$._kind') = 'coordinate_backfill')
  OR
  (run.axis = 'Y' AND candidate.action = 'y_relation_review'
    AND json_extract(candidate.payload_json, '$.projection_key')
        = 'five-axis:' || run.memory_id || ':r' || run.memory_revision)
  OR
  (run.axis = 'Z' AND candidate.action = 'z_supersede'
    AND memory.fact_key = json_extract(candidate.payload_json, '$.fact_key'))
  OR
  (run.axis = 'M' AND (
    (candidate.action = 'm_archive' AND run.memory_id = candidate.target_id)
    OR
    (candidate.action = 'm_relation_cleanup'
      AND run.memory_id IN (
        json_extract(candidate.payload_json, '$.before.source_memory_id'),
        json_extract(candidate.payload_json, '$.before.target_memory_id')
      ))
  ));

UPDATE memory_five_axis_runs AS runs
SET status = CASE
      WHEN EXISTS (
        SELECT 1
        FROM memory_candidate_axis_runs AS links
        JOIN memory_candidates AS candidates
          ON candidates.namespace = links.namespace
         AND candidates.external_key = links.candidate_external_key
        WHERE links.namespace = runs.namespace
          AND links.memory_id = runs.memory_id
          AND links.memory_revision = runs.memory_revision
          AND links.axis = runs.axis
          AND candidates.status IN ('pending', 'needs_subject_review', 'deferred_relation')
      ) THEN 'pending_review'
      WHEN EXISTS (
        SELECT 1
        FROM memory_candidate_axis_runs AS links
        JOIN memory_candidates AS candidates
          ON candidates.namespace = links.namespace
         AND candidates.external_key = links.candidate_external_key
        WHERE links.namespace = runs.namespace
          AND links.memory_id = runs.memory_id
          AND links.memory_revision = runs.memory_revision
          AND links.axis = runs.axis
          AND candidates.status = 'approved'
      ) THEN 'applied'
      ELSE 'skipped'
    END,
    claim_token = NULL,
    lease_expires_at = NULL,
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE runs.status = 'pending_review'
  AND EXISTS (
    SELECT 1
    FROM memory_candidate_axis_runs AS links
    WHERE links.namespace = runs.namespace
      AND links.memory_id = runs.memory_id
      AND links.memory_revision = runs.memory_revision
      AND links.axis = runs.axis
  );
