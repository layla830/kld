import type { MemoryRecord } from "../types";
import { buildVectorId } from "../utils/vectorId";

interface LegacyMemoryInput {
  id?: number | string;
  content_hash?: string;
  content?: string;
  tags?: string | null;
  tags_array?: string[];
  memory_type?: string | null;
  metadata?: string | null;
  metadata_json?: Record<string, unknown>;
  created_at?: number | null;
  updated_at?: number | null;
  created_at_iso?: string | null;
  updated_at_iso?: string | null;
}

export interface ImportLegacyMemoryResult {
  id: string;
  action: "inserted" | "updated";
}

function nowIso(): string {
  return new Date().toISOString();
}

function isoFromEpoch(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value * 1000).toISOString();
}

function readIso(value: unknown, fallbackEpoch?: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  return isoFromEpoch(fallbackEpoch) || nowIso();
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function parseMetadata(record: LegacyMemoryInput): Record<string, unknown> {
  if (record.metadata_json && typeof record.metadata_json === "object") return record.metadata_json;
  if (!record.metadata) return {};
  try {
    const parsed = JSON.parse(record.metadata) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { raw_metadata: record.metadata };
  }
}

function readNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function toRecord(input: LegacyMemoryInput, namespace: string): MemoryRecord {
  const legacyId = input.id === undefined || input.id === null ? crypto.randomUUID() : String(input.id);
  const id = `vps_${legacyId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const metadata = parseMetadata(input);
  const tags = unique([...readStringArray(input.tags_array), ...readStringArray(input.tags), "legacy:vps"]);
  const pinned = tags.includes("pinned") ? 1 : 0;
  const arousal = readNumber(metadata.emotional_arousal, 0);
  const accessCount = Math.max(0, Math.floor(readNumber(metadata.access_count, 0)));
  const importance = pinned ? 1 : clamp(0.55 + arousal * 0.35 + Math.min(accessCount, 10) * 0.01, 0.55, 0.95);
  const lastAccessed = isoFromEpoch(metadata.last_accessed_at);
  const content = typeof input.content === "string" ? input.content.trim() : "";
  const type = (input.memory_type || "note").trim() || "note";

  return {
    id,
    namespace,
    type,
    content,
    summary: null,
    importance,
    confidence: 0.95,
    status: "active",
    pinned,
    tags: JSON.stringify(tags),
    source: "vps-mcp-memory",
    source_message_ids: JSON.stringify(unique([`vps:${legacyId}`, input.content_hash ? `hash:${input.content_hash}` : ""])),
    vector_id: buildVectorId(id),
    last_recalled_at: lastAccessed,
    recall_count: accessCount,
    created_at: readIso(input.created_at_iso, input.created_at),
    updated_at: readIso(input.updated_at_iso, input.updated_at),
    expires_at: null
  };
}

export async function ensureMemorySchema(db: D1Database): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL DEFAULT 'default',
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT,
      importance REAL NOT NULL DEFAULT 0.5,
      confidence REAL NOT NULL DEFAULT 0.8,
      status TEXT NOT NULL DEFAULT 'active',
      pinned INTEGER NOT NULL DEFAULT 0,
      tags TEXT,
      source TEXT,
      source_message_ids TEXT,
      vector_id TEXT,
      last_recalled_at TEXT,
      recall_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT
    )`,
    "CREATE INDEX IF NOT EXISTS idx_memories_namespace_status ON memories(namespace, status)",
    "CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)",
    "CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned)"
  ];

  for (const statement of statements) {
    await db.prepare(statement).run();
  }
}

export async function importLegacyMemory(
  db: D1Database,
  input: LegacyMemoryInput,
  namespace = "default"
): Promise<{ record: MemoryRecord; result: ImportLegacyMemoryResult }> {
  const record = toRecord(input, namespace);
  if (!record.content) throw new Error("memory content is required");

  const existing = await db.prepare("SELECT id FROM memories WHERE id = ?").bind(record.id).first<{ id: string }>();

  await db
    .prepare(
      `INSERT OR REPLACE INTO memories (
        id, namespace, type, content, summary, importance, confidence, status,
        pinned, tags, source, source_message_ids, vector_id, last_recalled_at,
        recall_count, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      record.id,
      record.namespace,
      record.type,
      record.content,
      record.summary,
      record.importance,
      record.confidence,
      record.status,
      record.pinned,
      record.tags,
      record.source,
      record.source_message_ids,
      record.vector_id,
      record.last_recalled_at,
      record.recall_count,
      record.created_at,
      record.updated_at,
      record.expires_at
    )
    .run();

  return { record, result: { id: record.id, action: existing ? "updated" : "inserted" } };
}
