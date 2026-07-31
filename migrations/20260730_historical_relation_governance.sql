CREATE TABLE IF NOT EXISTS historical_relation_manifests (
  manifest_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  lifecycle_cohort TEXT NOT NULL CHECK (
    lifecycle_cohort IN ('stale_endpoint', 'eligible_unproven')
  ),
  selection_predicate_version TEXT NOT NULL,
  expected_relation_count INTEGER NOT NULL CHECK (expected_relation_count >= 0),
  expected_relations_sha256 TEXT NOT NULL CHECK (
    length(expected_relations_sha256) = 64
  ),
  expected_selection_sha256 TEXT NOT NULL CHECK (
    length(expected_selection_sha256) = 64
  ),
  snapshot_relation_count INTEGER NOT NULL DEFAULT 0 CHECK (
    snapshot_relation_count >= 0
    AND snapshot_relation_count <= expected_relation_count
  ),
  status TEXT NOT NULL DEFAULT 'staging' CHECK (
    status IN (
      'staging',
      'verified',
      'delete_in_progress',
      'deleted',
      'rolled_back',
      'invalidated'
    )
  ),
  created_at TEXT NOT NULL,
  last_snapshot_at TEXT,
  verified_at TEXT,
  verified_relations_sha256 TEXT,
  verified_selection_sha256 TEXT,
  invalidated_at TEXT,
  invalidation_reason TEXT,
  UNIQUE(manifest_id, namespace, lifecycle_cohort),
  CHECK (
    status NOT IN (
      'verified',
      'delete_in_progress',
      'deleted',
      'rolled_back'
    )
    OR verified_at IS NOT NULL
  ),
  CHECK (
    status NOT IN (
      'verified',
      'delete_in_progress',
      'deleted',
      'rolled_back'
    )
    OR (
      verified_relations_sha256 = expected_relations_sha256
      AND verified_selection_sha256 = expected_selection_sha256
      AND snapshot_relation_count = expected_relation_count
    )
  ),
  CHECK (
    status != 'invalidated'
    OR (
      invalidated_at IS NOT NULL
      AND invalidation_reason IS NOT NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS historical_relation_snapshots (
  manifest_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  lifecycle_cohort TEXT NOT NULL CHECK (
    lifecycle_cohort IN ('stale_endpoint', 'eligible_unproven')
  ),
  relation_id TEXT NOT NULL,
  source_memory_id TEXT NOT NULL,
  target_memory_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  strength REAL NOT NULL,
  reason TEXT,
  relation_created_at TEXT NOT NULL,
  identity_sha256 TEXT NOT NULL CHECK (length(identity_sha256) = 64),
  selection_sha256 TEXT NOT NULL CHECK (length(selection_sha256) = 64),
  source_eligible INTEGER NOT NULL CHECK (source_eligible IN (0, 1)),
  source_status TEXT NOT NULL,
  source_active_fact INTEGER NOT NULL CHECK (source_active_fact IN (0, 1)),
  source_type TEXT NOT NULL,
  source_updated_at TEXT NOT NULL,
  source_five_axis_revision INTEGER NOT NULL CHECK (
    source_five_axis_revision >= 1
  ),
  target_eligible INTEGER NOT NULL CHECK (target_eligible IN (0, 1)),
  target_status TEXT NOT NULL,
  target_active_fact INTEGER NOT NULL CHECK (target_active_fact IN (0, 1)),
  target_type TEXT NOT NULL,
  target_updated_at TEXT NOT NULL,
  target_five_axis_revision INTEGER NOT NULL CHECK (
    target_five_axis_revision >= 1
  ),
  provenance_class TEXT NOT NULL CHECK (
    provenance_class IN (
      'deterministic_rebuildable',
      'human_reviewed',
      'builder_backed',
      'api_written',
      'legacy_backfill',
      'unproven_source'
    )
  ),
  snapshotted_at TEXT NOT NULL,
  PRIMARY KEY(manifest_id, relation_id),
  FOREIGN KEY(manifest_id, namespace, lifecycle_cohort)
    REFERENCES historical_relation_manifests(
      manifest_id,
      namespace,
      lifecycle_cohort
    )
);

CREATE INDEX IF NOT EXISTS idx_historical_relation_snapshots_relation
ON historical_relation_snapshots(namespace, relation_id, manifest_id);

CREATE INDEX IF NOT EXISTS idx_historical_relation_manifests_status
ON historical_relation_manifests(namespace, lifecycle_cohort, status, created_at);

CREATE TRIGGER IF NOT EXISTS trg_historical_relation_manifests_immutable
BEFORE UPDATE ON historical_relation_manifests
WHEN OLD.manifest_id IS NOT NEW.manifest_id
  OR OLD.namespace IS NOT NEW.namespace
  OR OLD.lifecycle_cohort IS NOT NEW.lifecycle_cohort
  OR OLD.selection_predicate_version IS NOT NEW.selection_predicate_version
  OR OLD.expected_relation_count IS NOT NEW.expected_relation_count
  OR OLD.expected_relations_sha256 IS NOT NEW.expected_relations_sha256
  OR OLD.expected_selection_sha256 IS NOT NEW.expected_selection_sha256
  OR OLD.created_at IS NOT NEW.created_at
  OR (
    OLD.verified_at IS NOT NULL
    AND (
      OLD.verified_at IS NOT NEW.verified_at
      OR OLD.verified_relations_sha256 IS NOT NEW.verified_relations_sha256
      OR OLD.verified_selection_sha256 IS NOT NEW.verified_selection_sha256
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'historical_relation_manifest_identity_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_historical_relation_manifest_count_staging_only
BEFORE UPDATE OF snapshot_relation_count ON historical_relation_manifests
WHEN OLD.status != 'staging'
  AND OLD.snapshot_relation_count IS NOT NEW.snapshot_relation_count
BEGIN
  SELECT RAISE(ABORT, 'historical_relation_manifest_count_not_staging');
END;

CREATE TRIGGER IF NOT EXISTS trg_historical_relation_manifests_no_delete
BEFORE DELETE ON historical_relation_manifests
BEGIN
  SELECT RAISE(ABORT, 'historical_relation_manifest_delete_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_historical_relation_snapshots_immutable
BEFORE UPDATE ON historical_relation_snapshots
BEGIN
  SELECT RAISE(ABORT, 'historical_relation_snapshot_update_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_historical_relation_snapshots_no_delete
BEFORE DELETE ON historical_relation_snapshots
BEGIN
  SELECT RAISE(ABORT, 'historical_relation_snapshot_delete_forbidden');
END;
