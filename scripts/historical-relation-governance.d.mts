export type HistoricalRelationLifecycleCohort =
  | "stale_endpoint"
  | "eligible_unproven"
  | "eligible_proven";

export interface HistoricalRelationQuery {
  name: string;
  sql: string;
}

export const HISTORICAL_RELATION_LIFECYCLE_COHORTS:
  readonly HistoricalRelationLifecycleCohort[];
export const HISTORICAL_RELATION_DEBT_COHORTS:
  readonly ["stale_endpoint", "eligible_unproven"];
export const HISTORICAL_RELATION_SELECTION_VERSION: string;

export function buildHistoricalRelationSummaryQuery(input: {
  namespace: string;
}): HistoricalRelationQuery;

export function buildHistoricalRelationPageQuery(input: {
  namespace: string;
  pageSize?: number;
  afterCreatedAt?: string | null;
  afterId?: string | null;
}): HistoricalRelationQuery;

export function assertReadOnlyHistoricalRelationQueries(
  queries: HistoricalRelationQuery[]
): void;

export function canonicalHistoricalRelationIdentity(
  row: Record<string, unknown>
): string;
export function canonicalHistoricalRelationSelection(
  row: Record<string, unknown>
): string;

export function buildHistoricalRelationManifest(input: {
  namespace: string;
  summaryRows: Array<Record<string, unknown>>;
  rows: Array<Record<string, unknown>>;
  generatedAt?: string;
}): {
  schema_version: 1;
  mode: "read_only";
  namespace: string;
  generated_at: string;
  selection_predicate_version: string;
  relation_count: number;
  counts_by_cohort: Record<string, number>;
  relations_sha256: string;
  selection_sha256: string;
  cohort_manifests: Record<string, {
    manifest_id: string;
    relation_count: number;
    relations_sha256: string;
    selection_sha256: string;
  }>;
  summary_rows: Array<Record<string, unknown>>;
  relations: Array<Record<string, unknown>>;
};
