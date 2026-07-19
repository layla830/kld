import { nowIso } from "../utils/time";
import { sha256Hex } from "../utils/hash";

export const RECALL_SIGNAL_SOURCES = ["api_context", "gateway_injection", "mcp_retrieve"] as const;
export type RecallSignalSource = (typeof RECALL_SIGNAL_SOURCES)[number];

const MAX_SIGNAL_IDS = 100;
const D1_BATCH_STATEMENTS = 50;

export interface RecordRecallSignalsInput {
  namespace: string;
  operationId: string;
  source: RecallSignalSource;
  memoryIds: string[];
  recalledAt?: string;
}

export interface RecordRecallSignalsResult {
  attempted: number;
  recorded: number;
}

function normalizeIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id && !id.startsWith("msg_")))]
    .slice(0, MAX_SIGNAL_IDS);
}

function normalizeRequired(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized.slice(0, maxLength);
}

function normalizeRecalledAt(value: string | undefined): string {
  const parsed = value ? new Date(value) : new Date(nowIso());
  if (Number.isNaN(parsed.getTime())) throw new Error("recalledAt must be a valid timestamp");
  return parsed.toISOString();
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

export async function recordRecallSignals(
  db: D1Database,
  input: RecordRecallSignalsInput
): Promise<RecordRecallSignalsResult> {
  const namespace = normalizeRequired(input.namespace, "namespace", 120);
  const operationId = normalizeRequired(input.operationId, "operationId", 240);
  const recalledAt = normalizeRecalledAt(input.recalledAt);
  const recallDay = recalledAt.slice(0, 10);
  const memoryIds = normalizeIds(input.memoryIds);
  let recorded = 0;

  for (const group of chunks(memoryIds, D1_BATCH_STATEMENTS)) {
    const results = await db.batch<{ inserted: number }>(group.map((memoryId) => db.prepare(
      `INSERT OR IGNORE INTO memory_recall_receipts (
         namespace, operation_id, memory_id, source, recall_day, recalled_at, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM memories WHERE namespace = ? AND id = ?
       )
       RETURNING 1 AS inserted`
    ).bind(
      namespace,
      operationId,
      memoryId,
      input.source,
      recallDay,
      recalledAt,
      recalledAt,
      namespace,
      memoryId
    )));
    recorded += results.reduce((sum, result) => sum + (result.results?.length ?? 0), 0);
  }

  if (memoryIds.length > 0) {
    const eventHash = await sha256Hex(`${namespace}\n${input.source}\n${operationId}`);
    await db.prepare(
      `INSERT OR IGNORE INTO memory_events (
         id, namespace, event_type, memory_id, payload_json, created_at
       ) VALUES (?, ?, 'recall_signal_recorded', NULL, ?, ?)`
    ).bind(
      `ev_recall_${eventHash.slice(0, 40)}`,
      namespace,
      JSON.stringify({
        operation_id: operationId,
        source: input.source,
        memory_ids: memoryIds,
        result_count: memoryIds.length
      }),
      recalledAt
    ).run();
  }

  return { attempted: memoryIds.length, recorded };
}
