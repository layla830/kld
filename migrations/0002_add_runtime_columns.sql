-- This migration name exists in some checkouts but its intended columns are
-- owned by later/older concrete migrations:
-- - 0002_v4_assembler_cache.sql adds usage_logs cache metadata columns.
-- - 20260520_auto_conversation_chunks.sql adds messages.chunk_processed_at.
--
-- Keep this file as a no-op so databases that have not recorded it can mark it
-- applied without attempting duplicate ALTER TABLE statements.
SELECT 1;
