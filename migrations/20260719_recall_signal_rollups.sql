CREATE TABLE IF NOT EXISTS memory_recall_daily (
  namespace TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  recall_day TEXT NOT NULL,
  source TEXT NOT NULL,
  recall_count INTEGER NOT NULL DEFAULT 0 CHECK (recall_count >= 0),
  first_recalled_at TEXT NOT NULL,
  last_recalled_at TEXT NOT NULL,
  PRIMARY KEY (namespace, memory_id, recall_day, source)
);

CREATE INDEX IF NOT EXISTS idx_memory_recall_daily_window
ON memory_recall_daily(namespace, recall_day, memory_id);

CREATE TABLE IF NOT EXISTS memory_recall_receipts (
  namespace TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  source TEXT NOT NULL,
  recall_day TEXT NOT NULL,
  recalled_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (namespace, operation_id, memory_id, source)
);

CREATE INDEX IF NOT EXISTS idx_memory_recall_receipts_expiry
ON memory_recall_receipts(created_at);

CREATE TABLE IF NOT EXISTS memory_metabolism_signal_state (
  namespace TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  policy_key TEXT NOT NULL,
  band TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  first_observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, memory_id, policy_key)
);

CREATE INDEX IF NOT EXISTS idx_memory_metabolism_signal_band
ON memory_metabolism_signal_state(namespace, policy_key, band, updated_at);

CREATE TRIGGER IF NOT EXISTS trg_memory_recall_receipt_after_insert
AFTER INSERT ON memory_recall_receipts
BEGIN
  UPDATE memories
  SET recall_count = recall_count + 1,
      last_recalled_at = CASE
        WHEN last_recalled_at IS NULL OR last_recalled_at < NEW.recalled_at
          THEN NEW.recalled_at
        ELSE last_recalled_at
      END
  WHERE namespace = NEW.namespace AND id = NEW.memory_id;

  INSERT INTO memory_recall_daily (
    namespace, memory_id, recall_day, source, recall_count,
    first_recalled_at, last_recalled_at
  ) VALUES (
    NEW.namespace, NEW.memory_id, NEW.recall_day, NEW.source, 1,
    NEW.recalled_at, NEW.recalled_at
  )
  ON CONFLICT(namespace, memory_id, recall_day, source) DO UPDATE SET
    recall_count = memory_recall_daily.recall_count + 1,
    first_recalled_at = MIN(memory_recall_daily.first_recalled_at, excluded.first_recalled_at),
    last_recalled_at = MAX(memory_recall_daily.last_recalled_at, excluded.last_recalled_at);
END;
