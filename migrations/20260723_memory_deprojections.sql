CREATE TABLE IF NOT EXISTS memory_deprojections (
  operation_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN (
    'memory_api',
    'admin_board',
    'dream_review',
    'dream_candidate',
    'z_review',
    'm_review',
    'retention',
    'system'
  )),
  reason TEXT NOT NULL,
  candidate_id TEXT,
  intent_fingerprint TEXT NOT NULL CHECK (length(intent_fingerprint) = 64),
  transition TEXT NOT NULL CHECK (transition = 'eligible_to_ineligible'),
  previous_status TEXT NOT NULL,
  next_status TEXT NOT NULL,
  previous_type TEXT NOT NULL,
  next_type TEXT NOT NULL,
  previous_active_fact INTEGER NOT NULL,
  next_active_fact INTEGER NOT NULL,
  previous_revision INTEGER NOT NULL,
  current_revision INTEGER NOT NULL,
  relation_snapshot_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(relation_snapshot_json)),
  timeline_snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(timeline_snapshot_json)),
  outbox_snapshot_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(outbox_snapshot_json)),
  axis_run_snapshot_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(axis_run_snapshot_json)),
  reconciled_run_snapshot_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reconciled_run_snapshot_json)),
  candidate_snapshot_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidate_snapshot_json)),
  removed_relations INTEGER NOT NULL DEFAULT 0,
  removed_timeline_memberships INTEGER NOT NULL DEFAULT 0,
  invalidated_candidates INTEGER NOT NULL DEFAULT 0,
  terminalized_outboxes INTEGER NOT NULL DEFAULT 0,
  terminalized_axis_runs INTEGER NOT NULL DEFAULT 0,
  reconciled_axis_runs INTEGER NOT NULL DEFAULT 0,
  vector_sync_required INTEGER NOT NULL DEFAULT 1 CHECK (vector_sync_required IN (0, 1)),
  invariants_verified INTEGER NOT NULL DEFAULT 0 CHECK (invariants_verified IN (0, 1)),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(namespace, memory_id, previous_revision),
  CHECK (current_revision = previous_revision + 1),
  CHECK (completed_at IS NULL OR invariants_verified = 1)
);

CREATE INDEX IF NOT EXISTS idx_memory_deprojections_memory
ON memory_deprojections(namespace, memory_id, current_revision);

-- The lifecycle service creates an incomplete operation row before mutating the
-- memory and owns the revision increment itself. Preserve the existing trigger
-- behavior for legacy callers, but suppress it while that guarded operation is
-- in flight so one eligibility transition advances the revision exactly once.
DROP TRIGGER IF EXISTS trg_memories_five_axis_after_insert;
DROP TRIGGER IF EXISTS trg_memories_five_axis_after_material_update;

CREATE TRIGGER trg_memories_five_axis_after_insert
AFTER INSERT ON memories
WHEN NEW.status = 'active'
  AND NEW.active_fact != 0
  AND LOWER(TRIM(NEW.type)) NOT IN ('diary', 'layla_diary', 'auto_diary', 'dream_review')
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
AFTER UPDATE OF content, type, fact_key, active_fact, thread, tags, status ON memories
WHEN NOT EXISTS (
    SELECT 1
    FROM memory_deprojections AS operation
    WHERE operation.namespace = NEW.namespace
      AND operation.memory_id = NEW.id
      AND operation.previous_revision = OLD.five_axis_revision
      AND operation.completed_at IS NULL
  )
  AND (
    (
      OLD.status = 'active'
      AND OLD.active_fact != 0
      AND LOWER(TRIM(OLD.type)) NOT IN ('diary', 'layla_diary', 'auto_diary', 'dream_review')
    )
    OR (
      NEW.status = 'active'
      AND NEW.active_fact != 0
      AND LOWER(TRIM(NEW.type)) NOT IN ('diary', 'layla_diary', 'auto_diary', 'dream_review')
    )
  )
  AND (
    OLD.content IS NOT NEW.content
    OR OLD.type IS NOT NEW.type
    OR OLD.fact_key IS NOT NEW.fact_key
    OR OLD.active_fact IS NOT NEW.active_fact
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
