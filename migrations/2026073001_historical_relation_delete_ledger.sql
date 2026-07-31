ALTER TABLE historical_relation_manifests
ADD COLUMN deleted_relation_count INTEGER NOT NULL DEFAULT 0
CHECK (deleted_relation_count >= 0);

ALTER TABLE historical_relation_manifests
ADD COLUMN delete_batches_completed INTEGER NOT NULL DEFAULT 0
CHECK (delete_batches_completed >= 0);

ALTER TABLE historical_relation_manifests
ADD COLUMN deleted_at TEXT;

ALTER TABLE historical_relation_manifests
ADD COLUMN rolled_back_at TEXT;

CREATE TABLE IF NOT EXISTS historical_relation_deletions (
  manifest_id TEXT NOT NULL,
  relation_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  batch_ordinal INTEGER NOT NULL CHECK (batch_ordinal >= 1),
  deleted_at TEXT NOT NULL,
  restored_at TEXT,
  PRIMARY KEY(manifest_id, relation_id),
  FOREIGN KEY(manifest_id, relation_id)
    REFERENCES historical_relation_snapshots(manifest_id, relation_id)
);

CREATE INDEX IF NOT EXISTS idx_historical_relation_deletions_batch
ON historical_relation_deletions(manifest_id, batch_ordinal, relation_id);

CREATE TRIGGER IF NOT EXISTS trg_historical_relation_deletions_no_delete
BEFORE DELETE ON historical_relation_deletions
BEGIN
  SELECT RAISE(ABORT, 'historical_relation_deletion_delete_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_historical_relation_deletions_immutable
BEFORE UPDATE ON historical_relation_deletions
WHEN OLD.manifest_id IS NOT NEW.manifest_id
  OR OLD.relation_id IS NOT NEW.relation_id
  OR OLD.batch_id IS NOT NEW.batch_id
  OR OLD.batch_ordinal IS NOT NEW.batch_ordinal
  OR OLD.deleted_at IS NOT NEW.deleted_at
  OR (
    OLD.restored_at IS NOT NULL
    AND OLD.restored_at IS NOT NEW.restored_at
  )
BEGIN
  SELECT RAISE(ABORT, 'historical_relation_deletion_identity_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_historical_relation_manifest_delete_progress
BEFORE UPDATE OF
  deleted_relation_count,
  delete_batches_completed
ON historical_relation_manifests
WHEN NEW.deleted_relation_count < OLD.deleted_relation_count
  OR NEW.deleted_relation_count > NEW.expected_relation_count
  OR NEW.delete_batches_completed < OLD.delete_batches_completed
  OR NEW.deleted_relation_count != (
    SELECT COUNT(*)
    FROM historical_relation_deletions AS deletion
    WHERE deletion.manifest_id = NEW.manifest_id
  )
  OR NEW.delete_batches_completed != (
    SELECT COUNT(DISTINCT deletion.batch_id)
    FROM historical_relation_deletions AS deletion
    WHERE deletion.manifest_id = NEW.manifest_id
  )
BEGIN
  SELECT RAISE(ABORT, 'historical_relation_manifest_delete_progress_invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_historical_relation_manifest_delete_audit
BEFORE UPDATE OF status, deleted_at, rolled_back_at
ON historical_relation_manifests
WHEN (
    NEW.status = 'deleted'
    AND (
      NEW.deleted_relation_count != NEW.expected_relation_count
      OR NEW.deleted_at IS NULL
    )
  )
  OR (
    NEW.status = 'rolled_back'
    AND (
      NEW.deleted_relation_count != NEW.expected_relation_count
      OR NEW.deleted_at IS NULL
      OR NEW.rolled_back_at IS NULL
    )
  )
  OR (
    OLD.deleted_at IS NOT NULL
    AND OLD.deleted_at IS NOT NEW.deleted_at
  )
  OR (
    OLD.rolled_back_at IS NOT NULL
    AND OLD.rolled_back_at IS NOT NEW.rolled_back_at
  )
BEGIN
  SELECT RAISE(ABORT, 'historical_relation_manifest_delete_audit_invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_historical_relation_manifest_status_forward_only
BEFORE UPDATE OF status ON historical_relation_manifests
WHEN NOT (
  (OLD.status = 'staging'
    AND NEW.status IN ('staging', 'verified', 'invalidated'))
  OR (OLD.status = 'verified'
    AND NEW.status IN ('verified', 'delete_in_progress', 'invalidated'))
  OR (OLD.status = 'delete_in_progress'
    AND NEW.status IN ('delete_in_progress', 'deleted', 'rolled_back'))
  OR (OLD.status = 'deleted'
    AND NEW.status IN ('deleted', 'rolled_back'))
  OR (OLD.status = 'rolled_back' AND NEW.status = 'rolled_back')
  OR (OLD.status = 'invalidated' AND NEW.status = 'invalidated')
)
BEGIN
  SELECT RAISE(ABORT, 'historical_relation_manifest_status_regression');
END;
