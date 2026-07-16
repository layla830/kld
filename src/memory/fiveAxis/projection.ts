import { labelCoordinateBatch } from "../../adapters/llm/coordinateLabeler";
import {
  completeFiveAxisRun,
  claimFiveAxisRun,
  failFiveAxisRun,
  getFiveAxisRun,
  type FiveAxisName,
  type FiveAxisRunKey,
  type FiveAxisRunStatus,
  type MemoryFiveAxisRunRecord
} from "../../db/memoryFiveAxisRuns";
import { getMemoryById } from "../../db/memories";
import type { Env, MemoryRecord } from "../../types";
import { needsCoordinateBackfill, runCoordinateBackfill, type CoordinateBackfillResult } from "../coordinateBackfill";
import { scanFactTransitionReviewCandidates } from "../factTransitionReview";
import { scanMetabolismReviewCandidates } from "../metabolismReview";
import { syncMemoryVector } from "../state";
import { queueTimelineCandidateForMemory, type TimelineMemoryProjectionResult } from "../timelineBackfill";
import { runRelationBuild } from "./yRelations";

export interface MemoryFiveAxisProjectionInput {
  namespace: string;
  memoryId: string;
  memoryRevision?: number;
  projectionKey: string;
}

type AxisTerminalStatus = Exclude<FiveAxisRunStatus, "running" | "failed">;

export interface AxisProjectionOutcome {
  status: FiveAxisRunStatus | "blocked" | "deferred";
  reused: boolean;
  error?: string;
}

export interface MemoryFiveAxisProjectionResult {
  memoryId: string;
  memoryRevision: number;
  axes: Record<FiveAxisName, AxisProjectionOutcome>;
  failedAxes: FiveAxisName[];
  deferredAxes: FiveAxisName[];
  x?: TimelineMemoryProjectionResult;
  y?: Awaited<ReturnType<typeof runRelationBuild>>;
  z?: Awaited<ReturnType<typeof scanFactTransitionReviewCandidates>>;
  e?: CoordinateBackfillResult | { skipped: "coordinates_present" };
  m?: Awaited<ReturnType<typeof scanMetabolismReviewCandidates>>;
}

type CoordinateProjectionResult = CoordinateBackfillResult | { skipped: "coordinates_present" };

interface AxisRunStore {
  get(env: Env, key: FiveAxisRunKey): Promise<MemoryFiveAxisRunRecord | null>;
  claim(env: Env, key: FiveAxisRunKey): Promise<string | null>;
  complete(
    env: Env,
    key: FiveAxisRunKey,
    claimToken: string,
    status: AxisTerminalStatus,
    result: unknown,
    candidateExternalKeys?: string[]
  ): Promise<boolean>;
  fail(env: Env, key: FiveAxisRunKey, claimToken: string, error: unknown): Promise<boolean>;
}

export interface MemoryFiveAxisProjectionDependencies {
  getMemory: (env: Env, namespace: string, id: string) => Promise<MemoryRecord | null>;
  projectTimeline: typeof queueTimelineCandidateForMemory;
  projectCoordinates: (env: Env, memory: MemoryRecord) => Promise<CoordinateProjectionResult>;
  syncVector: typeof syncMemoryVector;
  projectRelations: typeof runRelationBuild;
  projectFacts: typeof scanFactTransitionReviewCandidates;
  projectMetabolism: typeof scanMetabolismReviewCandidates;
  axisRuns?: AxisRunStore;
}

const defaultAxisRunStore: AxisRunStore = {
  get: (env, key) => getFiveAxisRun(env.DB, key),
  claim: (env, key) => claimFiveAxisRun(env.DB, key),
  complete: (env, key, claimToken, status, result, candidateExternalKeys) => completeFiveAxisRun(
    env.DB,
    key,
    claimToken,
    status,
    result,
    candidateExternalKeys
  ),
  fail: (env, key, claimToken, error) => failFiveAxisRun(env.DB, key, claimToken, error)
};

const defaultDependencies: MemoryFiveAxisProjectionDependencies = {
  getMemory: (env, namespace, id) => getMemoryById(env.DB, { namespace, id }),
  projectTimeline: queueTimelineCandidateForMemory,
  projectCoordinates: async (env, memory) => {
    if (!needsCoordinateBackfill(memory, "missing_fields")) return { skipped: "coordinates_present" };
    return runCoordinateBackfill(env, {
      namespace: memory.namespace,
      apply: true,
      ids: [memory.id],
      selection: "missing_fields",
      limit: 1,
      offset: 0
    }, labelCoordinateBatch);
  },
  syncVector: syncMemoryVector,
  projectRelations: runRelationBuild,
  projectFacts: scanFactTransitionReviewCandidates,
  projectMetabolism: scanMetabolismReviewCandidates,
  axisRuns: defaultAxisRunStore
};

interface AxisStageResult<T> {
  outcome: AxisProjectionOutcome;
  value?: T;
}

function parseStoredResult<T>(record: MemoryFiveAxisRunRecord): T | undefined {
  if (!record.result_json) return undefined;
  try {
    return JSON.parse(record.result_json) as T;
  } catch {
    return undefined;
  }
}

function terminalStoredResult<T>(record: MemoryFiveAxisRunRecord | null): AxisStageResult<T> | null {
  if (!record || !["applied", "pending_review", "skipped"].includes(record.status)) return null;
  const value = parseStoredResult<T>(record);
  return value === undefined
    ? null
    : { value, outcome: { status: record.status, reused: true } };
}

async function runAxisStage<T>(
  env: Env,
  store: AxisRunStore | undefined,
  key: FiveAxisRunKey,
  statusOf: (result: T) => AxisTerminalStatus,
  run: () => Promise<T>,
  candidateExternalKeysOf: (result: T) => string[] = () => []
): Promise<AxisStageResult<T>> {
  const previous = store ? await store.get(env, key) : null;
  const reusable = terminalStoredResult<T>(previous);
  if (reusable) return reusable;

  const claimToken = store ? await store.claim(env, key) : null;
  if (store && !claimToken) {
    const current = terminalStoredResult<T>(await store.get(env, key));
    return current ?? { outcome: { status: "deferred", reused: false } };
  }

  try {
    const value = await run();
    const status = statusOf(value);
    if (store && claimToken) {
      if (!await store.complete(
        env,
        key,
        claimToken,
        status,
        value,
        candidateExternalKeysOf(value)
      )) {
        return { value, outcome: { status: "deferred", reused: false } };
      }
      if (status === "pending_review") {
        const completed = await store.get(env, key);
        if (completed && ["pending_review", "applied", "skipped"].includes(completed.status)) {
          return { value, outcome: { status: completed.status, reused: false } };
        }
      }
    }
    return { value, outcome: { status, reused: false } };
  } catch (error) {
    if (store && claimToken) await store.fail(env, key, claimToken, error);
    return {
      outcome: {
        status: "failed",
        reused: false,
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function axisKey(input: MemoryFiveAxisProjectionInput, memoryRevision: number, axis: FiveAxisName): FiveAxisRunKey {
  return { namespace: input.namespace, memoryId: input.memoryId, memoryRevision, axis };
}

export async function projectMemoryIntoFiveAxes(
  env: Env,
  input: MemoryFiveAxisProjectionInput,
  dependencies: MemoryFiveAxisProjectionDependencies = defaultDependencies
): Promise<MemoryFiveAxisProjectionResult | null> {
  const initial = await dependencies.getMemory(env, input.namespace, input.memoryId);
  if (!initial || initial.status !== "active") return null;
  const memoryRevision = input.memoryRevision ?? initial.five_axis_revision ?? 1;
  const store = dependencies.axisRuns;

  const e = await runAxisStage(
    env,
    store,
    axisKey(input, memoryRevision, "E"),
    (result) => "skipped" in result
      ? "skipped"
      : result.queued > 0 ? "pending_review" : result.applied > 0 ? "applied" : "skipped",
    async () => {
      const result = await dependencies.projectCoordinates(env, initial);
      if (!("skipped" in result) && result.applied > 0) {
        const updated = await dependencies.getMemory(env, input.namespace, input.memoryId) ?? initial;
        await dependencies.syncVector(env, updated);
      }
      return result;
    },
    (result) => "candidateExternalKeys" in result && Array.isArray(result.candidateExternalKeys)
      ? result.candidateExternalKeys
      : []
  );

  const eBlocksX = e.outcome.status === "failed" || e.outcome.status === "deferred";
  const current = eBlocksX
    ? initial
    : await dependencies.getMemory(env, input.namespace, input.memoryId) ?? initial;

  const x: AxisStageResult<TimelineMemoryProjectionResult> = eBlocksX
    ? { outcome: { status: "blocked", reused: false, error: "blocked_by_E" } }
    : await runAxisStage(
        env,
        store,
        axisKey(input, memoryRevision, "X"),
        (result) => result.queued > 0
          ? "pending_review"
          : result.outcome === "reconciled" ? "applied" : "skipped",
        () => dependencies.projectTimeline(env, current),
        (result) => result.candidateExternalKeys ?? []
      );

  const y = await runAxisStage(
    env,
    store,
    axisKey(input, memoryRevision, "Y"),
    (result) => result.review > 0 ? "pending_review" : result.inserted > 0 ? "applied" : "skipped",
    async () => {
      const result = await dependencies.projectRelations(env, input.namespace, {
        dryRun: false,
        memoryIds: [input.memoryId],
        projectionKey: input.projectionKey
      });
      if (result.error) throw new Error(`y_relation_projection_failed:${result.error}`);
      return result;
    },
    (result) => result.candidateExternalKeys ?? []
  );

  const z = await runAxisStage(
    env,
    store,
    axisKey(input, memoryRevision, "Z"),
    (result) => result.candidates > 0 ? "pending_review" : "skipped",
    () => current.fact_key
      ? dependencies.projectFacts(env, input.namespace, { factKeys: [current.fact_key] })
      : Promise.resolve({ conflicts: 0, candidates: 0, candidateExternalKeys: [] }),
    (result) => result.candidateExternalKeys ?? []
  );

  const m = await runAxisStage(
    env,
    store,
    axisKey(input, memoryRevision, "M"),
    (result) => result.archive > 0 || result.relations > 0 ? "pending_review" : "skipped",
    () => dependencies.projectMetabolism(env, input.namespace, { memoryIds: [input.memoryId] }),
    (result) => result.candidateExternalKeys ?? []
  );

  const axes: Record<FiveAxisName, AxisProjectionOutcome> = {
    X: x.outcome,
    Y: y.outcome,
    Z: z.outcome,
    E: e.outcome,
    M: m.outcome
  };
  const failedAxes = (Object.entries(axes) as Array<[FiveAxisName, AxisProjectionOutcome]>)
    .filter(([, outcome]) => outcome.status === "failed")
    .map(([axis]) => axis);
  const deferredAxes = (Object.entries(axes) as Array<[FiveAxisName, AxisProjectionOutcome]>)
    .filter(([, outcome]) => outcome.status === "blocked" || outcome.status === "deferred")
    .map(([axis]) => axis);

  return {
    memoryId: input.memoryId,
    memoryRevision,
    axes,
    failedAxes,
    deferredAxes,
    x: x.value,
    y: y.value,
    z: z.value,
    e: e.value,
    m: m.value
  };
}
