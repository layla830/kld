#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildHistoricalRelationManifest,
  HISTORICAL_RELATION_SELECTION_VERSION
} from "./historical-relation-governance.mjs";
import {
  buildHistoricalRelationManifestInsertSql,
  buildHistoricalRelationManifestStateQuery,
  buildHistoricalRelationSnapshotBatchSql,
  buildHistoricalRelationSnapshotBatchStatements,
  buildHistoricalRelationSnapshotIdsQuery,
  buildHistoricalRelationSnapshotInsertSql,
  buildHistoricalRelationSnapshotRowsQuery,
  buildHistoricalRelationVerifySql
} from "../src/memory/historicalRelationSnapshotSql.js";
import {
  executeHistoricalRelationQuery,
  executeHistoricalRelationSqlFile,
  resolveHistoricalRelationWranglerInvocation
} from "./historical-relation-d1-runtime.mjs";

export {
  buildHistoricalRelationManifestInsertSql,
  buildHistoricalRelationManifestStateQuery,
  buildHistoricalRelationSnapshotBatchSql,
  buildHistoricalRelationSnapshotBatchStatements,
  buildHistoricalRelationSnapshotIdsQuery,
  buildHistoricalRelationSnapshotInsertSql,
  buildHistoricalRelationSnapshotRowsQuery,
  buildHistoricalRelationVerifySql,
  resolveHistoricalRelationWranglerInvocation
};

const DEFAULT_DB = "companion_memory_proxy";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;
const VALID_COHORTS = new Set(["stale_endpoint", "eligible_unproven"]);

export function usage() {
  return `Usage:
  npm run snapshot:historical-relations -- --remote --manifest <path> --cohort <name> [options]

Options:
  --remote              Required. Target the configured remote D1 database.
  --manifest <path>     Required. Phase-1 read-only manifest JSON.
  --cohort <name>       stale_endpoint or eligible_unproven.
  --db <name>           D1 database name. Default: ${DEFAULT_DB}
  --limit <n>           Maximum snapshot rows in one apply. Default: ${DEFAULT_LIMIT}; max: ${MAX_LIMIT}
  --apply               Write one bounded, idempotent snapshot batch.
  --verify              Verify the complete D1 snapshot and mark it verified.
  --confirm <id>        Required for --apply/--verify; exact cohort manifest_id.
  --json                Emit machine-readable JSON.
  --help                Show this help.

Default mode is read-only. --apply never loops and never updates or deletes
memory_relations. --verify only changes the governance manifest state after
count, relation hash and selection hash all match.`;
}

export function parseHistoricalRelationSnapshotArgs(argv) {
  const args = {
    db: DEFAULT_DB,
    manifestPath: "",
    cohort: "",
    limit: DEFAULT_LIMIT,
    remote: false,
    apply: false,
    verify: false,
    confirm: "",
    json: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--remote") args.remote = true;
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--verify") args.verify = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--db") args.db = String(argv[++index] ?? "").trim();
    else if (arg === "--manifest") args.manifestPath = String(argv[++index] ?? "").trim();
    else if (arg === "--cohort") args.cohort = String(argv[++index] ?? "").trim();
    else if (arg === "--limit") args.limit = Number(argv[++index]);
    else if (arg === "--confirm") args.confirm = String(argv[++index] ?? "").trim();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.help) return args;
  if (!args.remote) throw new Error("--remote is required.");
  if (!args.db) throw new Error("--db requires a value.");
  if (!args.manifestPath) throw new Error("--manifest requires a value.");
  if (!VALID_COHORTS.has(args.cohort)) {
    throw new Error("--cohort must be stale_endpoint or eligible_unproven.");
  }
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_LIMIT) {
    throw new Error(`--limit must be an integer between 1 and ${MAX_LIMIT}.`);
  }
  if (args.apply && args.verify) {
    throw new Error("--apply and --verify are mutually exclusive.");
  }
  if (!args.apply && !args.verify && args.confirm) {
    throw new Error("--confirm is only valid with --apply or --verify.");
  }
  return args;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`historical_relation_snapshot_manifest_invalid_${field}`);
  }
  return value;
}

export function loadHistoricalRelationSnapshotPlan(manifest, cohort) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("historical_relation_snapshot_manifest_invalid");
  }
  const namespace = requireString(manifest.namespace, "namespace");
  const generatedAt = requireString(manifest.generated_at, "generated_at");
  if (!Array.isArray(manifest.summary_rows) || !Array.isArray(manifest.relations)) {
    throw new Error("historical_relation_snapshot_manifest_rows_required");
  }
  const rebuilt = buildHistoricalRelationManifest({
    namespace,
    summaryRows: manifest.summary_rows,
    rows: manifest.relations,
    generatedAt
  });
  for (const field of ["relations_sha256", "selection_sha256"]) {
    if (manifest[field] !== rebuilt[field]) {
      throw new Error(`historical_relation_snapshot_manifest_${field}_mismatch`);
    }
  }
  if (manifest.selection_predicate_version !== HISTORICAL_RELATION_SELECTION_VERSION) {
    throw new Error("historical_relation_snapshot_selection_version_mismatch");
  }
  const cohortManifest = rebuilt.cohort_manifests[cohort];
  if (!cohortManifest) {
    throw new Error(`historical_relation_snapshot_cohort_missing:${cohort}`);
  }
  const rows = rebuilt.relations.filter(
    (row) => row.lifecycle_cohort === cohort
  );
  return {
    descriptor: {
      manifest_id: cohortManifest.manifest_id,
      namespace,
      lifecycle_cohort: cohort,
      selection_predicate_version: rebuilt.selection_predicate_version,
      expected_relation_count: cohortManifest.relation_count,
      expected_relations_sha256: cohortManifest.relations_sha256,
      expected_selection_sha256: cohortManifest.selection_sha256,
      created_at: generatedAt
    },
    rows
  };
}

function assertRemoteManifestState(state, descriptor) {
  if (!state) return;
  const fields = {
    manifest_id: descriptor.manifest_id,
    namespace: descriptor.namespace,
    lifecycle_cohort: descriptor.lifecycle_cohort,
    selection_predicate_version: descriptor.selection_predicate_version,
    expected_relation_count: descriptor.expected_relation_count,
    expected_relations_sha256: descriptor.expected_relations_sha256,
    expected_selection_sha256: descriptor.expected_selection_sha256
  };
  for (const [field, expected] of Object.entries(fields)) {
    if (String(state[field]) !== String(expected)) {
      throw new Error(
        `historical_relation_snapshot_remote_manifest_conflict:${field}`
      );
    }
  }
}

function verifyStoredRows(plan, storedRows) {
  const rebuilt = buildHistoricalRelationManifest({
    namespace: plan.descriptor.namespace,
    summaryRows: [{
      lifecycle_cohort: plan.descriptor.lifecycle_cohort,
      provenance_class: "mixed",
      relation_type: "mixed",
      relation_count: storedRows.length,
      first_created_at: storedRows[0]?.created_at ?? null,
      last_created_at: storedRows.at(-1)?.created_at ?? null
    }],
    rows: storedRows,
    generatedAt: plan.descriptor.created_at
  });
  const cohort = rebuilt.cohort_manifests[plan.descriptor.lifecycle_cohort];
  return {
    verified: storedRows.length === plan.descriptor.expected_relation_count
      && cohort.relations_sha256 === plan.descriptor.expected_relations_sha256
      && cohort.selection_sha256 === plan.descriptor.expected_selection_sha256,
    snapshot_relation_count: storedRows.length,
    relations_sha256: cohort.relations_sha256,
    selection_sha256: cohort.selection_sha256
  };
}

export function runHistoricalRelationSnapshot(
  args,
  plan,
  execute = {
    query: executeHistoricalRelationQuery,
    file: executeHistoricalRelationSqlFile
  }
) {
  if ((args.apply || args.verify) && args.confirm !== plan.descriptor.manifest_id) {
    throw new Error(
      `--${args.apply ? "apply" : "verify"} requires --confirm `
      + plan.descriptor.manifest_id
    );
  }
  const manifestResult = execute.query(
    args,
    buildHistoricalRelationManifestStateQuery(plan.descriptor.manifest_id)
  );
  const remoteState = manifestResult.rows[0] ?? null;
  assertRemoteManifestState(remoteState, plan.descriptor);

  if (args.verify) {
    if (!remoteState) {
      throw new Error("historical_relation_snapshot_remote_manifest_missing");
    }
    const stored = execute.query(
      args,
      buildHistoricalRelationSnapshotRowsQuery(plan.descriptor.manifest_id)
    ).rows;
    const verification = verifyStoredRows(plan, stored);
    if (!verification.verified) {
      return {
        schema_version: 1,
        mode: "verify",
        manifest_id: plan.descriptor.manifest_id,
        lifecycle_cohort: plan.descriptor.lifecycle_cohort,
        remote_status: remoteState.status,
        ...verification,
        changed: 0
      };
    }
    const verifiedAt = new Date().toISOString();
    const applied = execute.query(args, {
      name: "historical_relation_snapshot_verify",
      sql: buildHistoricalRelationVerifySql(plan.descriptor, verifiedAt)
    });
    return {
      schema_version: 1,
      mode: "verify",
      manifest_id: plan.descriptor.manifest_id,
      lifecycle_cohort: plan.descriptor.lifecycle_cohort,
      remote_status: applied.rows.length === 1 ? "verified" : remoteState.status,
      ...verification,
      changed: applied.changes
    };
  }

  const existingIds = new Set(execute.query(
    args,
    buildHistoricalRelationSnapshotIdsQuery(plan.descriptor.manifest_id)
  ).rows.map((row) => String(row.relation_id)));
  const missingRows = plan.rows.filter((row) => !existingIds.has(row.id));
  if (!args.apply) {
    return {
      schema_version: 1,
      mode: "dry_run",
      manifest_id: plan.descriptor.manifest_id,
      lifecycle_cohort: plan.descriptor.lifecycle_cohort,
      expected_relation_count: plan.descriptor.expected_relation_count,
      snapshotted: existingIds.size,
      remaining: missingRows.length,
      selected: Math.min(missingRows.length, args.limit),
      remote_status: remoteState?.status ?? "absent"
    };
  }
  if (remoteState && remoteState.status !== "staging") {
    throw new Error(
      `historical_relation_snapshot_remote_manifest_not_staging:${remoteState.status}`
    );
  }
  const selected = missingRows.slice(0, args.limit);
  if (selected.length === 0) {
    return {
      schema_version: 1,
      mode: "apply",
      manifest_id: plan.descriptor.manifest_id,
      lifecycle_cohort: plan.descriptor.lifecycle_cohort,
      expected_relation_count: plan.descriptor.expected_relation_count,
      selected: 0,
      snapshotted: existingIds.size,
      remaining: 0,
      changed: 0,
      remote_status: remoteState?.status ?? "absent"
    };
  }
  const snapshottedAt = new Date().toISOString();
  const applied = execute.file(
    args,
    buildHistoricalRelationSnapshotBatchSql(
      plan.descriptor,
      selected,
      snapshottedAt
    )
  );
  const after = execute.query(
    args,
    buildHistoricalRelationManifestStateQuery(plan.descriptor.manifest_id)
  ).rows[0] ?? null;
  assertRemoteManifestState(after, plan.descriptor);
  if (!after) {
    throw new Error("historical_relation_snapshot_remote_manifest_missing_after_apply");
  }
  const snapshotted = Number(after.snapshot_relation_count ?? 0);
  return {
    schema_version: 1,
    mode: "apply",
    manifest_id: plan.descriptor.manifest_id,
    lifecycle_cohort: plan.descriptor.lifecycle_cohort,
    expected_relation_count: plan.descriptor.expected_relation_count,
    selected: selected.length,
    snapshotted,
    remaining: Math.max(plan.descriptor.expected_relation_count - snapshotted, 0),
    changed: applied.changes,
    remote_status: after.status
  };
}

async function main() {
  const args = parseHistoricalRelationSnapshotArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const manifestPath = path.resolve(args.manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const plan = loadHistoricalRelationSnapshotPlan(manifest, args.cohort);
  const report = runHistoricalRelationSnapshot(args, plan);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Historical relation snapshot: ${report.mode}`);
    console.log(JSON.stringify(report, null, 2));
  }
}

const entryPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === entryPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
