export interface AuditArgs {
  db: string;
  namespace: string;
  staleHours: number;
  remote: boolean;
  json: boolean;
  help: boolean;
}

export function usage(): string;
export function parseAuditArgs(argv: string[]): AuditArgs;
export function runInactiveFiveAxisAudit(
  args: AuditArgs,
  execute?: (
    args: AuditArgs,
    query: { name: string; driftFields: string[]; sql: string }
  ) => Array<Record<string, unknown>>
): {
  schema_version: number;
  mode: "read_only";
  namespace: string;
  generated_at: string;
  clean: boolean;
  drift_count: number;
  sections: Record<string, Array<Record<string, unknown>>>;
};
