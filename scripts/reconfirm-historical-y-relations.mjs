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
const DEFAULT_LIMIT = 5;
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
  --selection <path>    Approved explicit-ID selection; mutually exclusive with --offset/--limit.
  --api-url <url>       Worker base URL. Default: KLD_API_URL or ${DEFAULT_API_URL}
  --apply               Apply one approved selection. Default is LLM dry-run with zero writes.
  --confirm <id>        Required with --apply; exact eligible_unproven manifest_id.
  --approve-selection <sha256>
                        Required for apply with --selection; exact batch_sha256.
  --json                Emit machine-readable JSON.
  --help                Show this help.

Authentication is read only from KLD_API_KEY. The command never prints or
writes the key. It performs exactly one Worker request and never loops.`;
}

export function parseHistoricalYReconfirmationArgs(argv, environment = process.env) {
  const args = {
    remote: false,
    manifestPath: "",
    selectionPath: "",
    offset: 0,
    limit: DEFAULT_LIMIT,
    offsetProvided: false,
    limitProvided: false,
    apiUrl: String(environment.KLD_API_URL || DEFAULT_API_URL).replace(/\/$/, ""),
    apiKey: String(environment.KLD_API_KEY || ""),
    apply: false,
    confirm: "",
    approveSelection: "",
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
    else if (arg === "--offset") {
      args.offset = Number(argv[++index]);
      args.offsetProvided = true;
    }
    else if (arg === "--limit") {
      args.limit = Number(argv[++index]);
      args.limitProvided = true;
    }
    else if (arg === "--selection") args.selectionPath = String(argv[++index] ?? "").trim();
    else if (arg === "--api-url") args.apiUrl = String(argv[++index] ?? "").replace(/\/$/, "");
    else if (arg === "--confirm") args.confirm = String(argv[++index] ?? "").trim();
    else if (arg === "--approve-selection") {
      args.approveSelection = String(argv[++index] ?? "").trim().toLowerCase();
    }
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
  if (args.selectionPath && (args.offsetProvided || args.limitProvided)) {
    throw new Error("--selection is mutually exclusive with --offset and --limit.");
  }
  if (args.approveSelection && (!args.apply || !args.selectionPath)) {
    throw new Error("--approve-selection is only valid with --apply and --selection.");
  }
  if (args.apply && args.selectionPath && !args.approveSelection) {
    throw new Error("--apply with --selection requires --approve-selection <batch_sha256>.");
  }
  if (args.apply && !args.selectionPath) {
    throw new Error("--apply requires --selection <path> and --approve-selection <batch_sha256>.");
  }
  return args;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`historical_y_manifest_invalid_${field}`);
  }
  return value;
}

function loadHistoricalYCandidateContext(manifest) {
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
  // P3: origin_split is excluded from the candidate set this round; count it
  // separately so the plan report shows how many were skipped by exclusion.
  const skippedOriginSplit = rebuilt.relations.filter((row) =>
    row.lifecycle_cohort === "eligible_unproven"
    && row.provenance_class === "unproven_source"
    && row.relation_type === "origin_split"
  ).length;
  return { namespace, cohort, candidates, skippedOriginSplit };
}

function buildHistoricalYPlan({ namespace, cohort, candidates, skippedOriginSplit }, relationIds, options = {}) {
  const normalizedIds = [...relationIds].sort();
  const canonicalBatch = normalizedIds.length > 0
    ? canonicalHistoricalYBatch(cohort.manifest_id, normalizedIds)
    : null;
  const relationIdsSha256 = canonicalBatch
    ? createHash("sha256").update(canonicalBatch).digest("hex")
    : null;
  return {
    namespace,
    manifestId: cohort.manifest_id,
    total: candidates.length,
    skipped_origin_split: skippedOriginSplit ?? 0,
    offset: options.offset ?? null,
    selected: normalizedIds.length,
    remaining: Math.max(candidates.length - normalizedIds.length - (options.offset ?? 0), 0),
    relationIds: normalizedIds,
    relationIdsSha256,
    batchId: relationIdsSha256
      ? historicalYBatchIdFromSha256(relationIdsSha256)
      : null,
    selection: options.selection === true
  };
}

export function loadHistoricalYReconfirmationPlan(manifest, offset, limit) {
  const context = loadHistoricalYCandidateContext(manifest);
  const { candidates } = context;
  const selected = candidates.slice(offset, offset + limit);
  const relationIds = selected.map((row) => row.id).sort();
  return buildHistoricalYPlan(context, relationIds, { offset });
}

export function loadHistoricalYSelectionPlan(manifest, selection) {
  const context = loadHistoricalYCandidateContext(manifest);
  if (!selection || typeof selection !== "object") {
    throw new Error("historical_y_selection_invalid");
  }
  if (selection.schema_version !== 2) {
    throw new Error("historical_y_selection_schema_version_invalid");
  }
  if (selection.manifest_id !== context.cohort.manifest_id) {
    throw new Error("historical_y_selection_manifest_id_mismatch");
  }
  if (!Array.isArray(selection.relation_ids)
    || selection.relation_ids.length < 1
    || selection.relation_ids.length > MAX_LIMIT) {
    throw new Error(`historical_y_selection_relation_count_must_be_1_to_${MAX_LIMIT}`);
  }
  const relationIds = selection.relation_ids.map((value) => String(value).trim());
  if (relationIds.some((value) => !value) || new Set(relationIds).size !== relationIds.length) {
    throw new Error("historical_y_selection_relation_ids_invalid");
  }
  const candidateIds = new Set(context.candidates.map((row) => row.id));
  if (relationIds.some((id) => !candidateIds.has(id))) {
    throw new Error("historical_y_selection_relation_not_reconfirmable");
  }
  const plan = buildHistoricalYPlan(context, relationIds, { selection: true });
  if (selection.batch_sha256 != null
    && (typeof selection.batch_sha256 !== "string"
      || selection.batch_sha256.toLowerCase() !== plan.relationIdsSha256)) {
    throw new Error("historical_y_selection_batch_sha256_mismatch");
  }
  return plan;
}

export async function runHistoricalYReconfirmationCommand(args, plan, fetchImpl = fetch) {
  if (args.apply && args.confirm !== plan.manifestId) {
    throw new Error(`--apply requires --confirm ${plan.manifestId}`);
  }
  if (args.apply && plan.selection && args.approveSelection !== plan.relationIdsSha256) {
    throw new Error(`--apply with --selection requires --approve-selection ${plan.relationIdsSha256}`);
  }
  if (plan.selected === 0) {
    return {
      schema_version: 2,
      mode: args.apply ? "apply" : "dry_run",
      manifest_id: plan.manifestId,
      batch_id: null,
      batch_sha256: null,
      relation_ids: [],
      offset: plan.offset,
      selected: 0,
      total: plan.total,
      skipped_origin_split: plan.skipped_origin_split,
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
    batch_sha256: plan.relationIdsSha256,
    relation_ids: plan.relationIds,
    offset: plan.offset,
    selected: plan.selected,
    total: plan.total,
    skipped_origin_split: plan.skipped_origin_split,
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
  const plan = args.selectionPath
    ? loadHistoricalYSelectionPlan(
        manifest,
        JSON.parse(fs.readFileSync(path.resolve(args.selectionPath), "utf8"))
      )
    : loadHistoricalYReconfirmationPlan(manifest, args.offset, args.limit);
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
