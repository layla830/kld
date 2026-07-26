export interface AuditQuery {
  name: string;
  driftFields: string[];
  sql: string;
}

export const AUDIT_ACTIVE_OUTBOX_STATUSES: readonly string[];
export const AUDIT_NON_TERMINAL_RUN_STATUSES: readonly string[];
export const AUDIT_PENDING_CANDIDATE_STATUSES: readonly string[];
export const ORIGINAL_DIARY_MEMORY_TYPES: readonly ["diary", "layla_diary", "auto_diary"];
export function sqlString(value: unknown): string;
export function inactiveMemoryPredicate(alias: string): string;
export function originalDiaryTypePredicate(alias: string): string;
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
