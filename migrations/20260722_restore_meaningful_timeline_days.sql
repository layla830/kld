-- PR #88 retired every timeline_day row even though the type contained two
-- different concepts: date-only shells and genuine event-bearing day
-- summaries. Restore only the 42 reviewed summaries and mark their semantic
-- ownership explicitly. Date-only shells remain deleted.

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
  AND (
    status != 'active'
    OR active_fact != 1
    OR CASE
      WHEN json_valid(tags) THEN NOT EXISTS (
        SELECT 1 FROM json_each(tags) WHERE value = 'timeline_day_content:v1'
      )
      ELSE 1
    END
  )
  AND id IN (
    'mem_3d9c65fa21ea446fb7f1dc83511a9c8b',
    'mem_bc56a912bd824e70846ab7b0ad1a8a96',
    'mem_7cebc70be66949329a4d0b08da1d0e9a',
    'mem_9140287adaee4f45b2327955b33cdf4c',
    'mem_0c284f73e27a4f2591ab710e8ed6faf7',
    'mem_2a53be91bd03460da09a1275b83f448b',
    'mem_19af2da00a0244c8adda8fdd7d763ae0',
    'mem_1d427e3f20294d89994c4099ebb83a32',
    'mem_e4d25c928ae04112ae9d26b1dfdd711b',
    'mem_0a4d51c2cdc640109cb5c035e3370017',
    'mem_a25b35cc6ece4a5ea2d199aa51194eb6',
    'mem_27be7cc381b345c6be9468786f7bbe49',
    'mem_a41e576d5f2141c08e42deea75ff521f',
    'mem_d571ff344c6d4faca02dcc9d2d1dae53',
    'mem_cfdcff0db2b94b7498b9d3b1c317a5e3',
    'mem_f695837bfadb4838b0b4e7912ede6aa9',
    'mem_6cd513fe46af4fd7a334b42d44d792ae',
    'mem_31320b26e97440dcabb4d4d8c3c62b8b',
    'mem_95390e11632d492498453abc3abf3825',
    'mem_fa07095ae51540a9a90ab406216f79b1',
    'mem_577292b22ace419bb58cf56cac3b04a6',
    'mem_3cf9224028e94a678bba6a5b09112bcf',
    'mem_1749faf23abc447d990096a862a96ccb',
    'mem_47b0ae91111a4fd9b3e3452b55a22d69',
    'mem_a4433e5a19b24328a46b2f9bc971f465',
    'mem_495e92ca41e745488e4e7b7c72d14fc7',
    'mem_cb799961493841e38900a6851ea89120',
    'mem_ef06a43dd32d4651b5379cbc0812d148',
    'mem_413ee7f1f5aa4b8aa6c32bf8ee9abc16',
    'mem_01c1664c5c0d49a7bfc1a004d3621b92',
    'mem_7dd7e9e8537d42cfb7e55de284e90328',
    'mem_9d79a7614140457990c93a6527afa871',
    'mem_bc1a00a7f69645cc80ec38cb9ad3a741',
    'mem_ce3e050961ea46ccbf97e1cced977cf7',
    'mem_46311f25826f4a1fa0e834a7ea63b9e3',
    'mem_9314d72e853947928a3145032ce7420e',
    'mem_47bb2f711b8b42a49f1316d2bfc0b3f1',
    'mem_0f6ff2f82a31455a8c90b6cc74905a9d',
    'mem_075bf7eeecfc42fa83c2da7d2d8e8a50',
    'mem_ada5e68e757e488fb92a023feb528a09',
    'mem_c0fa942d17b24645842b55c7b9b941cf',
    'mem_b8e54463628d4fbcb77d3f2f2575ae3e'
  );

-- Record the revision that each restored summary had before this explicit
-- reprojection request. The marker makes the revision bump retry-safe if this
-- SQL was already run manually before Wrangler records the migration.
INSERT OR IGNORE INTO memory_events (
  id, namespace, event_type, memory_id, payload_json, created_at
)
SELECT
  'ev_reproject_20260722_' || substr(id, 5),
  namespace,
  'memory_five_axis_reprojection_requested',
  id,
  json_object(
    'operation', 'restore_meaningful_timeline_days_20260722',
    'before_five_axis_revision', five_axis_revision
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM memories
WHERE source = 'timeline_split'
  AND type = 'timeline_day'
  AND status = 'active'
  AND active_fact = 1
  AND EXISTS (
    SELECT 1 FROM json_each(CASE WHEN json_valid(tags) THEN tags ELSE '[]' END)
    WHERE value = 'timeline_day_content:v1'
  );

-- A direct revision write does not invoke the material-update trigger. Bump
-- once per marker, then enqueue the current revision explicitly so replicas,
-- staging databases and disaster restores reproduce the production result.
UPDATE memories AS memory
SET five_axis_revision = five_axis_revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE memory.source = 'timeline_split'
  AND memory.type = 'timeline_day'
  AND memory.status = 'active'
  AND memory.active_fact = 1
  AND EXISTS (
    SELECT 1 FROM memory_events AS event
    WHERE event.namespace = memory.namespace
      AND event.id = 'ev_reproject_20260722_' || substr(memory.id, 5)
      AND CAST(json_extract(event.payload_json, '$.before_five_axis_revision') AS INTEGER)
        = memory.five_axis_revision
  );

INSERT OR IGNORE INTO memory_five_axis_outbox (
  namespace, memory_id, memory_updated_at, memory_revision, status, attempts,
  created_at, updated_at
)
SELECT
  memory.namespace,
  memory.id,
  memory.updated_at,
  memory.five_axis_revision,
  'pending',
  0,
  memory.updated_at,
  memory.updated_at
FROM memories AS memory
WHERE memory.source = 'timeline_split'
  AND memory.type = 'timeline_day'
  AND memory.status = 'active'
  AND memory.active_fact = 1
  AND EXISTS (
    SELECT 1 FROM memory_events AS event
    WHERE event.namespace = memory.namespace
      AND event.id = 'ev_reproject_20260722_' || substr(memory.id, 5)
  );
