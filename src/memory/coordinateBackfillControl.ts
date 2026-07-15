import { getCacheEntry, parseCacheEntryValue, putCacheEntry } from "../db/cacheEntries";
import type { MemoryKeysetCursor } from "../db/memories";
import type { Env } from "../types";

const CONTROL_KEY = "maintenance:coordinate_backfill";

export type CoordinateBackfillCursor = MemoryKeysetCursor;

export interface CoordinateBackfillControl {
  enabled: boolean;
  lastRunAt: string | null;
  lastResult: unknown | null;
  cursor: CoordinateBackfillCursor | null;
}

export interface CoordinateBackfillStatus extends CoordinateBackfillControl {
  totalActive: number;
  completed: number;
  remaining: number;
  progressPercent: number;
  estimatedMinutes: number;
  pendingReview: number;
}

function readControl(value: unknown): CoordinateBackfillControl {
  if (!value || typeof value !== "object") return { enabled: true, lastRunAt: null, lastResult: null, cursor: null };
  const record = value as Record<string, unknown>;
  const rawCursor = record.cursor;
  const cursor = rawCursor && typeof rawCursor === "object"
    && typeof (rawCursor as Record<string, unknown>).createdAt === "string"
    && typeof (rawCursor as Record<string, unknown>).id === "string"
    ? {
        createdAt: (rawCursor as Record<string, string>).createdAt,
        id: (rawCursor as Record<string, string>).id
      }
    : null;
  return {
    enabled: record.enabled !== false,
    lastRunAt: typeof record.lastRunAt === "string" ? record.lastRunAt : null,
    lastResult: record.lastResult ?? null,
    cursor
  };
}

export async function getCoordinateBackfillControl(env: Env, namespace: string): Promise<CoordinateBackfillControl> {
  const entry = await getCacheEntry(env.DB, { namespace, key: CONTROL_KEY });
  return entry ? readControl(parseCacheEntryValue(entry)) : readControl(null);
}

async function saveControl(env: Env, namespace: string, control: CoordinateBackfillControl): Promise<void> {
  await putCacheEntry(env.DB, { namespace, key: CONTROL_KEY, value: control, contentType: "application/json", tags: ["maintenance", "coordinate-backfill"] });
}

export async function setCoordinateBackfillEnabled(env: Env, namespace: string, enabled: boolean): Promise<void> {
  const current = await getCoordinateBackfillControl(env, namespace);
  await saveControl(env, namespace, { ...current, enabled });
}

export async function recordCoordinateBackfillRun(
  env: Env,
  namespace: string,
  result: unknown,
  cursor: CoordinateBackfillCursor | null
): Promise<void> {
  const current = await getCoordinateBackfillControl(env, namespace);
  await saveControl(env, namespace, { ...current, lastRunAt: new Date().toISOString(), lastResult: result, cursor });
}

export async function getCoordinateBackfillStatus(env: Env, namespace: string): Promise<CoordinateBackfillStatus> {
  const [control, totalRow, remainingRow, reviewRow] = await Promise.all([
    getCoordinateBackfillControl(env, namespace),
    env.DB.prepare("SELECT COUNT(*) AS count FROM memories WHERE namespace = ? AND status = 'active'").bind(namespace).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM memories
       WHERE namespace = ? AND status = 'active' AND (
         thread IS NULL OR trim(thread) = ''
         OR risk_level IS NULL OR trim(risk_level) = ''
         OR urgency_level IS NULL OR trim(urgency_level) = ''
         OR tension_score IS NULL
         OR response_posture IS NULL OR trim(response_posture) = ''
         OR valence IS NULL
         OR arousal IS NULL
       )`
    ).bind(namespace).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM memory_candidates WHERE namespace = ? AND external_key LIKE 'coordinate-backfill:%' AND status IN ('pending','needs_subject_review')").bind(namespace).first<{ count: number }>()
  ]);
  const totalActive = totalRow?.count ?? 0;
  const remaining = remainingRow?.count ?? 0;
  const completed = Math.max(0, totalActive - remaining);
  return { ...control, totalActive, completed, remaining, progressPercent: totalActive > 0 ? Math.round((completed / totalActive) * 1000) / 10 : 100, estimatedMinutes: Math.ceil(remaining / 5) * 5, pendingReview: reviewRow?.count ?? 0 };
}
