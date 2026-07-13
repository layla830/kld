import { labelCoordinateBatch } from "../../adapters/llm/coordinateLabeler";
import { getMemoryById } from "../../db/memories";
import type { Env, MemoryRecord } from "../../types";
import { runCoordinateBackfill, type CoordinateBackfillResult } from "../coordinateBackfill";
import { scanFactTransitionReviewCandidates } from "../factTransitionReview";
import { scanMetabolismReviewCandidates } from "../metabolismReview";
import { syncMemoryVector } from "../state";
import { queueTimelineCandidateForMemory, type TimelineMemoryProjectionResult } from "../timelineBackfill";
import { runRelationBuild } from "./yRelations";

export interface MemoryFiveAxisProjectionInput {
  namespace: string;
  memoryId: string;
  projectionKey: string;
}

export interface MemoryFiveAxisProjectionResult {
  memoryId: string;
  x: TimelineMemoryProjectionResult;
  y: Awaited<ReturnType<typeof runRelationBuild>>;
  z: Awaited<ReturnType<typeof scanFactTransitionReviewCandidates>>;
  e: CoordinateBackfillResult | { skipped: "coordinates_present" };
  m: Awaited<ReturnType<typeof scanMetabolismReviewCandidates>>;
}

export interface MemoryFiveAxisProjectionDependencies {
  getMemory: (env: Env, namespace: string, id: string) => Promise<MemoryRecord | null>;
  projectTimeline: typeof queueTimelineCandidateForMemory;
  projectCoordinates: (env: Env, memory: MemoryRecord) => Promise<MemoryFiveAxisProjectionResult["e"]>;
  syncVector: typeof syncMemoryVector;
  projectRelations: typeof runRelationBuild;
  projectFacts: typeof scanFactTransitionReviewCandidates;
  projectMetabolism: typeof scanMetabolismReviewCandidates;
}

function needsCoordinateProjection(memory: MemoryRecord): boolean {
  return !memory.fact_key && !memory.thread && memory.risk_level === null && memory.valence === null;
}

const defaultDependencies: MemoryFiveAxisProjectionDependencies = {
  getMemory: (env, namespace, id) => getMemoryById(env.DB, { namespace, id }),
  projectTimeline: queueTimelineCandidateForMemory,
  projectCoordinates: async (env, memory) => {
    if (!needsCoordinateProjection(memory)) return { skipped: "coordinates_present" };
    return runCoordinateBackfill(env, {
      namespace: memory.namespace,
      apply: true,
      ids: [memory.id],
      limit: 1,
      offset: 0
    }, labelCoordinateBatch);
  },
  syncVector: syncMemoryVector,
  projectRelations: runRelationBuild,
  projectFacts: scanFactTransitionReviewCandidates,
  projectMetabolism: scanMetabolismReviewCandidates
};

export async function projectMemoryIntoFiveAxes(
  env: Env,
  input: MemoryFiveAxisProjectionInput,
  dependencies: MemoryFiveAxisProjectionDependencies = defaultDependencies
): Promise<MemoryFiveAxisProjectionResult | null> {
  const initial = await dependencies.getMemory(env, input.namespace, input.memoryId);
  if (!initial || initial.status !== "active") return null;

  const x = await dependencies.projectTimeline(env, initial);
  const e = await dependencies.projectCoordinates(env, initial);
  let current = await dependencies.getMemory(env, input.namespace, input.memoryId) ?? initial;
  if (!("skipped" in e) && e.applied > 0) {
    await dependencies.syncVector(env, current);
    current = await dependencies.getMemory(env, input.namespace, input.memoryId) ?? current;
  }

  const y = await dependencies.projectRelations(env, input.namespace, {
    dryRun: false,
    memoryIds: [input.memoryId],
    projectionKey: input.projectionKey
  });
  if (y.error) throw new Error(`y_relation_projection_failed:${y.error}`);
  const z = current.fact_key
    ? await dependencies.projectFacts(env, input.namespace, { factKeys: [current.fact_key] })
    : { conflicts: 0, candidates: 0 };
  const m = await dependencies.projectMetabolism(env, input.namespace, { memoryIds: [input.memoryId] });

  return { memoryId: input.memoryId, x, y, z, e, m };
}
