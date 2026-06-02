ALTER TABLE messages ADD COLUMN chunk_processed_at TEXT;

ALTER TABLE usage_logs ADD COLUMN client_system_hash TEXT;
ALTER TABLE usage_logs ADD COLUMN cache_anchor_block TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_chunk_processed
ON messages(namespace, conversation_id, chunk_processed_at);
