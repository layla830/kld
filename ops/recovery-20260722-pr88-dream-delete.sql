-- One-off, idempotent production recovery after PR #88 and unsafe Dream
-- delete-candidate overrides. The 40 records restored on 2026-07-20 are not
-- touched here.
--
-- Deliberately excluded:
--   mem_e61dba0a476b4e3c9521c7ccf406895f
-- It was retired on 2026-07-14, before the Dream override incident, and its
-- "say fear directly" rule is represented by the newer atomic rule and the
-- pinned consolidation memory.

-- Preserve the pre-recovery durable state for an audited reversal.
INSERT OR IGNORE INTO memory_events (
  id, namespace, event_type, memory_id, payload_json, created_at
)
SELECT
  'ev_recovery_20260722_' || substr(id, 5),
  namespace,
  'memory_recovery_snapshot',
  id,
  json_object(
    'operation', 'pr88_dream_delete_recovery_20260722',
    'before_status', status,
    'before_type', type,
    'before_pinned', pinned,
    'before_active_fact', active_fact,
    'before_vector_synced', vector_synced,
    'before_vector_sync_status', vector_sync_status,
    'before_five_axis_revision', five_axis_revision,
    'before_updated_at', updated_at
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM memories
WHERE status = 'deleted'
  AND id IN (
    -- Two meaningful PR #88 summaries missed by the first recovery pass.
    'mem_c0fa942d17b24645842b55c7b9b941cf',
    'mem_b8e54463628d4fbcb77d3f2f2575ae3e',
    -- Three records actually deleted by Dream override on 2026-07-20.
    'mem_0f734f50a7954cb9900773655efb0af1',
    'mem_0d6dd4a8f1504003a55f62642113156a',
    'mem_5cd7586d7b7c4959bb53bceee3f86f72'
  );

-- Restore the two missed event-bearing day summaries as recallable timeline
-- summaries. The semantic tag keeps them distinct from date-only shells.
UPDATE memories
SET status = 'active',
    active_fact = 1,
    pinned = 0,
    tags = CASE
      WHEN NOT json_valid(tags) THEN json_array('timeline_day_content:v1')
      WHEN NOT EXISTS (
        SELECT 1 FROM json_each(tags) WHERE value = 'timeline_day_content:v1'
      ) THEN json_insert(tags, '$[#]', 'timeline_day_content:v1')
      ELSE tags
    END,
    vector_synced = 0,
    vector_sync_status = 'pending',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source = 'timeline_split'
  AND type = 'timeline_day'
  AND status = 'deleted'
  AND id IN (
    'mem_c0fa942d17b24645842b55c7b9b941cf',
    'mem_b8e54463628d4fbcb77d3f2f2575ae3e'
  );

-- Restore only the three Dream-override victims. All active memories use
-- active_fact=1; fact_key is not a prerequisite for recall eligibility.
UPDATE memories
SET status = 'active',
    active_fact = 1,
    vector_synced = 0,
    vector_sync_status = 'pending',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status = 'deleted'
  AND id IN (
    'mem_0f734f50a7954cb9900773655efb0af1',
    'mem_0d6dd4a8f1504003a55f62642113156a',
    'mem_5cd7586d7b7c4959bb53bceee3f86f72'
  );
