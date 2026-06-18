ALTER TABLE memories ADD COLUMN thread TEXT;
ALTER TABLE memories ADD COLUMN risk_level TEXT;
ALTER TABLE memories ADD COLUMN urgency_level TEXT;
ALTER TABLE memories ADD COLUMN tension_score REAL;
ALTER TABLE memories ADD COLUMN response_posture TEXT;
ALTER TABLE memories ADD COLUMN audit_state TEXT;

CREATE INDEX IF NOT EXISTS idx_memories_thread
ON memories(namespace, thread, status);

CREATE INDEX IF NOT EXISTS idx_memories_experience
ON memories(namespace, risk_level, urgency_level, tension_score, status);
