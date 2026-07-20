-- Synthetic timeline_day rows used to be user-visible memories. The original
-- diary now owns the day anchor, so retire those rows and rebuild X from the
-- real atomic split items.

DELETE FROM memory_relations
WHERE reason LIKE 'diary_day:%' OR reason LIKE 'diary_timeline:%';

DELETE FROM memory_diary_timeline_memberships;

UPDATE memories
SET status = 'deleted',
    active_fact = 0,
    pinned = 0,
    vector_synced = 0,
    vector_sync_status = 'pending',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source = 'timeline_split'
  AND type = 'timeline_day'
  AND status IN ('active', 'review');

-- Re-project every active real split item once. This rebuilds membership rows,
-- attaches the item to its original diary, and restores adjacent diary edges.
UPDATE memories
SET five_axis_revision = five_axis_revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source = 'timeline_split'
  AND type != 'timeline_day'
  AND status = 'active';

INSERT OR IGNORE INTO memory_five_axis_outbox (
  namespace, memory_id, memory_updated_at, memory_revision, status, attempts,
  created_at, updated_at
)
SELECT
  namespace, id, updated_at, five_axis_revision, 'pending', 0,
  updated_at, updated_at
FROM memories
WHERE source = 'timeline_split'
  AND type != 'timeline_day'
  AND status = 'active';
