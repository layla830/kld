import { newId } from "../utils/ids";
import { nowIso } from "../utils/time";
import {
  COLD_MEMORY_MAX_CONFIDENCE,
  COLD_MEMORY_MAX_IMPORTANCE,
  PROTECTED_MEMORY_TYPES
} from "./metabolismReview";

const POLICY_KEY = "recall_shadow_v1";
const MAX_SCAN_ROWS = 1000;
const STATEMENTS_PER_BATCH = 40;
const PROMOTION_EXCLUDED_TYPES = new Set(["diary", "layla_diary", "auto_diary", "dream_review"]);

type SignalBand = "none" | "cooled_after_use" | "promote" | "configuration_conflict";

interface SignalRow {
  id: string;
  type: string;
  importance: number;
  confidence: number;
  pinned: number;
  recall_count: number;
  last_recalled_at: string | null;
  has_relation: number;
  recalls_7d: number;
  recalls_30d: number;
  recalls_90d: number;
  recalls_180d: number;
  active_days_30d: number;
  api_recalls_30d: number;
  gateway_recalls_30d: number;
  mcp_recalls_30d: number;
  previous_band: string | null;
}

export interface RecallMetabolismShadowResult {
  scanned: number;
  activeBands: number;
  transitions: number;
  bands: Record<SignalBand, number>;
}

function daysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

function dayBefore(now: Date, days: number): string {
  return daysBefore(now, days).slice(0, 10);
}

function finite(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function bandFor(row: SignalRow, cooledBefore: string): SignalBand {
  const cooled = row.recall_count >= 5
    && Boolean(row.last_recalled_at && row.last_recalled_at < cooledBefore)
    && finite(row.recalls_30d) === 0
    && finite(row.recalls_90d) === 0
    && row.pinned === 0
    && !PROTECTED_MEMORY_TYPES.has(row.type)
    && row.importance <= COLD_MEMORY_MAX_IMPORTANCE
    && row.confidence <= COLD_MEMORY_MAX_CONFIDENCE
    && row.has_relation === 0;
  const promote = finite(row.recalls_7d) >= 3
    && finite(row.recalls_30d) >= 5
    && finite(row.active_days_30d) >= 2
    && row.importance < 0.8
    && !PROMOTION_EXCLUDED_TYPES.has(row.type);

  if (cooled && promote) return "configuration_conflict";
  if (cooled) return "cooled_after_use";
  if (promote) return "promote";
  return "none";
}

function proposedAction(band: SignalBand): string | null {
  if (band === "cooled_after_use") return "m_archive";
  if (band === "promote") return "m_promote";
  return null;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

export async function observeRecallMetabolismSignals(
  env: { DB: D1Database },
  namespace: string,
  options: { dryRun?: boolean; now?: Date } = {}
): Promise<RecallMetabolismShadowResult> {
  const now = options.now ?? new Date();
  const observedAt = now.toISOString();
  const cutoff7 = dayBefore(now, 6);
  const cutoff30 = dayBefore(now, 29);
  const cutoff90 = dayBefore(now, 89);
  const cutoff180 = dayBefore(now, 179);
  const cooledBefore = daysBefore(now, 180);
  const result = await env.DB.prepare(
    `WITH source_daily AS (
       SELECT memory_id, recall_day, source, SUM(recall_count) AS raw_count
       FROM memory_recall_daily
       WHERE namespace = ? AND recall_day >= ?
       GROUP BY memory_id, recall_day, source
     ), day_totals AS (
       SELECT memory_id, recall_day,
         CASE WHEN SUM(raw_count) > 3 THEN 3 ELSE SUM(raw_count) END AS effective_count
       FROM source_daily
       GROUP BY memory_id, recall_day
     ), windows AS (
       SELECT memory_id,
         SUM(CASE WHEN recall_day >= ? THEN effective_count ELSE 0 END) AS recalls_7d,
         SUM(CASE WHEN recall_day >= ? THEN effective_count ELSE 0 END) AS recalls_30d,
         SUM(CASE WHEN recall_day >= ? THEN effective_count ELSE 0 END) AS recalls_90d,
         SUM(CASE WHEN recall_day >= ? THEN effective_count ELSE 0 END) AS recalls_180d,
         COUNT(DISTINCT CASE WHEN recall_day >= ? THEN recall_day END) AS active_days_30d
       FROM day_totals
       GROUP BY memory_id
     ), source_windows AS (
       SELECT memory_id,
         SUM(CASE WHEN recall_day >= ? AND source = 'api_context' THEN MIN(raw_count, 3) ELSE 0 END) AS api_recalls_30d,
         SUM(CASE WHEN recall_day >= ? AND source = 'gateway_injection' THEN MIN(raw_count, 3) ELSE 0 END) AS gateway_recalls_30d,
         SUM(CASE WHEN recall_day >= ? AND source = 'mcp_retrieve' THEN MIN(raw_count, 3) ELSE 0 END) AS mcp_recalls_30d
       FROM source_daily
       GROUP BY memory_id
     )
     SELECT m.id, m.type, m.importance, m.confidence, m.pinned,
       m.recall_count, m.last_recalled_at,
       CASE WHEN EXISTS (
         SELECT 1 FROM memory_relations r
         WHERE r.namespace = m.namespace
           AND (r.source_memory_id = m.id OR r.target_memory_id = m.id)
       ) THEN 1 ELSE 0 END AS has_relation,
       COALESCE(w.recalls_7d, 0) AS recalls_7d,
       COALESCE(w.recalls_30d, 0) AS recalls_30d,
       COALESCE(w.recalls_90d, 0) AS recalls_90d,
       COALESCE(w.recalls_180d, 0) AS recalls_180d,
       COALESCE(w.active_days_30d, 0) AS active_days_30d,
       COALESCE(sw.api_recalls_30d, 0) AS api_recalls_30d,
       COALESCE(sw.gateway_recalls_30d, 0) AS gateway_recalls_30d,
       COALESCE(sw.mcp_recalls_30d, 0) AS mcp_recalls_30d,
       state.band AS previous_band
     FROM memories m
     LEFT JOIN windows w ON w.memory_id = m.id
     LEFT JOIN source_windows sw ON sw.memory_id = m.id
     LEFT JOIN memory_metabolism_signal_state state
       ON state.namespace = m.namespace AND state.memory_id = m.id AND state.policy_key = ?
     WHERE m.namespace = ? AND m.status = 'active'
     ORDER BY m.id
     LIMIT ?`
  ).bind(
    namespace,
    cutoff180,
    cutoff7,
    cutoff30,
    cutoff90,
    cutoff180,
    cutoff30,
    cutoff30,
    cutoff30,
    cutoff30,
    POLICY_KEY,
    namespace,
    MAX_SCAN_ROWS
  ).all<SignalRow>();

  const rows = result.results ?? [];
  const bands: Record<SignalBand, number> = {
    none: 0,
    cooled_after_use: 0,
    promote: 0,
    configuration_conflict: 0
  };
  const transitions: Array<{ row: SignalRow; band: SignalBand; payload: Record<string, unknown> }> = [];

  for (const row of rows) {
    const band = bandFor(row, cooledBefore);
    bands[band] += 1;
    const previousBand = row.previous_band ?? "none";
    if (band === previousBand || (band === "none" && row.previous_band === null)) continue;
    transitions.push({
      row,
      band,
      payload: {
        policy: POLICY_KEY,
        shadow: true,
        previous_band: previousBand,
        band,
        proposed_action: proposedAction(band),
        metrics: {
          lifetime_recall_count: row.recall_count,
          last_recalled_at: row.last_recalled_at,
          recalls_7d: finite(row.recalls_7d),
          recalls_30d: finite(row.recalls_30d),
          recalls_90d: finite(row.recalls_90d),
          recalls_180d: finite(row.recalls_180d),
          active_days_30d: finite(row.active_days_30d),
          source_recalls_30d: {
            api_context: finite(row.api_recalls_30d),
            gateway_injection: finite(row.gateway_recalls_30d),
            mcp_retrieve: finite(row.mcp_recalls_30d)
          }
        },
        thresholds: {
          cooled_after_use: { lifetime_min: 5, cold_days: 180, recalls_30d: 0, recalls_90d: 0 },
          promote: { recalls_7d_min: 3, recalls_30d_min: 5, active_days_30d_min: 2, importance_cap: 0.8 },
          effective_daily_cap: 3
        },
        observed_at: observedAt
      }
    });
  }

  if (!options.dryRun && transitions.length > 0) {
    const statements = transitions.flatMap(({ row, band, payload }) => [
      env.DB.prepare(
        `INSERT INTO memory_metabolism_signal_state (
           namespace, memory_id, policy_key, band, payload_json, first_observed_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(namespace, memory_id, policy_key) DO UPDATE SET
           band = excluded.band,
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`
      ).bind(namespace, row.id, POLICY_KEY, band, JSON.stringify(payload), observedAt, observedAt),
      env.DB.prepare(
        `INSERT INTO memory_events (id, namespace, event_type, memory_id, payload_json, created_at)
         VALUES (?, ?, 'metabolism_signal_observed', ?, ?, ?)`
      ).bind(newId("ev"), namespace, row.id, JSON.stringify(payload), observedAt)
    ]);
    for (const group of chunks(statements, STATEMENTS_PER_BATCH)) await env.DB.batch(group);
  }

  return {
    scanned: rows.length,
    activeBands: rows.length - bands.none,
    transitions: transitions.length,
    bands
  };
}
