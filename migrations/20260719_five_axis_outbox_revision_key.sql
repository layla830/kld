DROP TRIGGER IF EXISTS trg_memories_five_axis_after_insert;
DROP TRIGGER IF EXISTS trg_memories_five_axis_after_material_update;

CREATE TABLE memory_five_axis_outbox_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  memory_updated_at TEXT NOT NULL,
  memory_revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(namespace, memory_id, memory_revision)
);

-- Rows created before memory_revision existed were all backfilled to revision 1.
-- Keep the newest representative of those legacy duplicates while changing the
-- durable idempotency key from a wall-clock timestamp to the memory revision.
INSERT INTO memory_five_axis_outbox_next (
  id, namespace, memory_id, memory_updated_at, memory_revision,
  status, attempts, queued_at, completed_at, last_error, result_json,
  created_at, updated_at
)
SELECT
  outbox.id, outbox.namespace, outbox.memory_id, outbox.memory_updated_at,
  outbox.memory_revision, outbox.status, outbox.attempts, outbox.queued_at,
  outbox.completed_at, outbox.last_error, outbox.result_json,
  outbox.created_at, outbox.updated_at
FROM memory_five_axis_outbox AS outbox
WHERE NOT EXISTS (
  SELECT 1
  FROM memory_five_axis_outbox AS newer
  WHERE newer.namespace = outbox.namespace
    AND newer.memory_id = outbox.memory_id
    AND newer.memory_revision = outbox.memory_revision
    AND newer.id > outbox.id
);

DROP TABLE memory_five_axis_outbox;
ALTER TABLE memory_five_axis_outbox_next RENAME TO memory_five_axis_outbox;

CREATE INDEX idx_memory_five_axis_outbox_due
ON memory_five_axis_outbox(status, queued_at, updated_at);

CREATE TRIGGER trg_memories_five_axis_after_insert
AFTER INSERT ON memories
WHEN NEW.status = 'active'
  AND NEW.type NOT IN ('diary', 'layla_diary', 'auto_diary', 'dream_review')
BEGIN
  INSERT OR IGNORE INTO memory_five_axis_outbox (
    namespace, memory_id, memory_updated_at, memory_revision, status, attempts,
    created_at, updated_at
  ) VALUES (
    NEW.namespace, NEW.id, NEW.updated_at, NEW.five_axis_revision, 'pending', 0,
    NEW.created_at, NEW.updated_at
  );
END;

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
