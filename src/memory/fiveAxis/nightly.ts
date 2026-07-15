import type { Env } from "../../types";
import { scanOperationalReviewCandidates } from "../operationalReview";
import { runRelationBuild } from "./yRelations";

export interface FiveAxisNightlyOptions {
  dryRun?: boolean;
  sinceIso?: string;
}

export interface FiveAxisNightlyDependencies {
  runRelations: typeof runRelationBuild;
  scanOperational: typeof scanOperationalReviewCandidates;
}

const defaultDependencies: FiveAxisNightlyDependencies = {
  runRelations: runRelationBuild,
  scanOperational: scanOperationalReviewCandidates
};

export async function runFiveAxisNightlyMaintenance(
  env: Env,
  namespace: string,
  options: FiveAxisNightlyOptions = {},
  dependencies: FiveAxisNightlyDependencies = defaultDependencies
): Promise<{
  relations: Awaited<ReturnType<typeof runRelationBuild>>;
  operationalReview: Awaited<ReturnType<typeof scanOperationalReviewCandidates>>;
}> {
  const relations = await dependencies.runRelations(env, namespace, {
    dryRun: options.dryRun,
    sinceIso: options.sinceIso
  });
  const operationalReview = await dependencies.scanOperational(env, namespace, {
    dryRun: options.dryRun
  });
  return { relations, operationalReview };
}
