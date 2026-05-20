ALTER TABLE messages ADD COLUMN chunk_processed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_chunking
  ON messages (namespace, conversation_id, chunk_processed_at, created_at);
