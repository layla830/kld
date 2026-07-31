DROP TRIGGER IF EXISTS trg_historical_relation_manifest_delete_audit;

CREATE TRIGGER trg_historical_relation_manifest_delete_audit
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
      NEW.deleted_relation_count < 1
      OR NEW.rolled_back_at IS NULL
      OR EXISTS (
        SELECT 1
        FROM historical_relation_deletions AS deletion
        WHERE deletion.manifest_id = NEW.manifest_id
          AND deletion.restored_at IS NULL
      )
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
