export interface AuditQuery {
  name: string;
  driftFields: string[];
  sql: string;
}

export const AUDIT_ACTIVE_OUTBOX_STATUSES: readonly string[];
export const AUDIT_NON_TERMINAL_RUN_STATUSES: readonly string[];
export const AUDIT_PENDING_CANDIDATE_STATUSES: readonly string[];
export function inactiveMemoryPredicate(alias: string): string;
export function buildInactiveFiveAxisAuditQueries(input: {
  namespace: string;
  staleHours?: number;
}): AuditQuery[];
export function assertReadOnlyAuditQueries(queries: AuditQuery[]): void;
export function buildInactiveFiveAxisAuditReport(input: {
  namespace: string;
  queries: AuditQuery[];
  rowsByName: Record<string, Array<Record<string, unknown>>>;
  generatedAt?: string;
}): {
  schema_version: number;
  mode: "read_only";
  namespace: string;
  generated_at: string;
  clean: boolean;
  drift_count: number;
  sections: Record<string, Array<Record<string, unknown>>>;
};
