export type RelationProvenanceClass =
  | "deterministic_rebuildable"
  | "human_reviewed"
  | "builder_backed"
  | "api_written"
  | "legacy_backfill"
  | "unproven_source";

export const RELATION_PROVENANCE_CLASSES: readonly RelationProvenanceClass[];
export const RELATION_PROVENANCE_PREFIXES: Readonly<
  Record<Exclude<RelationProvenanceClass, "unproven_source">, readonly string[]>
>;

export function relationReasonPrefixPredicate(
  alias: string,
  prefixes: readonly string[]
): string;

export function relationProvenanceSql(alias: string): {
  predicates: Record<RelationProvenanceClass, string>;
  proven: string;
  unproven: string;
  classificationCase: string;
};

export function classifyRelationReason(reason: unknown): RelationProvenanceClass;
