import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIVE_OUTBOX_STATUSES,
  AUDIT_NON_TERMINAL_RUN_STATUSES,
  AUDIT_PENDING_CANDIDATE_STATUSES,
  ORIGINAL_DIARY_MEMORY_TYPES,
  assertReadOnlyAuditQueries,
  buildInactiveFiveAxisAuditQueries
} from "../scripts/inactive-five-axis-audit.mjs";
import {
  FIVE_AXIS_OUTBOX_TRANSITIONS,
  FIVE_AXIS_RUN_STATUS
} from "../src/db/fiveAxisStatuses";
import { PENDING_MEMORY_CANDIDATE_STATUSES } from "../src/db/memoryCandidateDependencies";

describe("inactive five-axis audit command", () => {
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
    expect(ORIGINAL_DIARY_MEMORY_TYPES)
      .toEqual(["diary", "layla_diary", "auto_diary"]);
  });

  it("builds SELECT-only queries without private memory fields", () => {
    const queries = buildInactiveFiveAxisAuditQueries({
      namespace: "default",
      staleHours: 24
    });
    expect(() => assertReadOnlyAuditQueries(queries)).not.toThrow();
    expect(queries.map((query) => query.name)).toEqual([
      "relations",
      "relation_provenance",
      "timeline",
      "outbox",
      "axis_runs",
      "candidate_dependencies",
      "operational_candidates",
      "vector_state",
      "deprojection_operations",
      "retention_orphans"
    ]);
    expect(queries.find((query) => query.name === "vector_state")?.driftFields)
      .toEqual(["vector_drift_rows"]);
    expect(queries.find((query) => query.name === "retention_orphans")?.driftFields)
      .toEqual(["actionable_rows"]);
    expect(queries.find((query) => query.name === "operational_candidates")?.driftFields)
      .toEqual(["stale_operational_candidate_rows"]);
    const sql = queries.map((query) => query.sql).join("\n");
    expect(sql).toContain("failed_vector_states");
    expect(sql).toContain("vector_drift_rows");
    expect(sql).toContain("unique_vector_drift_memories");
    expect(sql).toContain("needs_upsert");
    expect(sql).toContain("needs_delete");
    expect(sql).toContain("missing_vector_id_rows");
    expect(sql).toContain("scanner_managed_rows");
    expect(sql).toContain("non_scanner_managed_rows");
    expect(sql).toContain("relation_rows");
    expect(sql).toContain("eligible_unproven_source");
    expect(sql).toContain("stale_unproven_source");
    expect(sql).toContain("origin_diary_provenance_rows");
    expect(sql).toContain("origin.status = 'active'");
    expect(sql).toContain("axis_run_drift_rows");
    expect(sql).toContain("stale_revision_runs");
    expect(sql).toContain("stale_running_active_lease");
    expect(sql).toContain("stale_failed_repairable");
    expect(sql).toContain("stale_running_expired_repairable");
    expect(sql).toContain("future_revision_anomalies");
    expect(sql).toContain("ownership_anomalies");
    expect(sql).toContain("running_missing_claim_token");
    expect(sql).toContain("non_running_lease_residue");
    expect(sql).toContain("stale_operational_candidate_rows");
    expect(sql).toContain("stale_y_relation_review_rows");
    expect(sql).toContain("stale_z_supersede_rows");
    expect(sql).toContain("stale_m_archive_rows");
    expect(sql).toContain("actionable_rows");
    expect(sql).toContain("historical_rows");
    expect(sql).toContain("orphan_relations");
    expect(sql).toContain("distinct_historical_candidates");
    expect(sql).toContain("orphan_metabolism_signal_states");
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i);
    expect(sql).not.toMatch(/\b(?:content|summary|tags|source_message_ids)\b/i);
  });
});
