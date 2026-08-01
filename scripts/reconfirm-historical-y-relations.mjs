#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildHistoricalRelationManifest,
  HISTORICAL_RELATION_SELECTION_VERSION
} from "./historical-relation-governance.mjs";
import {
  canonicalHistoricalYBatch,
  HISTORICAL_Y_RECONFIRMABLE_RELATION_TYPES,
  historicalYBatchIdFromSha256
} from "../src/memory/historicalYReconfirmationContract.js";

const DEFAULT_API_URL = "https://kld.yuxin2247.workers.dev";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 10;
const RECONFIRMABLE_TYPES = new Set(HISTORICAL_Y_RECONFIRMABLE_RELATION_TYPES);

export function usage() {
  return `Usage:
  npm run reconfirm:historical-y -- --remote --manifest <path> [options]

Options:
  --remote              Required. Call the configured remote Worker.
  --manifest <path>     Required. Read-only historical relation audit manifest.
  --offset <n>          Offset within the Y-reconfirmable cohort. Default: 0
  --limit <n>           Relations in this one request. Default: ${DEFAULT_LIMIT}; max: ${MAX_LIMIT}
  --api-url <url>       Worker base URL. Default: KLD_API_URL or ${DEFAULT_API_URL}
  --apply               Apply one bounded batch. Default is LLM dry-run with zero writes.
  --confirm <id>        Required with --apply; exact eligible_unproven manifest_id.
  --json                Emit machine-readable JSON.
  --help                Show this help.

Authentication is read only from KLD_API_KEY. The command never prints or
writes the key. It performs exactly one Worker request and never loops.`;
}

export function parseHistoricalYReconfirmationArgs(argv, environment = process.env) {
  const args = {
    remote: false,
    manifestPath: "",
    offset: 0,
    limit: DEFAULT_LIMIT,
    apiUrl: String(environment.KLD_API_URL || DEFAULT_API_URL).replace(/\/$/, ""),
    apiKey: String(environment.KLD_API_KEY || ""),
    apply: false,
    confirm: "",
    json: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--remote") args.remote = true;
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--manifest") args.manifestPath = String(argv[++index] ?? "").trim();
    else if (arg === "--offset") args.offset = Number(argv[++index]);
    else if (arg === "--limit") args.limit = Number(argv[++index]);
    else if (arg === "--api-url") args.apiUrl = String(argv[++index] ?? "").replace(/\/$/, "");
    else if (arg === "--confirm") args.confirm = String(argv[++index] ?? "").trim();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.help) return args;
  if (!args.remote) throw new Error("--remote is required.");
  if (!args.manifestPath) throw new Error("--manifest requires a value.");
  if (!args.apiUrl) throw new Error("--api-url requires a value.");
  if (!args.apiKey) throw new Error("KLD_API_KEY is required.");
  if (!Number.isInteger(args.offset) || args.offset < 0) {
    throw new Error("--offset must be a non-negative integer.");
  }
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_LIMIT) {
    throw new Error(`--limit must be an integer between 1 and ${MAX_LIMIT}.`);
  }
  if (!args.apply && args.confirm) {
    throw new Error("--confirm is only valid with --apply.");
  }
  return args;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`historical_y_manifest_invalid_${field}`);
  }
  return value;
}

export function loadHistoricalYReconfirmationPlan(manifest, offset, limit) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("historical_y_manifest_invalid");
  }
  const namespace = requireString(manifest.namespace, "namespace");
  const generatedAt = requireString(manifest.generated_at, "generated_at");
  if (!Array.isArray(manifest.summary_rows) || !Array.isArray(manifest.relations)) {
    throw new Error("historical_y_manifest_rows_required");
  }
  const rebuilt = buildHistoricalRelationManifest({
    namespace,
    summaryRows: manifest.summary_rows,
    rows: manifest.relations,
    generatedAt
  });
  if (manifest.relations_sha256 !== rebuilt.relations_sha256) {
    throw new Error("historical_y_manifest_relations_sha256_mismatch");
  }
  if (manifest.selection_sha256 !== rebuilt.selection_sha256) {
    throw new Error("historical_y_manifest_selection_sha256_mismatch");
  }
  if (manifest.selection_predicate_version !== HISTORICAL_RELATION_SELECTION_VERSION) {
    throw new Error("historical_y_manifest_selection_version_mismatch");
  }
  const cohort = rebuilt.cohort_manifests.eligible_unproven;
  if (!cohort) throw new Error("historical_y_manifest_eligible_unproven_missing");
  const candidates = rebuilt.relations.filter((row) =>
    row.lifecycle_cohort === "eligible_unproven"
    && row.provenance_class === "unproven_source"
    && RECONFIRMABLE_TYPES.has(row.relation_type)
  );
  const selected = candidates.slice(offset, offset + limit);
  const relationIds = selected.map((row) => row.id).sort();
  const canonicalBatch = relationIds.length > 0
    ? canonicalHistoricalYBatch(cohort.manifest_id, relationIds)
    : null;
  const relationIdsSha256 = canonicalBatch
    ? createHash("sha256").update(canonicalBatch).digest("hex")
    : null;
  return {
    namespace,
    manifestId: cohort.manifest_id,
    total: candidates.length,
    offset,
    selected: relationIds.length,
    remaining: Math.max(candidates.length - offset - relationIds.length, 0),
    relationIds,
    relationIdsSha256,
    batchId: relationIdsSha256
      ? historicalYBatchIdFromSha256(relationIdsSha256)
      : null
  };
}

export async function runHistoricalYReconfirmationCommand(args, plan, fetchImpl = fetch) {
  if (args.apply && args.confirm !== plan.manifestId) {
    throw new Error(`--apply requires --confirm ${plan.manifestId}`);
  }
  if (plan.selected === 0) {
    return {
      schema_version: 1,
      mode: args.apply ? "apply" : "dry_run",
      manifest_id: plan.manifestId,
      batch_id: null,
      offset: plan.offset,
      selected: 0,
      total: plan.total,
      remaining: plan.remaining,
      complete: plan.offset >= plan.total
    };
  }
  const response = await fetchImpl(`${args.apiUrl}/v1/debug/historical_y_reconfirmation`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      namespace: plan.namespace,
      manifest_id: plan.manifestId,
      relation_ids: plan.relationIds,
      apply: args.apply,
      ...(args.apply ? { confirm: args.confirm } : {})
    })
  });
  const payload = await response.json();
  if (!response.ok) {
    const code = payload && typeof payload === "object" && "error" in payload
      ? String(payload.error)
      : `http_${response.status}`;
    throw new Error(`historical_y_worker_error:${code}`);
  }
  if (!payload || typeof payload !== "object" || !("result" in payload)) {
    throw new Error("historical_y_worker_response_invalid");
  }
  const result = payload.result;
  if (!result || typeof result !== "object" || result.batch_id !== plan.batchId) {
    throw new Error("historical_y_worker_batch_identity_mismatch");
  }
  return {
    ...result,
    offset: plan.offset,
    selected: plan.selected,
    total: plan.total,
    remaining: plan.remaining
  };
}

async function main() {
  const args = parseHistoricalYReconfirmationArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const manifestPath = path.resolve(args.manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const plan = loadHistoricalYReconfirmationPlan(manifest, args.offset, args.limit);
  const report = await runHistoricalYReconfirmationCommand(args, plan);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Historical Y reconfirmation: ${report.mode}`);
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
