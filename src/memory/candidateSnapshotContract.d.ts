export const SUPERSEDED_CANDIDATE_SNAPSHOT_REASON:
  "superseded_by_newer_candidate_snapshot";

export function staleOperationalCandidateForMemoryPredicate(
  candidateAlias: string,
  memoryIdExpression?: string
): string;

export function staleOperationalCandidateAuditPredicate(
  candidateAlias: string
): string;
