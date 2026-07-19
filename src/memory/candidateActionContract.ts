export const CANDIDATE_ACTIONS = [
  "add",
  "excerpt",
  "diary_split_fact",
  "update",
  "delete",
  "fact_group",
  "relation",
  "timeline_date",
  "z_supersede",
  "y_relation_review",
  "m_archive",
  "m_relation_cleanup"
] as const;

export type CandidateAction = typeof CANDIDATE_ACTIONS[number];

export const APPROVABLE_CANDIDATE_ACTIONS = [
  "add",
  "excerpt",
  "diary_split_fact",
  "update",
  "delete",
  "fact_group"
] as const satisfies readonly CandidateAction[];

export type ApprovableCandidateAction = typeof APPROVABLE_CANDIDATE_ACTIONS[number];

export const DREAM_INGRESS_CANDIDATE_ACTIONS = [
  "add",
  "update",
  "delete",
  "excerpt",
  "relation",
  "fact_group"
] as const satisfies readonly CandidateAction[];

export type DreamIngressCandidateAction = typeof DREAM_INGRESS_CANDIDATE_ACTIONS[number];

function includes<T extends string>(values: readonly T[], value: string): value is T {
  return values.some((candidate) => candidate === value);
}

export function isCandidateAction(value: string): value is CandidateAction {
  return includes(CANDIDATE_ACTIONS, value);
}

export function isApprovableCandidateAction(value: string): value is ApprovableCandidateAction {
  return includes(APPROVABLE_CANDIDATE_ACTIONS, value);
}

export function isDreamIngressCandidateAction(value: string): value is DreamIngressCandidateAction {
  return includes(DREAM_INGRESS_CANDIDATE_ACTIONS, value);
}
