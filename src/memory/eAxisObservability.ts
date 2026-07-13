import { createMemoryEvent } from "../db/memoryEvents";
import type { Env } from "../types";
import { readShadowState, type ShadowState } from "./eAxis";
import type { EAxisFusionTrace, EAxisRankChange } from "./recallFusion";

export interface EAxisObservationSample {
  createdAt: string;
  queryHash: string;
  source: "automatic_recall" | "mcp_retrieve";
  trace: EAxisFusionTrace;
}

export interface EAxisObservabilityData {
  state: ShadowState;
  windowDays: number;
  samples: number;
  changedQueries: number;
  changedRate: number;
  averageBoosted: number;
  recent: EAxisObservationSample[];
}

interface RecallObservationRow {
  event_type: string;
  payload_json: string;
  created_at: string;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableRank(value: unknown): number | null {
  return value === null ? null : typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 20) : [];
}

function parseEAxisRankChange(value: unknown): EAxisRankChange | null {
  const record = objectValue(value);
  if (!record || typeof record.id !== "string" || typeof record.type !== "string") return null;
  return {
    id: record.id,
    type: record.type,
    fact_key: typeof record.fact_key === "string" ? record.fact_key : null,
    baseline_rank: nullableRank(record.baseline_rank),
    e_axis_rank: nullableRank(record.e_axis_rank),
    baseline_score: numberValue(record.baseline_score),
    e_axis_score: numberValue(record.e_axis_score),
    boost: numberValue(record.boost)
  };
}

function parseEAxisTrace(value: unknown): EAxisFusionTrace | null {
  const record = objectValue(value);
  if (!record || (record.mode !== "shadow" && record.mode !== "active")) return null;
  return {
    mode: record.mode,
    evaluated: record.evaluated === true,
    compared_count: numberValue(record.compared_count),
    boosted_count: numberValue(record.boosted_count),
    changed_count: numberValue(record.changed_count),
    top_k_changed: record.top_k_changed === true,
    baseline_top_ids: stringArray(record.baseline_top_ids),
    e_axis_top_ids: stringArray(record.e_axis_top_ids),
    changes: Array.isArray(record.changes)
      ? record.changes.map(parseEAxisRankChange).filter((change): change is EAxisRankChange => change !== null).slice(0, 12)
      : []
  };
}

function parseEAxisObservation(row: RecallObservationRow): EAxisObservationSample | null {
  let payload: unknown;
  try { payload = JSON.parse(row.payload_json); } catch { return null; }
  const payloadRecord = objectValue(payload);
  const traceRecord = objectValue(payloadRecord?.trace);
  const trace = parseEAxisTrace(traceRecord?.e_axis);
  if (!trace?.evaluated) return null;
  return {
    createdAt: row.created_at,
    queryHash: typeof payloadRecord?.query_hash === "string" ? payloadRecord.query_hash : "unknown",
    source: row.event_type === "recall_search_observed" ? "mcp_retrieve" : "automatic_recall",
    trace
  };
}

export async function hashRecallQuery(query: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(query));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export async function recordRecallSearchObservation(
  env: Env,
  input: {
    namespace: string;
    query: string;
    source: "mcp_retrieve";
    resultIds: string[];
    eAxis: EAxisFusionTrace;
  }
): Promise<void> {
  await createMemoryEvent(env.DB, {
    namespace: input.namespace,
    eventType: "recall_search_observed",
    payload: {
      query_hash: await hashRecallQuery(input.query),
      query_length: input.query.length,
      source: input.source,
      result_count: input.resultIds.length,
      memory_ids: input.resultIds,
      trace: { e_axis: input.eAxis }
    }
  });
}

export async function fetchEAxisObservability(
  env: Env,
  namespace = "default",
  windowDays = 7
): Promise<EAxisObservabilityData> {
  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const result = await env.DB.prepare(
    `SELECT event_type, payload_json, created_at
     FROM memory_events
     WHERE namespace = ?
       AND event_type IN ('recall_context_injected', 'recall_search_observed')
       AND created_at >= ?
     ORDER BY created_at DESC
     LIMIT 200`
  ).bind(namespace, cutoff).all<RecallObservationRow>();
  const observations = (result.results ?? []).map(parseEAxisObservation).filter((item): item is EAxisObservationSample => item !== null);
  const changedQueries = observations.filter((item) => item.trace.top_k_changed).length;
  const boostedTotal = observations.reduce((sum, item) => sum + item.trace.boosted_count, 0);
  return {
    state: readShadowState(env),
    windowDays,
    samples: observations.length,
    changedQueries,
    changedRate: observations.length ? Math.round((changedQueries / observations.length) * 1000) / 10 : 0,
    averageBoosted: observations.length ? Math.round((boostedTotal / observations.length) * 10) / 10 : 0,
    recent: observations.filter((item) => item.trace.boosted_count > 0 || item.trace.top_k_changed).slice(0, 10)
  };
}
