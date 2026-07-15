ALTER TABLE memory_five_axis_runs
ADD COLUMN claim_token TEXT;

ALTER TABLE memory_five_axis_runs
ADD COLUMN lease_expires_at TEXT;

CREATE TABLE IF NOT EXISTS memory_timeline_memberships (
  namespace TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  thread TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, memory_id)
);

INSERT INTO memory_timeline_memberships (
  namespace, memory_id, thread, fact_key, updated_at
)
SELECT
  memory.namespace, memory.id, memory.thread, memory.fact_key,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM memories AS memory
WHERE memory.status = 'active'
  AND memory.type NOT IN ('diary', 'layla_diary', 'auto_diary', 'dream_review')
  AND memory.thread IS NOT NULL
  AND memory.fact_key IS NOT NULL
  AND (
    SELECT COUNT(*)
    FROM json_each(CASE WHEN json_valid(memory.tags) THEN memory.tags ELSE '[]' END)
    WHERE value GLOB 'date:20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ) = 1
ON CONFLICT(namespace, memory_id) DO UPDATE SET
  thread = excluded.thread,
  fact_key = excluded.fact_key,
  updated_at = excluded.updated_at;

DELETE FROM memory_timeline_memberships
WHERE EXISTS (
  SELECT 1
  FROM memories AS memory
  WHERE memory.namespace = memory_timeline_memberships.namespace
    AND memory.id = memory_timeline_memberships.memory_id
    AND memory.type IN ('diary', 'layla_diary', 'auto_diary', 'dream_review')
);

DELETE FROM memory_relations
WHERE relation_type = 'temporal_sequence'
  AND reason LIKE 'timeline_approved:%'
  AND (
    EXISTS (
      SELECT 1 FROM memories AS source
      WHERE source.namespace = memory_relations.namespace
        AND source.id = memory_relations.source_memory_id
        AND source.type IN ('diary', 'layla_diary', 'auto_diary', 'dream_review')
    )
    OR EXISTS (
      SELECT 1 FROM memories AS target
      WHERE target.namespace = memory_relations.namespace
        AND target.id = memory_relations.target_memory_id
        AND target.type IN ('diary', 'layla_diary', 'auto_diary', 'dream_review')
    )
  );

WITH dated AS (
  SELECT
    memory.namespace,
    memory.id,
    memory.thread,
    memory.fact_key,
    MIN(SUBSTR(tag.value, 6)) AS event_date
  FROM memories AS memory
  JOIN json_each(CASE WHEN json_valid(memory.tags) THEN memory.tags ELSE '[]' END) AS tag
  WHERE memory.status = 'active'
    AND memory.type NOT IN ('diary', 'layla_diary', 'auto_diary', 'dream_review')
    AND memory.thread IS NOT NULL
    AND memory.fact_key IS NOT NULL
    AND tag.value GLOB 'date:20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  GROUP BY memory.namespace, memory.id, memory.thread, memory.fact_key
  HAVING COUNT(*) = 1
), sequenced AS (
  SELECT
    namespace,
    id AS target_id,
    thread,
    fact_key,
    event_date AS target_date,
    LAG(id) OVER (
      PARTITION BY namespace, thread, fact_key
      ORDER BY event_date, id
    ) AS source_id,
    LAG(event_date) OVER (
      PARTITION BY namespace, thread, fact_key
      ORDER BY event_date, id
    ) AS source_date
  FROM dated
)
INSERT OR IGNORE INTO memory_relations (
  id, namespace, source_memory_id, target_memory_id,
  relation_type, strength, reason, created_at
)
SELECT
  'rel_xtimeline_' || lower(hex(randomblob(12))),
  namespace,
  source_id,
  target_id,
  'temporal_sequence',
  1,
  'timeline_approved:' || json_array(thread, fact_key),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM sequenced
WHERE source_id IS NOT NULL AND source_date <> target_date;

DROP TRIGGER IF EXISTS trg_memories_five_axis_after_material_update;

CREATE TRIGGER trg_memories_five_axis_after_material_update
AFTER UPDATE OF content, type, fact_key, thread, tags, status ON memories
WHEN (
    NEW.status = 'active'
    OR (OLD.status = 'active' AND NEW.status <> 'active')
  )
  AND (
    OLD.type NOT IN ('diary', 'layla_diary', 'auto_diary', 'dream_review')
    OR NEW.type NOT IN ('diary', 'layla_diary', 'auto_diary', 'dream_review')
  )
  AND (
    OLD.content IS NOT NEW.content
    OR OLD.type IS NOT NEW.type
    OR OLD.fact_key IS NOT NEW.fact_key
    OR OLD.thread IS NOT NEW.thread
    OR OLD.tags IS NOT NEW.tags
    OR OLD.status IS NOT NEW.status
  )
BEGIN
  UPDATE memories
  SET five_axis_revision = OLD.five_axis_revision + 1
  WHERE namespace = NEW.namespace AND id = NEW.id;

  INSERT OR IGNORE INTO memory_five_axis_outbox (
    namespace, memory_id, memory_updated_at, memory_revision, status, attempts,
    created_at, updated_at
  ) VALUES (
    NEW.namespace, NEW.id, NEW.updated_at, OLD.five_axis_revision + 1, 'pending', 0,
    NEW.updated_at, NEW.updated_at
  );
END;
