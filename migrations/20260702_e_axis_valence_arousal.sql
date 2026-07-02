ALTER TABLE memories ADD COLUMN valence REAL;
ALTER TABLE memories ADD COLUMN arousal REAL;

CREATE INDEX IF NOT EXISTS idx_memories_e_axis_full
ON memories(namespace, valence, arousal, tension_score, status);
