import { describe, expect, it } from "vitest";
import {
  buildHistoricalRelationManifest
} from "../scripts/historical-relation-governance.mjs";
import {
  buildHistoricalRelationSnapshotBatchSql,
  loadHistoricalRelationSnapshotPlan,
  parseHistoricalRelationSnapshotArgs,
  resolveHistoricalRelationWranglerInvocation,
  runHistoricalRelationSnapshot,
  usage
} from "../scripts/snapshot-historical-relations.mjs";

function staleRelationRow() {
  return {
    id: "rel_snapshot_1",
    namespace: "default",
    source_memory_id: "mem_source",
    target_memory_id: "mem_target",
    relation_type: "same_topic",
    strength: 0.8,
    reason: "free text",
    created_at: "2026-07-01T00:00:00.000Z",
    source_eligible: 0,
    source_status: "active",
    source_active_fact: 1,
    source_type: "diary",
    source_updated_at: "2026-07-01T00:00:00.000Z",
    source_five_axis_revision: 1,
    target_eligible: 1,
    target_status: "active",
    target_active_fact: 1,
    target_type: "note",
    target_updated_at: "2026-07-01T00:00:00.000Z",
    target_five_axis_revision: 1,
    lifecycle_cohort: "stale_endpoint",
    provenance_class: "unproven_source"
  };
}

function snapshotPlan() {
  const manifest = buildHistoricalRelationManifest({
    namespace: "default",
    summaryRows: [{
      lifecycle_cohort: "stale_endpoint",
      provenance_class: "unproven_source",
      relation_type: "same_topic",
      relation_count: 1,
      first_created_at: "2026-07-01T00:00:00.000Z",
      last_created_at: "2026-07-01T00:00:00.000Z"
    }],
    rows: [staleRelationRow()],
    generatedAt: "2026-07-30T00:00:00.000Z"
  });
  return loadHistoricalRelationSnapshotPlan(
    manifest as unknown as Record<string, unknown>,
    "stale_endpoint"
  );
}

describe("historical relation snapshot command", () => {
  it("can pin an exact official Wrangler package for remote execution", () => {
    const invocation = resolveHistoricalRelationWranglerInvocation(
      {
        HISTORICAL_RELATION_WRANGLER_FILE_PACKAGE: "wrangler@4.115.0",
        npm_execpath: "C:\\node\\npm\\bin\\npm-cli.js"
      },
      true
    );
    expect(invocation.command).toMatch(/node(?:\.exe)?$/i);
    expect(invocation.prefixArgs).toEqual([
      "C:\\node\\npm\\bin\\npx-cli.js",
      "--yes",
      "wrangler@4.115.0"
    ]);
    expect(() => resolveHistoricalRelationWranglerInvocation(
      { HISTORICAL_RELATION_WRANGLER_FILE_PACKAGE: "latest" },
      true
    )).toThrow("must be an exact wrangler@x.y.z version");
    expect(resolveHistoricalRelationWranglerInvocation({
      HISTORICAL_RELATION_WRANGLER_FILE_PACKAGE: "latest"
    }).prefixArgs).not.toContain("latest");
  });

  it("requires an explicit remote cohort and keeps apply and verify separate", () => {
    expect(() => parseHistoricalRelationSnapshotArgs([]))
      .toThrow("--remote is required");
    expect(() => parseHistoricalRelationSnapshotArgs([
      "--remote",
      "--manifest",
      ".audit/manifest.json",
      "--cohort",
      "all"
    ])).toThrow("--cohort must be stale_endpoint or eligible_unproven");
    expect(() => parseHistoricalRelationSnapshotArgs([
      "--remote",
      "--manifest",
      ".audit/manifest.json",
      "--cohort",
      "stale_endpoint",
      "--apply",
      "--verify"
    ])).toThrow("--apply and --verify are mutually exclusive");
    expect(usage()).toContain("never loops");
    expect(usage()).toContain("never updates or deletes");
  });

  it("builds a bounded snapshot-only SQL batch with exact live-row guards", () => {
    const plan = snapshotPlan();
    const sql = buildHistoricalRelationSnapshotBatchSql(
      plan.descriptor,
      plan.rows,
      "2026-07-30T01:00:00.000Z"
    );
    expect(sql).toContain("INSERT OR IGNORE INTO historical_relation_manifests");
    expect(sql).toContain("INSERT OR IGNORE INTO historical_relation_snapshots");
    expect(sql).toContain("relation.strength = 0.8");
    expect(sql).toContain("source_memory.five_axis_revision = 1");
    expect(sql).toContain("manifest.status = 'staging'");
    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE)\s+memory_relations\b/i);
    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE)\s+memories\b/i);
  });

  it("does not construct or execute snapshot writes in dry-run mode", () => {
    const plan = snapshotPlan();
    const args = parseHistoricalRelationSnapshotArgs([
      "--remote",
      "--manifest",
      ".audit/manifest.json",
      "--cohort",
      "stale_endpoint"
    ]);
    const queries: string[] = [];
    let fileCalls = 0;
    const report = runHistoricalRelationSnapshot(args, plan, {
      query: (_input, query) => {
        queries.push(query.sql);
        return { rows: [], changes: 0, rowsWritten: 0 };
      },
      file: () => {
        fileCalls += 1;
        return { rows: [], changes: 0, rowsWritten: 0 };
      }
    });
    expect(fileCalls).toBe(0);
    expect(queries).toHaveLength(2);
    expect(queries.every((sql) => /^SELECT\b/.test(sql.trim()))).toBe(true);
    expect(report).toMatchObject({
      mode: "dry_run",
      expected_relation_count: 1,
      selected: 1,
      remote_status: "absent"
    });
  });

  it("treats created_at as audit metadata rather than manifest identity", () => {
    const plan = snapshotPlan();
    const args = parseHistoricalRelationSnapshotArgs([
      "--remote",
      "--manifest",
      ".audit/manifest.json",
      "--cohort",
      "stale_endpoint"
    ]);
    let calls = 0;
    const report = runHistoricalRelationSnapshot(args, plan, {
      query: () => {
        calls += 1;
        if (calls === 1) {
          return {
            rows: [{
              ...plan.descriptor,
              created_at: "2026-07-29T00:00:00.000Z",
              status: "staging"
            }],
            changes: 0,
            rowsWritten: 0
          };
        }
        return { rows: [], changes: 0, rowsWritten: 0 };
      },
      file: () => {
        throw new Error("dry-run must not execute a SQL file");
      }
    });
    expect(report).toMatchObject({
      mode: "dry_run",
      selected: 1,
      remote_status: "staging"
    });
  });

  it("requires the exact manifest id before any apply executor call", () => {
    const plan = snapshotPlan();
    const args = parseHistoricalRelationSnapshotArgs([
      "--remote",
      "--manifest",
      ".audit/manifest.json",
      "--cohort",
      "stale_endpoint",
      "--apply",
      "--confirm",
      "wrong-id"
    ]);
    let calls = 0;
    expect(() => runHistoricalRelationSnapshot(args, plan, {
      query: () => {
        calls += 1;
        return { rows: [], changes: 0, rowsWritten: 0 };
      },
      file: () => {
        calls += 1;
        return { rows: [], changes: 0, rowsWritten: 0 };
      }
    })).toThrow(`--apply requires --confirm ${plan.descriptor.manifest_id}`);
    expect(calls).toBe(0);
  });

  it("marks verified only after the complete stored rows reproduce both hashes", () => {
    const plan = snapshotPlan();
    const args = parseHistoricalRelationSnapshotArgs([
      "--remote",
      "--manifest",
      ".audit/manifest.json",
      "--cohort",
      "stale_endpoint",
      "--verify",
      "--confirm",
      String(plan.descriptor.manifest_id)
    ]);
    const remoteState = {
      ...plan.descriptor,
      status: "staging",
      snapshot_relation_count: 1
    };
    const queries: string[] = [];
    const report = runHistoricalRelationSnapshot(args, plan, {
      query: (_input, query) => {
        queries.push(query.sql);
        if (queries.length === 1) {
          return { rows: [remoteState], changes: 0, rowsWritten: 0 };
        }
        if (queries.length === 2) {
          return { rows: plan.rows, changes: 0, rowsWritten: 0 };
        }
        return {
          rows: [{ manifest_id: plan.descriptor.manifest_id }],
          changes: 1,
          rowsWritten: 1
        };
      },
      file: () => {
        throw new Error("verify must not execute a SQL file");
      }
    });
    expect(queries).toHaveLength(3);
    expect(queries[2]).toContain("SET status = 'verified'");
    expect(report).toMatchObject({
      mode: "verify",
      verified: true,
      snapshot_relation_count: 1,
      remote_status: "verified",
      changed: 1
    });
  });

  it("leaves incomplete readback in staging without executing a verify write", () => {
    const plan = snapshotPlan();
    const args = parseHistoricalRelationSnapshotArgs([
      "--remote",
      "--manifest",
      ".audit/manifest.json",
      "--cohort",
      "stale_endpoint",
      "--verify",
      "--confirm",
      String(plan.descriptor.manifest_id)
    ]);
    let calls = 0;
    const report = runHistoricalRelationSnapshot(args, plan, {
      query: () => {
        calls += 1;
        if (calls === 1) {
          return {
            rows: [{
              ...plan.descriptor,
              status: "staging",
              snapshot_relation_count: 0
            }],
            changes: 0,
            rowsWritten: 0
          };
        }
        return { rows: [], changes: 0, rowsWritten: 0 };
      },
      file: () => {
        throw new Error("verify must not execute a SQL file");
      }
    });
    expect(calls).toBe(2);
    expect(report).toMatchObject({
      mode: "verify",
      verified: false,
      snapshot_relation_count: 0,
      remote_status: "staging",
      changed: 0
    });
  });
});
