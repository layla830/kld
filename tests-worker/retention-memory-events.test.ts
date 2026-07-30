import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { deleteOldMemoryEvents } from "../src/db/retention";
import { upsertMemoryCandidate } from "../src/db/memoryCandidates";
import { buildInactiveFiveAxisAuditQueries } from "../scripts/inactive-five-axis-audit.mjs";

interface SnapshotFixture {
  namespace: string;
  candidateId: string;
  before: Record<string, unknown>;
}

async function approvedRelationCleanupFixture(): Promise<SnapshotFixture> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const namespace = `snapshot_retention_${suffix}`;
  const externalKey = `m-review:relation:rel_${suffix}:2026-01-01T00:00:00.000Z`;
  const before = {
    id: `rel_${suffix}`,
    source_memory_id: `source_${suffix}`,
    target_memory_id: `target_${suffix}`,
    relation_type: "same_topic",
    strength: 0.8,
    reason: "snapshot retention test",
    created_at: "2026-01-01T00:00:00.000Z"
  };
  await upsertMemoryCandidate(env.DB, namespace, {
    externalKey,
    dreamDate: "2026-01-01",
    action: "m_relation_cleanup",
    subject: "system",
    payload: { _kind: "metabolism_relation_cleanup", before },
    sourceChunkIds: [],
    status: "pending"
  });
  await env.DB.prepare(
    `UPDATE memory_candidates
     SET status = 'approved'
     WHERE namespace = ? AND external_key = ?`
  ).bind(namespace, externalKey).run();
  const candidate = await env.DB.prepare(
    "SELECT id FROM memory_candidates WHERE namespace = ? AND external_key = ?"
  ).bind(namespace, externalKey).first<{ id: string }>();
  return { namespace, candidateId: candidate!.id, before };
}

async function insertSnapshot(
  fixture: SnapshotFixture,
  id: string,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO memory_events
     (id, namespace, event_type, memory_id, payload_json, created_at)
     VALUES (?, ?, 'm_snapshot', NULL, ?, '2026-01-02T00:00:00.000Z')`
  ).bind(
    id,
    fixture.namespace,
    JSON.stringify({
      candidate_id: fixture.candidateId,
      action: "m_relation_cleanup",
      before: fixture.before,
      relation_was_present: true,
      ...overrides
    })
  ).run();
}

async function eventCount(namespace: string): Promise<number> {
  return await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM memory_events WHERE namespace = ?"
  ).bind(namespace).first<number>("count") ?? 0;
}

describe("memory event retention snapshot ownership", () => {
  it("keeps only an approved relation cleanup's valid rollback snapshot", async () => {
    const fixture = await approvedRelationCleanupFixture();
    await insertSnapshot(fixture, `snapshot_${crypto.randomUUID()}`);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO memory_events
         (id, namespace, event_type, memory_id, payload_json, created_at)
         VALUES (?, ?, 'generic_test', NULL, '{}', '2026-01-02T00:00:00.000Z')`
      ).bind(`generic_${crypto.randomUUID()}`, fixture.namespace),
      env.DB.prepare(
        `INSERT INTO memory_events
         (id, namespace, event_type, memory_id, payload_json, created_at)
         VALUES (?, ?, 'm_snapshot', NULL, ?, '2026-01-02T00:00:00.000Z')`
      ).bind(
        `archive_${crypto.randomUUID()}`,
        fixture.namespace,
        JSON.stringify({
          candidate_id: "archive_candidate",
          action: "m_archive",
          before: { id: "archive_memory" }
        })
      )
    ]);

    await expect(deleteOldMemoryEvents(
      env.DB,
      fixture.namespace,
      "2026-02-01T00:00:00.000Z"
    )).resolves.toBe(2);
    await expect(eventCount(fixture.namespace)).resolves.toBe(1);

    await env.DB.prepare(
      `UPDATE memory_candidates
       SET status = 'rolled_back'
       WHERE namespace = ? AND id = ?`
    ).bind(fixture.namespace, fixture.candidateId).run();
    await expect(deleteOldMemoryEvents(
      env.DB,
      fixture.namespace,
      "2026-02-01T00:00:00.000Z"
    )).resolves.toBe(1);
    await expect(eventCount(fixture.namespace)).resolves.toBe(0);
  });

  it("does not exempt duplicate or malformed snapshots", async () => {
    const duplicate = await approvedRelationCleanupFixture();
    await insertSnapshot(duplicate, `snapshot_${crypto.randomUUID()}`);
    await insertSnapshot(duplicate, `snapshot_${crypto.randomUUID()}`);
    await expect(deleteOldMemoryEvents(
      env.DB,
      duplicate.namespace,
      "2026-02-01T00:00:00.000Z"
    )).resolves.toBe(2);

    const malformed = await approvedRelationCleanupFixture();
    await insertSnapshot(malformed, `snapshot_${crypto.randomUUID()}`, {
      relation_was_present: "true"
    });
    await expect(deleteOldMemoryEvents(
      env.DB,
      malformed.namespace,
      "2026-02-01T00:00:00.000Z"
    )).resolves.toBe(1);
  });

  it("audits missing, duplicate, and malformed approved snapshots without overlap", async () => {
    const missing = await approvedRelationCleanupFixture();
    const duplicate = await approvedRelationCleanupFixture();
    await insertSnapshot(duplicate, `snapshot_${crypto.randomUUID()}`);
    await insertSnapshot(duplicate, `snapshot_${crypto.randomUUID()}`);
    const malformed = await approvedRelationCleanupFixture();
    await insertSnapshot(malformed, `snapshot_${crypto.randomUUID()}`, {
      relation_was_present: "true"
    });

    const namespace = `snapshot_audit_${crypto.randomUUID().replaceAll("-", "")}`;
    for (const fixture of [missing, duplicate, malformed]) {
      await env.DB.prepare(
        "UPDATE memory_candidates SET namespace = ? WHERE namespace = ?"
      ).bind(namespace, fixture.namespace).run();
      await env.DB.prepare(
        "UPDATE memory_events SET namespace = ? WHERE namespace = ?"
      ).bind(namespace, fixture.namespace).run();
    }
    const query = buildInactiveFiveAxisAuditQueries({
      namespace,
      staleHours: 24
    }).find((entry) => entry.name === "m_snapshot_contract")!;
    await expect(env.DB.prepare(query.sql).first()).resolves.toMatchObject({
      missing_snapshot_candidates: 1,
      duplicate_snapshot_candidates: 1,
      malformed_snapshot_candidates: 1
    });
  });
});
