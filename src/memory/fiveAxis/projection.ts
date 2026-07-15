import { labelCoordinateBatch } from "../../adapters/llm/coordinateLabeler";
import {
  completeFiveAxisRun,
  failFiveAxisRun,
  getFiveAxisRun,
  startFiveAxisRun,
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
  status: FiveAxisRunStatus;
  reused: boolean;
  error?: string;
}

export interface MemoryFiveAxisProjectionResult {
  memoryId: string;
  memoryRevision: number;
  axes: Record<FiveAxisName, AxisProjectionOutcome>;
  failedAxes: FiveAxisName[];
  x?: TimelineMemoryProjectionResult;
  y?: Awaited<ReturnType<typeof runRelationBuild>>;
  z?: Awaited<ReturnType<typeof scanFactTransitionReviewCandidates>>;
  e?: CoordinateBackfillResult | { skipped: "coordinates_present" };
  m?: Awaited<ReturnType<typeof scanMetabolismReviewCandidates>>;
}

type CoordinateProjectionResult = CoordinateBackfillResult | { skipped: "coordinates_present" };

interface AxisRunStore {
  get(env: Env, key: FiveAxisRunKey): Promise<MemoryFiveAxisRunRecord | null>;
  start(env: Env, key: FiveAxisRunKey): Promise<void>;
  complete(env: Env, key: FiveAxisRunKey, status: AxisTerminalStatus, result: unknown): Promise<void>;
  fail(env: Env, key: FiveAxisRunKey, error: unknown): Promise<void>;
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
  start: (env, key) => startFiveAxisRun(env.DB, key),
  complete: (env, key, status, result) => completeFiveAxisRun(env.DB, key, status, result),
  fail: (env, key, error) => failFiveAxisRun(env.DB, key, error)
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

async function runAxisStage<T>(
  env: Env,
  store: AxisRunStore | undefined,
  key: FiveAxisRunKey,
  statusOf: (result: T) => AxisTerminalStatus,
  run: () => Promise<T>
): Promise<AxisStageResult<T>> {
  const previous = store ? await store.get(env, key) : null;
  if (previous && ["applied", "pending_review", "skipped"].includes(previous.status)) {
    const value = parseStoredResult<T>(previous);
    if (value !== undefined) return { value, outcome: { status: previous.status, reused: true } };
  }

  try {
    if (store) await store.start(env, key);
    const value = await run();
    const status = statusOf(value);
    if (store) await store.complete(env, key, status, value);
    return { value, outcome: { status, reused: false } };
  } catch (error) {
    if (store) await store.fail(env, key, error);
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
    }
  );

  const current = e.outcome.status === "failed"
    ? initial
    : await dependencies.getMemory(env, input.namespace, input.memoryId) ?? initial;

  const x = await runAxisStage(
    env,
    store,
    axisKey(input, memoryRevision, "X"),
    (result) => result.queued > 0 ? "pending_review" : "skipped",
    () => dependencies.projectTimeline(env, current)
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
    }
  );

  const z = await runAxisStage(
    env,
    store,
    axisKey(input, memoryRevision, "Z"),
    (result) => result.candidates > 0 ? "pending_review" : "skipped",
    () => current.fact_key
      ? dependencies.projectFacts(env, input.namespace, { factKeys: [current.fact_key] })
      : Promise.resolve({ conflicts: 0, candidates: 0 })
  );

  const m = await runAxisStage(
    env,
    store,
    axisKey(input, memoryRevision, "M"),
    (result) => result.archive > 0 || result.relations > 0 ? "pending_review" : "skipped",
    () => dependencies.projectMetabolism(env, input.namespace, { memoryIds: [input.memoryId] })
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

  return {
    memoryId: input.memoryId,
    memoryRevision,
    axes,
    failedAxes,
    x: x.value,
    y: y.value,
    z: z.value,
    e: e.value,
    m: m.value
  };
}
