import type { Env } from "../types";
import { scanFactTransitionReviewCandidates } from "./factTransitionReview";
import { scanMetabolismReviewCandidates } from "./metabolismReview";

export async function scanOperationalReviewCandidates(
  env: Env,
  namespace = "default",
  options: { dryRun?: boolean } = {}
) {
  const [z, m] = await Promise.all([
    scanFactTransitionReviewCandidates(env, namespace, { dryRun: options.dryRun }),
    scanMetabolismReviewCandidates(env, namespace, { dryRun: options.dryRun })
  ]);
  return { z, m };
}
