CREATE TABLE IF NOT EXISTS memory_five_axis_runs (
  namespace TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  memory_revision INTEGER NOT NULL,
  axis TEXT NOT NULL CHECK (axis IN ('X', 'Y', 'Z', 'E', 'M')),
  status TEXT NOT NULL CHECK (status IN ('running', 'applied', 'pending_review', 'skipped', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  last_error TEXT,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, memory_id, memory_revision, axis)
);

CREATE INDEX IF NOT EXISTS idx_memory_five_axis_runs_status
ON memory_five_axis_runs(namespace, status, updated_at);
