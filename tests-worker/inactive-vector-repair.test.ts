import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  buildInactiveFiveAxisAuditQueries,
  buildInactiveFiveAxisAuditReport
} from "../scripts/inactive-five-axis-audit.mjs";
import {
  buildVectorRepairApplyQuery,
  buildVectorRepairDryRunQuery
} from "../scripts/inactive-vector-repair.mjs";
import { createMemory } from "../src/db/memories";

async function memoryFixture(
  namespace: string,
  name: string,
  input: {
    type?: string;
    vectorStatus: string | null;
    vectorSynced: number;
    vectorId?: string | null;
    revision?: number;
  }
) {
  const memory = await createMemory(env.DB, {
    namespace,
    type: input.type ?? "note",
    content: name,
    status: "active"
  });
  await env.DB.prepare(
    `UPDATE memories
     SET vector_sync_status = ?,
         vector_synced = ?,
         vector_id = ?,
         five_axis_revision = ?
     WHERE namespace = ? AND id = ?`
  ).bind(
    input.vectorStatus,
    input.vectorSynced,
    input.vectorId === undefined ? memory.vector_id : input.vectorId,
    input.revision ?? 1,
    namespace,
    memory.id
  ).run();
  return memory;
}

async function queryRows(query: { sql: string }) {
  return env.DB.prepare(query.sql).all<Record<string, unknown>>();
}

async function vectorAudit(namespace: string) {
  const queries = buildInactiveFiveAxisAuditQueries({ namespace, staleHours: 24 });
  const rowsByName: Record<string, Array<Record<string, unknown>>> = {};
  for (const query of queries) {
    const result = await queryRows(query);
    rowsByName[query.name] = result.results ?? [];
  }
  return buildInactiveFiveAxisAuditReport({
    namespace,
    queries,
    rowsByName,
    generatedAt: "2026-07-27T00:00:00.000Z"
  });
}

describe("bounded historical Vector reconciliation requeue", () => {
  it("selects only the two exact cohorts and preserves stable memory fields", async () => {
    const namespace = `vector-repair-${crypto.randomUUID()}`;
    const upsert = await memoryFixture(namespace, "eligible upsert", {
      vectorStatus: "synced",
      vectorSynced: 0,
      revision: 7
    });
    const deleteSynced = await memoryFixture(namespace, "ineligible synced one", {
      type: "diary",
      vectorStatus: "synced",
      vectorSynced: 1
    });
    const deleteUnsynced = await memoryFixture(namespace, "ineligible synced zero", {
      type: "diary",
      vectorStatus: "synced",
      vectorSynced: 0
    });
    const deleteUnset = await memoryFixture(namespace, "ineligible unset", {
      type: "diary",
      vectorStatus: null,
      vectorSynced: 1
    });
    const deleteBlank = await memoryFixture(namespace, "ineligible blank", {
      type: "diary",
      vectorStatus: "   ",
      vectorSynced: 1
    });
    const healthyEligible = await memoryFixture(namespace, "healthy eligible", {
      vectorStatus: "synced",
      vectorSynced: 1
    });
    const healthyIneligible = await memoryFixture(namespace, "healthy ineligible", {
      type: "diary",
      vectorStatus: "deleted",
      vectorSynced: 0
    });
    const pending = await memoryFixture(namespace, "pending scanner row", {
      vectorStatus: "pending",
      vectorSynced: 0
    });
    const failed = await memoryFixture(namespace, "failed scanner row", {
      vectorStatus: "failed",
      vectorSynced: 0
    });
    const missingVector = await memoryFixture(namespace, "missing vector id", {
      vectorStatus: "synced",
      vectorSynced: 0,
      vectorId: null
    });
    const emptyVector = await memoryFixture(namespace, "empty vector id", {
      type: "diary",
      vectorStatus: "synced",
      vectorSynced: 1,
      vectorId: " "
    });

    const dryRun = await queryRows(buildVectorRepairDryRunQuery({ namespace, limit: 100 }));
    expect(dryRun.results?.[0]).toMatchObject({
      repairable_rows: 5,
      needs_upsert_rows: 1,
      needs_delete_rows: 4,
      selected: 5,
      has_more: 0,
      missing_vector_id_rows: 2
    });

    const before = await env.DB.prepare(
      `SELECT id, vector_id, five_axis_revision
       FROM memories WHERE namespace = ?`
    ).bind(namespace).all<Record<string, unknown>>();
    const applied = await queryRows(buildVectorRepairApplyQuery({ namespace, limit: 100 }));
    expect(applied.meta.changes).toBe(5);
    expect(applied.results).toHaveLength(5);

    const after = await env.DB.prepare(
      `SELECT id, vector_id, five_axis_revision, vector_sync_status, vector_synced
       FROM memories WHERE namespace = ?`
    ).bind(namespace).all<Record<string, unknown>>();
    const beforeById = new Map((before.results ?? []).map((row) => [row.id, row]));
    const afterById = new Map((after.results ?? []).map((row) => [row.id, row]));
    for (const memory of [upsert, deleteSynced, deleteUnsynced, deleteUnset, deleteBlank]) {
      expect(afterById.get(memory.id)).toMatchObject({
        vector_sync_status: "pending",
        vector_synced: 0,
        vector_id: beforeById.get(memory.id)?.vector_id,
        five_axis_revision: beforeById.get(memory.id)?.five_axis_revision
      });
    }
    expect(afterById.get(healthyEligible.id)).toMatchObject({
      vector_sync_status: "synced",
      vector_synced: 1
    });
    expect(afterById.get(healthyIneligible.id)).toMatchObject({
      vector_sync_status: "deleted",
      vector_synced: 0
    });
    expect(afterById.get(pending.id)).toMatchObject({ vector_sync_status: "pending" });
    expect(afterById.get(failed.id)).toMatchObject({ vector_sync_status: "failed" });
    expect(afterById.get(missingVector.id)).toMatchObject({ vector_id: null });
    expect(afterById.get(emptyVector.id)).toMatchObject({ vector_id: " " });

    const secondApply = await queryRows(buildVectorRepairApplyQuery({ namespace, limit: 100 }));
    expect(secondApply.meta.changes).toBe(0);
  });

  it("uses current state at apply time and bounds each invocation", async () => {
    const namespace = `vector-repair-guard-${crypto.randomUUID()}`;
    const changedBeforeApply = await memoryFixture(namespace, "race", {
      vectorStatus: "synced",
      vectorSynced: 0
    });
    await Promise.all(Array.from({ length: 4 }, (_, index) => memoryFixture(
      namespace,
      `bounded ${index}`,
      { type: "diary", vectorStatus: "synced", vectorSynced: 1 }
    )));
    const preview = await queryRows(buildVectorRepairDryRunQuery({ namespace, limit: 2 }));
    expect(preview.results?.[0]).toMatchObject({
      repairable_rows: 5,
      selected: 2,
      has_more: 1
    });

    await env.DB.prepare(
      `UPDATE memories
       SET vector_sync_status = 'synced', vector_synced = 1
       WHERE namespace = ? AND id = ?`
    ).bind(namespace, changedBeforeApply.id).run();

    const first = await queryRows(buildVectorRepairApplyQuery({ namespace, limit: 2 }));
    expect(first.meta.changes).toBe(2);
    const afterFirst = await queryRows(buildVectorRepairDryRunQuery({ namespace, limit: 2 }));
    expect(afterFirst.results?.[0]).toMatchObject({
      repairable_rows: 2,
      selected: 2,
      has_more: 0
    });
    const race = await env.DB.prepare(
      `SELECT vector_sync_status, vector_synced
       FROM memories WHERE namespace = ? AND id = ?`
    ).bind(namespace, changedBeforeApply.id).first<Record<string, unknown>>();
    expect(race).toMatchObject({ vector_sync_status: "synced", vector_synced: 1 });
  });

  it("has one unique Vector drift owner while diagnostics may overlap", async () => {
    const namespace = `vector-audit-owner-${crypto.randomUUID()}`;
    await memoryFixture(namespace, "overlapping delete diagnostic", {
      type: "diary",
      vectorStatus: "synced",
      vectorSynced: 1
    });
    await memoryFixture(namespace, "recent pending", {
      vectorStatus: "pending",
      vectorSynced: 0
    });
    await memoryFixture(namespace, "failed", {
      vectorStatus: "failed",
      vectorSynced: 0
    });

    const report = await vectorAudit(namespace);
    expect(report.sections.vector_state[0]).toMatchObject({
      needs_upsert: 0,
      needs_delete: 1,
      unique_vector_drift_memories: 1,
      ineligible_marked_synced: 1,
      ineligible_vector_synced: 1,
      failed_vector_states: 1,
      scanner_managed_rows: 2,
      vector_drift_rows: 2
    });
    expect(report.drift_count).toBe(2);
  });
});
