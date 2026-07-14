import type { MemoryCandidateRecord } from "../db/memoryCandidates";

const VALIDATION_OVERRIDE_ACTIONS = new Set(["add", "excerpt", "update", "delete"]);

export function canOverrideCandidateValidation(
  candidate: Pick<MemoryCandidateRecord, "status" | "action">
): boolean {
  return candidate.status === "needs_subject_review" && VALIDATION_OVERRIDE_ACTIONS.has(candidate.action);
}
