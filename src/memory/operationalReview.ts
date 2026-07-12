import type { Env } from "../types";
import { scanFactTransitionReviewCandidates } from "./factTransitionReview";
import { scanMetabolismReviewCandidates } from "./metabolismReview";

export async function scanOperationalReviewCandidates(env: Env, namespace = "default") {
  const [z, m] = await Promise.all([
    scanFactTransitionReviewCandidates(env, namespace),
    scanMetabolismReviewCandidates(env, namespace)
  ]);
  return { z, m };
}
