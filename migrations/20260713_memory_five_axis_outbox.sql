CREATE TABLE IF NOT EXISTS memory_five_axis_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  memory_updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(namespace, memory_id, memory_updated_at)
);

CREATE INDEX IF NOT EXISTS idx_memory_five_axis_outbox_due
ON memory_five_axis_outbox(status, queued_at, updated_at);

CREATE TRIGGER IF NOT EXISTS trg_memories_five_axis_after_insert
AFTER INSERT ON memories
WHEN NEW.status = 'active'
  AND NEW.type NOT IN ('diary', 'layla_diary', 'auto_diary', 'dream_review')
BEGIN
  INSERT OR IGNORE INTO memory_five_axis_outbox (
    namespace, memory_id, memory_updated_at, status, attempts,
    created_at, updated_at
  ) VALUES (
    NEW.namespace, NEW.id, NEW.updated_at, 'pending', 0,
    NEW.created_at, NEW.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_memories_five_axis_after_material_update
AFTER UPDATE OF content, type, fact_key, status ON memories
WHEN NEW.status = 'active'
  AND NEW.type NOT IN ('diary', 'layla_diary', 'auto_diary', 'dream_review')
  AND (
    OLD.content IS NOT NEW.content
    OR OLD.type IS NOT NEW.type
    OR OLD.fact_key IS NOT NEW.fact_key
    OR OLD.status IS NOT NEW.status
  )
BEGIN
  INSERT OR IGNORE INTO memory_five_axis_outbox (
    namespace, memory_id, memory_updated_at, status, attempts,
    created_at, updated_at
  ) VALUES (
    NEW.namespace, NEW.id, NEW.updated_at, 'pending', 0,
    NEW.updated_at, NEW.updated_at
  );
END;
