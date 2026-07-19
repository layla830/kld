import type { Env } from "../../types";
import { scanOperationalReviewCandidates } from "../operationalReview";
import { observeRecallMetabolismSignals } from "../recallMetabolismShadow";
import { runRelationBuild } from "./yRelations";

export interface FiveAxisNightlyOptions {
  dryRun?: boolean;
  sinceIso?: string;
}

export interface FiveAxisNightlyDependencies {
  runRelations: typeof runRelationBuild;
  scanOperational: typeof scanOperationalReviewCandidates;
  observeRecallMetabolism: typeof observeRecallMetabolismSignals;
}

const defaultDependencies: FiveAxisNightlyDependencies = {
  runRelations: runRelationBuild,
  scanOperational: scanOperationalReviewCandidates,
  observeRecallMetabolism: observeRecallMetabolismSignals
};

export async function runFiveAxisNightlyMaintenance(
  env: Env,
  namespace: string,
  options: FiveAxisNightlyOptions = {},
  dependencies: FiveAxisNightlyDependencies = defaultDependencies
): Promise<{
  relations: Awaited<ReturnType<typeof runRelationBuild>>;
  operationalReview: Awaited<ReturnType<typeof scanOperationalReviewCandidates>>;
  recallMetabolismShadow: Awaited<ReturnType<typeof observeRecallMetabolismSignals>>;
}> {
  const relations = await dependencies.runRelations(env, namespace, {
    dryRun: options.dryRun,
    sinceIso: options.sinceIso
  });
  const [operationalReview, recallMetabolismShadow] = await Promise.all([
    dependencies.scanOperational(env, namespace, { dryRun: options.dryRun }),
    dependencies.observeRecallMetabolism(env, namespace, { dryRun: options.dryRun })
  ]);
  return { relations, operationalReview, recallMetabolismShadow };
}
