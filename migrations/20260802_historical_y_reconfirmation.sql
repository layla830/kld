CREATE TABLE IF NOT EXISTS historical_relation_reconfirmation_batches (
  batch_id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  lifecycle_cohort TEXT NOT NULL DEFAULT 'eligible_unproven' CHECK (
    lifecycle_cohort = 'eligible_unproven'
  ),
  relation_ids_sha256 TEXT NOT NULL CHECK (length(relation_ids_sha256) = 64),
  relation_ids_json TEXT NOT NULL,
  relation_count INTEGER NOT NULL CHECK (relation_count BETWEEN 1 AND 10),
  created_at TEXT NOT NULL,
  UNIQUE(batch_id, manifest_id, namespace),
  FOREIGN KEY(manifest_id, namespace, lifecycle_cohort)
    REFERENCES historical_relation_manifests(
      manifest_id,
      namespace,
      lifecycle_cohort
    )
);

CREATE TABLE IF NOT EXISTS historical_relation_reconfirmation_entries (
  batch_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  relation_id TEXT NOT NULL,
  before_reason TEXT,
  proposed_relation_type TEXT NOT NULL,
  proposed_strength REAL,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('promoted', 'not_reconfirmed', 'not_applied')
  ),
  after_reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(batch_id, relation_id),
  UNIQUE(manifest_id, relation_id),
  FOREIGN KEY(batch_id, manifest_id, namespace)
    REFERENCES historical_relation_reconfirmation_batches(
      batch_id,
      manifest_id,
      namespace
    ),
  FOREIGN KEY(manifest_id, relation_id)
    REFERENCES historical_relation_snapshots(manifest_id, relation_id)
);

CREATE INDEX IF NOT EXISTS idx_historical_relation_reconfirmation_entries_manifest
ON historical_relation_reconfirmation_entries(manifest_id, outcome, relation_id);

CREATE TRIGGER IF NOT EXISTS trg_historical_relation_reconfirmation_batches_immutable
BEFORE UPDATE ON historical_relation_reconfirmation_batches
BEGIN
  SELECT RAISE(ABORT, 'historical_relation_reconfirmation_batch_update_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_historical_relation_reconfirmation_batches_no_delete
BEFORE DELETE ON historical_relation_reconfirmation_batches
BEGIN
  SELECT RAISE(ABORT, 'historical_relation_reconfirmation_batch_delete_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_historical_relation_reconfirmation_entries_immutable
BEFORE UPDATE ON historical_relation_reconfirmation_entries
BEGIN
  SELECT RAISE(ABORT, 'historical_relation_reconfirmation_entry_update_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_historical_relation_reconfirmation_entries_no_delete
BEFORE DELETE ON historical_relation_reconfirmation_entries
BEGIN
  SELECT RAISE(ABORT, 'historical_relation_reconfirmation_entry_delete_forbidden');
END;
