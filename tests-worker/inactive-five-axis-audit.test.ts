import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  assertReadOnlyAuditQueries,
  buildInactiveFiveAxisAuditQueries,
  buildInactiveFiveAxisAuditReport
} from "../scripts/inactive-five-axis-audit.mjs";
import { createMemory } from "../src/db/memories";

async function runAudit(namespace: string) {
  const queries = buildInactiveFiveAxisAuditQueries({ namespace, staleHours: 24 });
  assertReadOnlyAuditQueries(queries);
  const rowsByName: Record<string, Array<Record<string, unknown>>> = {};
  for (const query of queries) {
    const result = await env.DB.prepare(query.sql).all<Record<string, unknown>>();
    rowsByName[query.name] = result.results ?? [];
  }
  return buildInactiveFiveAxisAuditReport({
    namespace,
    queries,
    rowsByName,
    generatedAt: "2026-07-26T00:00:00.000Z"
  });
}

async function tableCounts(namespace: string): Promise<Record<string, number>> {
  const tables = [
    "memories",
    "memory_relations",
    "memory_timeline_memberships",
    "memory_five_axis_outbox",
    "memory_five_axis_runs",
    "memory_candidates",
    "memory_candidate_dependencies",
    "memory_deprojections"
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE namespace = ?`
    ).bind(namespace).first<{ count: number }>();
    counts[table] = row?.count ?? 0;
  }
  return counts;
}

describe("read-only inactive five-axis audit", () => {
  it("executes real D1 queries for every drift class without exposing memory content", async () => {
    const namespace = `inactive-audit-${crypto.randomUUID()}`;
    const privateMarker = `PRIVATE-CONTENT-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const eligible = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: `eligible ${privateMarker}`,
      status: "active"
    });
    const ineligible = await createMemory(env.DB, {
      namespace,
      type: "diary",
      content: `ineligible ${privateMarker}`,
      status: "active"
    });
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE memories
         SET vector_sync_status = 'deleted', vector_synced = 0
         WHERE namespace = ? AND id = ?`
      ).bind(namespace, eligible.id),
      env.DB.prepare(
        `UPDATE memories
         SET vector_sync_status = 'synced', vector_synced = 1
         WHERE namespace = ? AND id = ?`
      ).bind(namespace, ineligible.id),
      env.DB.prepare(
        `INSERT INTO memory_relations (
           id, namespace, source_memory_id, target_memory_id,
           relation_type, strength, reason, created_at
         ) VALUES (?, ?, ?, ?, 'same_topic', 0.9, 'audit fixture', ?)`
      ).bind(`rel_${crypto.randomUUID()}`, namespace, ineligible.id, eligible.id, now),
      env.DB.prepare(
        `INSERT INTO memory_timeline_memberships (
           namespace, memory_id, thread, fact_key, updated_at
         ) VALUES (?, ?, 'audit', 'audit.fact', ?)`
      ).bind(namespace, ineligible.id, now),
      env.DB.prepare(
        `INSERT INTO memory_five_axis_outbox (
           namespace, memory_id, memory_updated_at, memory_revision,
           status, attempts, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`
      ).bind(
        namespace,
        ineligible.id,
        ineligible.updated_at,
        ineligible.five_axis_revision ?? 1,
        now,
        now
      ),
      env.DB.prepare(
        `INSERT INTO memory_five_axis_runs (
           namespace, memory_id, memory_revision, axis, status, attempts,
           result_json, last_error, claim_token, lease_expires_at,
           started_at, completed_at, updated_at
         ) VALUES (?, ?, ?, 'X', 'running', 1, NULL, NULL, 'audit-lease', ?, ?, NULL, ?)`
      ).bind(
        namespace,
        ineligible.id,
        (ineligible.five_axis_revision ?? 1) + 1,
        new Date(Date.now() + 60_000).toISOString(),
        now,
        now
      ),
      env.DB.prepare(
        `INSERT INTO memory_candidates (
           id, namespace, external_key, dream_date, action, subject, target_id,
           payload_json, source_chunk_ids_json, source_chunks_json,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, '2026-07-26', 'update', NULL, ?, '{}', '[]', '[]', 'pending', ?, ?)`
      ).bind(
        `candidate_${crypto.randomUUID()}`,
        namespace,
        `audit-candidate:${crypto.randomUUID()}`,
        ineligible.id,
        now,
        now
      )
    ]);
    const candidate = await env.DB.prepare(
      `SELECT external_key FROM memory_candidates
       WHERE namespace = ? ORDER BY created_at DESC LIMIT 1`
    ).bind(namespace).first<{ external_key: string }>();
    if (!candidate) throw new Error("candidate fixture missing");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO memory_candidate_dependencies (
           namespace, candidate_external_key, memory_id, role
         ) VALUES (?, ?, ?, 'target')`
      ).bind(namespace, candidate.external_key, ineligible.id),
      env.DB.prepare(
        `INSERT INTO memory_deprojections (
           operation_id, namespace, memory_id, source, reason,
           intent_fingerprint, transition,
           previous_status, next_status, previous_type, next_type,
           previous_active_fact, next_active_fact,
           previous_revision, current_revision, created_at
         ) VALUES (
           ?, ?, ?, 'system', 'audit fixture',
           ?, 'eligible_to_ineligible',
           'active', 'deleted', 'note', 'note',
           1, 0, 1, 2, ?
         )`
      ).bind(
        `deproj_${crypto.randomUUID()}`,
        namespace,
        eligible.id,
        "a".repeat(64),
        now
      )
    ]);

    const before = await tableCounts(namespace);
    const report = await runAudit(namespace);
    const after = await tableCounts(namespace);
    expect(after).toEqual(before);
    expect(report.clean).toBe(false);
    expect(report.sections.relations[0]).toMatchObject({
      relations_as_source: 1,
      distinct_memories: 1
    });
    expect(report.sections.timeline[0]).toMatchObject({ membership_rows: 1 });
    expect(report.sections.outbox[0]).toMatchObject({ status: "pending", count: 1 });
    expect(report.sections.axis_runs[0]).toMatchObject({
      ineligible_non_terminal: 1,
      active_leases: 1,
      revision_mismatches: 1
    });
    expect(report.sections.candidate_dependencies[0]).toMatchObject({
      action: "update",
      role: "target",
      count: 1
    });
    expect(report.sections.vector_state[0]).toMatchObject({
      eligible_marked_deleted: 1,
      ineligible_marked_synced: 1,
      ineligible_vector_synced: 1
    });
    expect(report.sections.deprojection_operations[0]).toMatchObject({
      unfinished: 1,
      revision_anomalies: 1
    });
    const output = JSON.stringify(report);
    expect(output).not.toContain(privateMarker);
    expect(output).not.toContain("content");
    expect(output).not.toContain("summary");
  });

  it("reports a clean namespace as clean", async () => {
    const report = await runAudit(`inactive-audit-clean-${crypto.randomUUID()}`);
    expect(report.clean).toBe(true);
    expect(report.drift_count).toBe(0);
  });
});
