import { describe, expect, it, vi } from "vitest";
import { buildHistoricalRelationManifest } from "../scripts/historical-relation-governance.mjs";
import {
  loadHistoricalYReconfirmationPlan,
  loadHistoricalYSelectionPlan,
  parseHistoricalYReconfirmationArgs,
  runHistoricalYReconfirmationCommand
} from "../scripts/reconfirm-historical-y-relations.mjs";
import {
  canonicalHistoricalYBatch,
  historicalYBatchIdFromSha256
} from "../src/memory/historicalYReconfirmationContract.js";

function relationRow(id: string, relationType: string) {
  return {
    id,
    namespace: "default",
    source_memory_id: `mem_source_${id}`,
    target_memory_id: `mem_target_${id}`,
    relation_type: relationType,
    strength: 0.8,
    reason: "free text",
    created_at: `2026-07-01T00:00:0${id.at(-1)}.000Z`,
    source_eligible: 1,
    source_status: "active",
    source_active_fact: 1,
    source_type: "note",
    source_updated_at: "2026-07-01T00:00:00.000Z",
    source_five_axis_revision: 1,
    target_eligible: 1,
    target_status: "active",
    target_active_fact: 1,
    target_type: "note",
    target_updated_at: "2026-07-01T00:00:00.000Z",
    target_five_axis_revision: 1,
    lifecycle_cohort: "eligible_unproven",
    provenance_class: "unproven_source"
  };
}

function commandManifest() {
  const rows = [
    relationRow("rel_1", "same_topic"),
    relationRow("rel_2", "temporal_sequence"),
    relationRow("rel_3", "contradicts")
  ];
  return buildHistoricalRelationManifest({
    namespace: "default",
    summaryRows: [
      {
        lifecycle_cohort: "eligible_unproven",
        provenance_class: "unproven_source",
        relation_type: "same_topic",
        relation_count: 1
      },
      {
        lifecycle_cohort: "eligible_unproven",
        provenance_class: "unproven_source",
        relation_type: "temporal_sequence",
        relation_count: 1
      },
      {
        lifecycle_cohort: "eligible_unproven",
        provenance_class: "unproven_source",
        relation_type: "contradicts",
        relation_count: 1
      }
    ],
    rows,
    generatedAt: "2026-08-02T00:00:00.000Z"
  });
}

describe("historical Y reconfirmation command", () => {
  it("keeps the remote and credential boundaries explicit", () => {
    expect(() => parseHistoricalYReconfirmationArgs([], { KLD_API_KEY: "key" }))
      .toThrow("--remote is required");
    expect(() => parseHistoricalYReconfirmationArgs([
      "--remote", "--manifest", "manifest.json"
    ], {})).toThrow("KLD_API_KEY is required");
    expect(parseHistoricalYReconfirmationArgs([
      "--remote", "--manifest", "manifest.json", "--limit", "5"
    ], { KLD_API_KEY: "secret" })).toMatchObject({
      remote: true,
      limit: 5,
      apply: false,
      apiKey: "secret"
    });
    expect(parseHistoricalYReconfirmationArgs([
      "--remote", "--manifest", "manifest.json"
    ], { KLD_API_KEY: "secret" }).limit).toBe(5);
  });

  it("selects only eligible unproven Y-owned types from the manifest", () => {
    const manifest = commandManifest();
    const plan = loadHistoricalYReconfirmationPlan(manifest, 0, 10);
    expect(plan.total).toBe(1);
    expect(plan.relationIds).toEqual(["rel_1"]);
    expect(plan.batchId).toMatch(/^hyr_[0-9a-f]{32}$/);
  });

  it("makes one bounded dry-run request and rejects unselected apply", async () => {
    const plan = loadHistoricalYReconfirmationPlan(commandManifest(), 0, 10);
    const args = parseHistoricalYReconfirmationArgs([
      "--remote",
      "--manifest", "manifest.json"
    ], { KLD_API_KEY: "secret", KLD_API_URL: "https://example.test" });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        manifest_id: plan.manifestId,
        relation_ids: ["rel_1"],
        apply: false
      });
      return Response.json({
        ok: true,
        result: {
          mode: "dry_run",
          batch_id: plan.batchId,
          manifest_id: plan.manifestId,
          entries: []
        }
      });
    });
    const report = await runHistoricalYReconfirmationCommand(args, plan, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      batch_id: plan.batchId,
      batch_sha256: plan.relationIdsSha256,
      relation_ids: ["rel_1"],
      selected: 1,
      remaining: 0
    });
    expect(() => parseHistoricalYReconfirmationArgs([
      "--remote", "--manifest", "manifest.json", "--apply",
      "--confirm", plan.manifestId
    ], { KLD_API_KEY: "secret" })).toThrow("--apply requires --selection");
  });

  it("content-addresses sorted relation ids", async () => {
    const canonical = canonicalHistoricalYBatch(
      "hrg_0123456789abcdef0123456789abcdef",
      ["rel_b", "rel_a"]
    );
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical)
    );
    const hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    expect(JSON.parse(canonical).relation_ids).toEqual(["rel_a", "rel_b"]);
    expect(historicalYBatchIdFromSha256(hash)).toBe(`hyr_${hash.slice(0, 32)}`);
  });

  it("validates a manifest-guarded explicit selection and its apply approval", async () => {
    const manifest = commandManifest();
    const sliced = loadHistoricalYReconfirmationPlan(manifest, 0, 10);
    const batchSha256 = sliced.relationIdsSha256!;
    const selection = {
      schema_version: 1,
      manifest_id: sliced.manifestId,
      relation_ids: sliced.relationIds,
      batch_sha256: batchSha256,
      approved_by: "local operator note only"
    };
    const plan = loadHistoricalYSelectionPlan(manifest, selection);
    expect(plan).toMatchObject({
      manifestId: sliced.manifestId,
      relationIds: ["rel_1"],
      relationIdsSha256: batchSha256,
      selection: true
    });
    expect(loadHistoricalYSelectionPlan(manifest, {
      schema_version: 1,
      manifest_id: sliced.manifestId,
      relation_ids: sliced.relationIds
    }).relationIdsSha256).toBe(batchSha256);

    expect(() => parseHistoricalYReconfirmationArgs([
      "--remote", "--manifest", "manifest.json",
      "--selection", "selection.json", "--limit", "1"
    ], { KLD_API_KEY: "secret" })).toThrow(
      "--selection is mutually exclusive with --offset and --limit"
    );
    expect(() => parseHistoricalYReconfirmationArgs([
      "--remote", "--manifest", "manifest.json",
      "--selection", "selection.json", "--apply",
      "--confirm", sliced.manifestId
    ], { KLD_API_KEY: "secret" })).toThrow("requires --approve-selection");

    const args = parseHistoricalYReconfirmationArgs([
      "--remote", "--manifest", "manifest.json",
      "--selection", "selection.json", "--apply",
      "--confirm", sliced.manifestId,
      "--approve-selection", batchSha256
    ], { KLD_API_KEY: "secret", KLD_API_URL: "https://example.test" });
    const fetchImpl = vi.fn(async () => Response.json({
      ok: true,
      result: { batch_id: plan.batchId, mode: "apply", entries: [] }
    }));
    await runHistoricalYReconfirmationCommand(args, plan, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const wrongApproval = { ...args, approveSelection: "0".repeat(64) };
    await expect(runHistoricalYReconfirmationCommand(wrongApproval, plan, fetchImpl))
      .rejects.toThrow(`--approve-selection ${batchSha256}`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a selection hash or relation outside the rebuilt cohort", () => {
    const manifest = commandManifest();
    const sliced = loadHistoricalYReconfirmationPlan(manifest, 0, 10);
    expect(() => loadHistoricalYSelectionPlan(manifest, {
      schema_version: 1,
      manifest_id: sliced.manifestId,
      relation_ids: ["rel_1"],
      batch_sha256: "0".repeat(64)
    })).toThrow("historical_y_selection_batch_sha256_mismatch");
    expect(() => loadHistoricalYSelectionPlan(manifest, {
      schema_version: 1,
      manifest_id: sliced.manifestId,
      relation_ids: ["rel_not_in_manifest"],
      batch_sha256: "0".repeat(64)
    })).toThrow("historical_y_selection_relation_not_reconfirmable");
  });
});
