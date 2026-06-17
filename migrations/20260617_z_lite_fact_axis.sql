ALTER TABLE memories ADD COLUMN fact_key TEXT;
ALTER TABLE memories ADD COLUMN active_fact INTEGER NOT NULL DEFAULT 1;

UPDATE memories
SET active_fact = CASE
  WHEN status = 'active' THEN 1
  ELSE 0
END;

CREATE INDEX IF NOT EXISTS idx_memories_namespace_fact_key
ON memories(namespace, fact_key);

CREATE INDEX IF NOT EXISTS idx_memories_namespace_active_fact
ON memories(namespace, active_fact);
