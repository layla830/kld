import { dismissPendingMemoryCandidateByExternalKey, upsertMemoryCandidate } from "../db/memoryCandidates";
import { fetchMemoriesByIds, listCoordinateBackfillCandidates, listMemories, updateMemory } from "../db/memories";
import type { Env, MemoryRecord } from "../types";
import { loadModelConfig, systemClock } from "../config/runtime";
import type { CoordinateBackfillCursor } from "./coordinateBackfillControl";
import {
  normalizeArousal,
  normalizeResponsePosture,
  normalizeRiskLevel,
  normalizeTensionScore,
  normalizeThread,
  normalizeUrgencyLevel,
  normalizeValence
} from "./coordinates";

export const COORDINATE_BACKFILL_BATCH_SIZE = 5;

type BackfillUpdate = Record<string, unknown> & { id: string };
export type CoordinatePatch = Parameters<typeof updateMemory>[1]["patch"];
export type CoordinateLabeler = (env: Env, model: string, memories: MemoryRecord[]) => Promise<BackfillUpdate[]>;
export type CoordinateBackfillSelection = "empty_bundle" | "missing_fields";

export interface CoordinateBackfillCommand {
  namespace: string;
  apply: boolean;
  limit?: number;
  offset?: number;
  ids?: string[];
  selection?: CoordinateBackfillSelection;
}

export interface CoordinateBackfillResult {
  ok: true;
  mode: "dry_run" | "auto_apply_with_exception_review";
  scanned: number;
  needBackfill: number;
  offset: number;
  nextOffset: number | null;
  processed: number;
  applied: number;
  queued: number;
  message?: string;
  results?: Array<{
    id: string;
    outcome: string;
    automatic_fields: string[];
    review_fields: string[];
    review_reasons: string[];
    before: Record<string, unknown>;
    proposed: Record<string, unknown>;
  }>;
  cursor?: CoordinateBackfillCursor | null;
}

export async function runScheduledCoordinateBackfill(
  env: Env,
  namespace: string,
  labelBatch: CoordinateLabeler,
  cursor: CoordinateBackfillCursor | null = null
): Promise<CoordinateBackfillResult> {
  let candidates = await listCoordinateBackfillCandidates(env.DB, {
    namespace,
    limit: COORDINATE_BACKFILL_BATCH_SIZE,
    cursor
  });
  if (candidates.length === 0 && cursor) {
    candidates = await listCoordinateBackfillCandidates(env.DB, {
      namespace,
      limit: COORDINATE_BACKFILL_BATCH_SIZE,
      cursor: null
    });
  }
  if (candidates.length === 0) {
    return {
      ok: true,
      mode: "auto_apply_with_exception_review",
      scanned: 0,
      needBackfill: 0,
      offset: 0,
      nextOffset: null,
      processed: 0,
      applied: 0,
      queued: 0,
      cursor: null,
      message: "No memories need scheduled coordinate backfill"
    };
  }
  const result = await runCoordinateBackfill(env, {
    namespace,
    apply: true,
    limit: COORDINATE_BACKFILL_BATCH_SIZE,
    offset: 0,
    selection: "missing_fields",
    ids: candidates.map((memory) => memory.id)
  }, labelBatch);
  const last = candidates[candidates.length - 1];
  return { ...result, cursor: { createdAt: last.created_at, id: last.id } };
}

const THREAD_SLUG = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function missingText(value: string | null): boolean {
  return value === null || !value.trim();
}

export function needsCoordinateBackfill(
  memory: MemoryRecord,
  selection: CoordinateBackfillSelection = "missing_fields"
): boolean {
  if (selection === "empty_bundle") {
    return !memory.fact_key && !memory.thread && memory.risk_level === null && memory.valence === null;
  }
  return missingText(memory.thread)
    || missingText(memory.risk_level)
    || missingText(memory.urgency_level)
    || memory.tension_score === null
    || missingText(memory.response_posture)
    || memory.valence === null
    || memory.arousal === null;
}

export function coordinatePatchForMissingFields(
  current: MemoryRecord,
  record: Record<string, unknown>
): CoordinatePatch {
  const patch: CoordinatePatch = {};
  const thread = normalizeThread(record.thread);
  const riskLevel = normalizeRiskLevel(record.risk_level);
  const urgencyLevel = normalizeUrgencyLevel(record.urgency_level);
  const tensionScore = normalizeTensionScore(record.tension_score);
  const responsePosture = normalizeResponsePosture(record.response_posture);
  const valence = normalizeValence(record.valence);
  const arousal = normalizeArousal(record.arousal);

  if (missingText(current.thread) && thread !== null) patch.thread = thread;
  if (missingText(current.risk_level) && riskLevel !== null) patch.riskLevel = riskLevel;
  if (missingText(current.urgency_level) && urgencyLevel !== null) patch.urgencyLevel = urgencyLevel;
  if (current.tension_score === null && tensionScore !== null) patch.tensionScore = tensionScore;
  if (missingText(current.response_posture) && responsePosture !== null) patch.responsePosture = responsePosture;
  if (current.valence === null && valence !== null) patch.valence = valence;
  if (current.arousal === null && arousal !== null) patch.arousal = arousal;
  return patch;
}

function coordinatePayload(patch: CoordinatePatch): Record<string, unknown> {
  return Object.fromEntries(Object.entries({
    fact_key: patch.factKey,
    thread: patch.thread,
    risk_level: patch.riskLevel,
    urgency_level: patch.urgencyLevel,
    tension_score: patch.tensionScore,
    response_posture: patch.responsePosture,
    valence: patch.valence,
    arousal: patch.arousal
  }).filter(([, value]) => value !== undefined));
}

function splitCoordinatePatch(patch: CoordinatePatch): {
  automatic: CoordinatePatch;
  review: CoordinatePatch;
  reasons: string[];
} {
  const reasons: string[] = [];
  const automatic = { ...patch };
  const review: CoordinatePatch = {};
  const move = (key: keyof CoordinatePatch, reason: string) => {
    if (automatic[key] === undefined) return;
    (review as Record<string, unknown>)[key] = automatic[key];
    delete automatic[key];
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  if (patch.thread && !THREAD_SLUG.test(patch.thread)) move("thread", "noncanonical_thread");
  return { automatic, review, reasons };
}

export async function runCoordinateBackfill(
  env: Env,
  command: CoordinateBackfillCommand,
  labelBatch: CoordinateLabeler
): Promise<CoordinateBackfillResult> {
  const namespace = command.namespace || "default";
  const apply = command.apply;
  const limit = Math.min(Math.max(Math.floor(command.limit ?? COORDINATE_BACKFILL_BATCH_SIZE), 1), COORDINATE_BACKFILL_BATCH_SIZE);
  const offset = Math.min(Math.max(Math.floor(command.offset ?? 0), 0), 1_000);
  const model = loadModelConfig(env).coordinate;
  if (!model) throw new Error("missing_model");

  const requestedIds = [...new Set((command.ids ?? []).map((id) => id.trim()).filter(Boolean))].slice(0, COORDINATE_BACKFILL_BATCH_SIZE);
  const selection = command.selection ?? "empty_bundle";
  const allMemories = requestedIds.length > 0
    ? (await fetchMemoriesByIds(env.DB, { namespace, ids: requestedIds })).filter((memory) => memory.status === "active")
    : await listMemories(env.DB, { namespace, status: "active", limit: 1000 });
  const needBackfill = allMemories.filter((memory) => needsCoordinateBackfill(memory, selection));
  const batch = needBackfill.slice(offset, offset + limit);
  const mode = apply ? "auto_apply_with_exception_review" : "dry_run";

  if (batch.length === 0) {
    return {
      ok: true, mode, scanned: allMemories.length, needBackfill: needBackfill.length,
      offset, nextOffset: null, processed: 0, applied: 0, queued: 0,
      message: "No memories in this backfill page"
    };
  }

  const updates = await labelBatch(env, model, batch);
  const byId = new Map(batch.map((memory) => [memory.id, memory]));
  const results: NonNullable<CoordinateBackfillResult["results"]> = [];
  let applied = 0;
  let queued = 0;

  for (const record of updates) {
    const id = typeof record.id === "string" ? record.id : null;
    const current = id ? byId.get(id) : null;
    if (!id || !current) continue;

    const patch = coordinatePatchForMissingFields(current, record);
    if (Object.keys(patch).length === 0) continue;

    const before = {
      fact_key: current.fact_key, thread: current.thread, risk_level: current.risk_level,
      urgency_level: current.urgency_level, tension_score: current.tension_score,
      response_posture: current.response_posture, valence: current.valence, arousal: current.arousal
    };
    const proposed = coordinatePayload(patch);
    const split = splitCoordinatePatch(patch);
    const automaticFields = Object.keys(split.automatic);
    const reviewFields = Object.keys(split.review);

    if (apply) {
      if (automaticFields.length > 0) {
        const updated = await updateMemory(env.DB, { namespace, id, patch: split.automatic });
        if (updated) applied += 1;
      }
      if (reviewFields.length > 0) {
        await upsertMemoryCandidate(env.DB, namespace, {
          externalKey: `coordinate-backfill:${id}`,
          dreamDate: systemClock.today(),
          action: "update",
          subject: "memory_coordinates",
          targetId: id,
          payload: { _kind: "coordinate_backfill", _before: before, _review_reasons: split.reasons, ...coordinatePayload(split.review) },
          sourceChunkIds: [], sourceChunks: [], status: "pending"
        });
        queued += 1;
      } else {
        await dismissPendingMemoryCandidateByExternalKey(env.DB, namespace, `coordinate-backfill:${id}`);
      }
    }

    const outcome = !apply ? "dry_run" : automaticFields.length > 0 && reviewFields.length > 0
      ? "auto_and_review" : reviewFields.length > 0 ? "review" : "auto_applied";
    results.push({ id, outcome, automatic_fields: automaticFields, review_fields: reviewFields, review_reasons: split.reasons, before, proposed });
  }

  return {
    ok: true, mode, scanned: allMemories.length, needBackfill: needBackfill.length, offset,
    nextOffset: offset + batch.length < needBackfill.length ? offset + batch.length : null,
    processed: batch.length, applied, queued, results
  };
}
