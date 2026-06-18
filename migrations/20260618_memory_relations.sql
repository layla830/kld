CREATE TABLE IF NOT EXISTS memory_relations (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT 'default',
  source_memory_id TEXT NOT NULL,
  target_memory_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  strength REAL NOT NULL DEFAULT 1,
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(namespace, source_memory_id, target_memory_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_memory_relations_namespace_source
ON memory_relations(namespace, source_memory_id);

CREATE INDEX IF NOT EXISTS idx_memory_relations_namespace_target
ON memory_relations(namespace, target_memory_id);

CREATE INDEX IF NOT EXISTS idx_memory_relations_namespace_type
ON memory_relations(namespace, relation_type);
