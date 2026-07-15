DELETE FROM memory_relations
WHERE relation_type = 'temporal_sequence'
  AND EXISTS (
    SELECT 1
    FROM memories AS source
    JOIN memories AS target
      ON target.namespace = source.namespace
     AND target.thread = source.thread
     AND target.fact_key = source.fact_key
    WHERE source.namespace = memory_relations.namespace
      AND source.id = memory_relations.source_memory_id
      AND target.id = memory_relations.target_memory_id
      AND source.status = 'active' AND target.status = 'active'
      AND source.thread IS NOT NULL AND source.fact_key IS NOT NULL
      AND (
        SELECT COUNT(*)
        FROM json_each(CASE WHEN json_valid(source.tags) THEN source.tags ELSE '[]' END)
        WHERE value GLOB 'date:20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      ) = 1
      AND (
        SELECT COUNT(*)
        FROM json_each(CASE WHEN json_valid(target.tags) THEN target.tags ELSE '[]' END)
        WHERE value GLOB 'date:20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      ) = 1
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
