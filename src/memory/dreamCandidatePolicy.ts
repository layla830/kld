import type { CandidateInput } from "../db/memoryCandidates";

export type DreamCandidatePolicyDecision =
  | { outcome: "accept"; candidate: CandidateInput }
  | { outcome: "suppress"; reason: "standalone_excerpt"; candidate: CandidateInput };

const CHUNK_SUMMARY_ACTIONS = new Set(["add", "update", "delete"]);
const MIN_CHUNK_SUMMARY_LENGTH = 40;

function compact(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function appendValidationError(current: string | null | undefined, error: string): string {
  return [...new Set([...(current ?? "").split(";").map((item) => item.trim()).filter(Boolean), error])].join(";");
}

export function hasUsableChunkSummary(candidate: CandidateInput): boolean {
  return (candidate.sourceChunks ?? []).some((chunk) => compact(chunk.summary).length >= MIN_CHUNK_SUMMARY_LENGTH);
}

/**
 * VPS Dream is a proposal producer, not the owner of durable-memory policy.
 * Standalone quotes stay in source-chunk evidence and are not promoted into
 * one-card-per-sentence memories. Summary-backed facts remain reviewable.
 */
export function applyDreamCandidatePolicy(candidate: CandidateInput): DreamCandidatePolicyDecision {
  if (candidate.action === "excerpt") {
    return { outcome: "suppress", reason: "standalone_excerpt", candidate };
  }

  if (CHUNK_SUMMARY_ACTIONS.has(candidate.action) && !hasUsableChunkSummary(candidate)) {
    return {
      outcome: "accept",
      candidate: {
        ...candidate,
        status: "needs_subject_review",
        validationError: appendValidationError(candidate.validationError, "missing_chunk_summary")
      }
    };
  }

  return { outcome: "accept", candidate };
}
