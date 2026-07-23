CREATE TABLE IF NOT EXISTS memory_candidate_dependencies (
  namespace TEXT NOT NULL,
  candidate_external_key TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('source', 'target', 'axis_run')),
  PRIMARY KEY (namespace, candidate_external_key, memory_id, role),
  FOREIGN KEY (namespace, candidate_external_key)
    REFERENCES memory_candidates(namespace, external_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_candidate_dependencies_memory
ON memory_candidate_dependencies(namespace, memory_id, candidate_external_key);

CREATE INDEX IF NOT EXISTS idx_memory_candidate_dependencies_candidate
ON memory_candidate_dependencies(namespace, candidate_external_key);

-- Direct targets are dependencies for every candidate action.
INSERT OR IGNORE INTO memory_candidate_dependencies (
  namespace, candidate_external_key, memory_id, role
)
SELECT namespace, external_key, target_id, 'target'
FROM memory_candidates
WHERE target_id IS NOT NULL AND target_id <> '';

-- Historical Y/M candidates predate normalized endpoint dependencies. Payload
-- parsing is intentionally confined to this one-time migration.
INSERT OR IGNORE INTO memory_candidate_dependencies (
  namespace, candidate_external_key, memory_id, role
)
SELECT
  namespace,
  external_key,
  json_extract(payload_json, '$.source_id'),
  'source'
FROM memory_candidates
WHERE action = 'y_relation_review'
  AND json_valid(payload_json)
  AND json_extract(payload_json, '$.source_id') IS NOT NULL
  AND json_extract(payload_json, '$.source_id') <> '';

INSERT OR IGNORE INTO memory_candidate_dependencies (
  namespace, candidate_external_key, memory_id, role
)
SELECT
  namespace,
  external_key,
  json_extract(payload_json, '$.target_id'),
  'target'
FROM memory_candidates
WHERE action = 'y_relation_review'
  AND json_valid(payload_json)
  AND json_extract(payload_json, '$.target_id') IS NOT NULL
  AND json_extract(payload_json, '$.target_id') <> '';

INSERT OR IGNORE INTO memory_candidate_dependencies (
  namespace, candidate_external_key, memory_id, role
)
SELECT
  namespace,
  external_key,
  json_extract(payload_json, '$.before.source_memory_id'),
  'source'
FROM memory_candidates
WHERE action = 'm_relation_cleanup'
  AND json_valid(payload_json)
  AND json_extract(payload_json, '$.before.source_memory_id') IS NOT NULL
  AND json_extract(payload_json, '$.before.source_memory_id') <> '';

INSERT OR IGNORE INTO memory_candidate_dependencies (
  namespace, candidate_external_key, memory_id, role
)
SELECT
  namespace,
  external_key,
  json_extract(payload_json, '$.before.target_memory_id'),
  'target'
FROM memory_candidates
WHERE action = 'm_relation_cleanup'
  AND json_valid(payload_json)
  AND json_extract(payload_json, '$.before.target_memory_id') IS NOT NULL
  AND json_extract(payload_json, '$.before.target_memory_id') <> '';

INSERT OR IGNORE INTO memory_candidate_dependencies (
  namespace, candidate_external_key, memory_id, role
)
SELECT namespace, candidate_external_key, memory_id, 'axis_run'
FROM memory_candidate_axis_runs;
