import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIVE_OUTBOX_STATUSES,
  AUDIT_NON_TERMINAL_RUN_STATUSES,
  AUDIT_PENDING_CANDIDATE_STATUSES,
  assertReadOnlyAuditQueries,
  buildInactiveFiveAxisAuditQueries
} from "../scripts/inactive-five-axis-audit.mjs";
import { parseAuditArgs, usage } from "../scripts/audit-inactive-five-axis.mjs";
import {
  FIVE_AXIS_OUTBOX_TRANSITIONS,
  FIVE_AXIS_RUN_STATUS
} from "../src/db/fiveAxisStatuses";
import { PENDING_MEMORY_CANDIDATE_STATUSES } from "../src/db/memoryCandidateDependencies";

describe("inactive five-axis audit command", () => {
  it("has only an explicit remote read-only mode", () => {
    expect(() => parseAuditArgs([])).toThrow("--remote is required");
    expect(() => parseAuditArgs(["--remote", "--fix"])).toThrow("Unknown argument: --fix");
    expect(() => parseAuditArgs(["--remote", "--apply"])).toThrow("Unknown argument: --apply");
    expect(parseAuditArgs(["--remote", "--namespace", "default", "--json"]))
      .toMatchObject({ remote: true, namespace: "default", json: true });
    expect(usage()).toContain("no fix, delete, repair, or apply mode");
  });

  it("keeps copied audit status sets aligned with the runtime owners", () => {
    expect(AUDIT_ACTIVE_OUTBOX_STATUSES)
      .toEqual([...FIVE_AXIS_OUTBOX_TRANSITIONS.queue.from]);
    expect(AUDIT_NON_TERMINAL_RUN_STATUSES)
      .toEqual([
        FIVE_AXIS_RUN_STATUS.RUNNING,
        FIVE_AXIS_RUN_STATUS.FAILED,
        FIVE_AXIS_RUN_STATUS.PENDING_REVIEW
      ]);
    expect(AUDIT_PENDING_CANDIDATE_STATUSES)
      .toEqual([...PENDING_MEMORY_CANDIDATE_STATUSES]);
  });

  it("builds SELECT-only queries without private memory fields", () => {
    const queries = buildInactiveFiveAxisAuditQueries({
      namespace: "default",
      staleHours: 24
    });
    expect(() => assertReadOnlyAuditQueries(queries)).not.toThrow();
    expect(queries.map((query) => query.name)).toEqual([
      "relations",
      "timeline",
      "outbox",
      "axis_runs",
      "candidate_dependencies",
      "vector_state",
      "deprojection_operations"
    ]);
    const sql = queries.map((query) => query.sql).join("\n");
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i);
    expect(sql).not.toMatch(/\b(?:content|summary|tags|source_message_ids)\b/i);
  });
});
