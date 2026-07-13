import type { Env } from "../../types";
import { runMetabolismPatrol } from "./mMetabolism";
import { runRelationBuild } from "./yRelations";
import { runZAudit } from "./zFacts";

export interface FiveAxisNightlyOptions {
  dryRun?: boolean;
  sinceIso?: string;
}

export interface FiveAxisNightlyDependencies {
  runRelations: typeof runRelationBuild;
  runFactAudit: typeof runZAudit;
  runMetabolism: typeof runMetabolismPatrol;
}

const defaultDependencies: FiveAxisNightlyDependencies = {
  runRelations: runRelationBuild,
  runFactAudit: runZAudit,
  runMetabolism: runMetabolismPatrol
};

export async function runFiveAxisNightlyMaintenance(
  env: Env,
  namespace: string,
  options: FiveAxisNightlyOptions = {},
  dependencies: FiveAxisNightlyDependencies = defaultDependencies
): Promise<{
  zAudit: Awaited<ReturnType<typeof runZAudit>>;
  patrol: Awaited<ReturnType<typeof runMetabolismPatrol>>;
  relations: Awaited<ReturnType<typeof runRelationBuild>>;
}> {
  const relations = await dependencies.runRelations(env, namespace, {
    dryRun: options.dryRun,
    sinceIso: options.sinceIso
  });
  const zAudit = await dependencies.runFactAudit(env, namespace, { dryRun: options.dryRun });
  const patrol = await dependencies.runMetabolism(env, namespace, { dryRun: options.dryRun });
  return { zAudit, patrol, relations };
}
