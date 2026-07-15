ALTER TABLE memories
ADD COLUMN five_axis_revision INTEGER NOT NULL DEFAULT 1;

ALTER TABLE memory_five_axis_outbox
ADD COLUMN memory_revision INTEGER NOT NULL DEFAULT 1;

DROP TRIGGER IF EXISTS trg_memories_five_axis_after_insert;
DROP TRIGGER IF EXISTS trg_memories_five_axis_after_material_update;

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
