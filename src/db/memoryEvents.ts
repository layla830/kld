import { newId } from "../utils/ids";
import { nowIso } from "../utils/time";
import type { MemoryMutationGuard } from "./memories";

export interface MemoryEventInput {
  namespace: string;
  eventType: string;
  memoryId?: string | null;
  payload: Record<string, unknown>;
}

export function prepareMemoryEventInsert(
  db: D1Database,
  input: MemoryEventInput,
  options: {
    id?: string;
    now?: string;
    guard?: MemoryMutationGuard;
  } = {}
): D1PreparedStatement {
  const guardSql = options.guard ? `WHERE (${options.guard.sql})` : "";
  return db.prepare(
    `INSERT INTO memory_events (id, namespace, event_type, memory_id, payload_json, created_at)
     SELECT ?, ?, ?, ?, ?, ?
     ${guardSql}`
  ).bind(
    options.id ?? newId("ev"),
    input.namespace,
    input.eventType,
    input.memoryId ?? null,
    JSON.stringify(input.payload),
    options.now ?? nowIso(),
    ...(options.guard?.binds ?? [])
  );
}

export async function createMemoryEvent(
  db: D1Database,
  input: MemoryEventInput
): Promise<void> {
  await prepareMemoryEventInsert(db, input).run();
}
