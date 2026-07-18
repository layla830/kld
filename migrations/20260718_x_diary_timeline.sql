CREATE TABLE IF NOT EXISTS memory_diary_timeline_memberships (
  namespace TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  origin_diary_id TEXT NOT NULL,
  timeline_key TEXT NOT NULL,
  event_date TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('day', 'item')),
  day_memory_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, memory_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_diary_timeline_memberships_timeline
ON memory_diary_timeline_memberships(namespace, timeline_key, event_date, role);

CREATE INDEX IF NOT EXISTS idx_memory_diary_timeline_memberships_day
ON memory_diary_timeline_memberships(namespace, origin_diary_id, event_date, day_memory_id);
