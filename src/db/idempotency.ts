import { nowIso } from "../utils/time";

export async function tryStartIdempotentTask(
  db: D1Database,
  input: { key: string; taskType: string }
): Promise<boolean> {
  const now = nowIso();

  try {
    await db
      .prepare(
        `INSERT INTO idempotency_keys (key, task_type, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(input.key, input.taskType, "processing", now, now)
      .run();
    return true;
  } catch {
    const result = await db
      .prepare(
        `UPDATE idempotency_keys
         SET status = ?, updated_at = ?
         WHERE key = ? AND status = ?`
      )
      .bind("processing", now, input.key, "failed")
      .run();

    return (result.meta.changes ?? 0) > 0;
  }
}

export async function finishIdempotentTask(
  db: D1Database,
  input: { key: string; status: "done" | "failed" }
): Promise<void> {
  await db
    .prepare("UPDATE idempotency_keys SET status = ?, updated_at = ? WHERE key = ?")
    .bind(input.status, nowIso(), input.key)
    .run();
}
