INSERT INTO cache_entries (
  id, namespace, key, value_json, value_text, content_type, tags,
  size_bytes, expires_at, created_at, updated_at
)
VALUES (
  'cache_lmc5_e_axis_state_default',
  'default',
  'lmc5:e-axis:runtime-state',
  '{"started_at":"2026-07-13T12:22:37.508657Z"}',
  NULL,
  'application/json',
  '["lmc5","e-axis","runtime-state"]',
  length('{"started_at":"2026-07-13T12:22:37.508657Z"}'),
  NULL,
  '2026-07-13T12:22:37.508657Z',
  '2026-07-13T12:22:37.508657Z'
)
ON CONFLICT(namespace, key) DO NOTHING;
