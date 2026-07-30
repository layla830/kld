import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  approveMetabolismCandidate,
  rollbackMetabolismCandidate
} from "../src/api/adminBoard/metabolismActions";
import { upsertMemoryCandidate } from "../src/db/memoryCandidates";
import { createMemory } from "../src/db/memories";
import { scanMetabolismReviewCandidates } from "../src/memory/metabolismReview";
import type { Env } from "../src/types";

interface RelationFixture {
  namespace: string;
  memoryId: string;
  relationId: string;
  createdAt: string;
}

async function createSelfLoopRelation(
  createdAt = "2026-07-30T01:00:00.000Z",
  namespaceOverride?: string
): Promise<RelationFixture> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const namespace = namespaceOverride ?? `relation-incarnation-${suffix}`;
  const memory = await createMemory(env.DB, {
    namespace,
    type: "note",
    content: `relation incarnation ${suffix}`,
    status: "active",
    source: "worker-test"
  });
  const relationId = `rel_incarnation_${suffix}`;
  await env.DB.prepare(
    `INSERT INTO memory_relations (
       id, namespace, source_memory_id, target_memory_id,
       relation_type, strength, reason, created_at
     ) VALUES (?, ?, ?, ?, 'same_topic', 0.8, 'worker test', ?)`
  ).bind(relationId, namespace, memory.id, memory.id, createdAt).run();
  return { namespace, memoryId: memory.id, relationId, createdAt };
}

async function relationSnapshot(fixture: RelationFixture): Promise<Record<string, unknown>> {
  const relation = await env.DB.prepare(
    "SELECT * FROM memory_relations WHERE namespace = ? AND id = ?"
  ).bind(fixture.namespace, fixture.relationId).first<Record<string, unknown>>();
  if (!relation) throw new Error("relation fixture missing");
  return relation;
}

async function seedCandidate(
  fixture: RelationFixture,
  externalKey: string,
  status: "pending" | "rejected" | "rolled_back"
): Promise<string> {
  await upsertMemoryCandidate(env.DB, fixture.namespace, {
    externalKey,
    dreamDate: "2026-07-30",
    action: "m_relation_cleanup",
    subject: "system",
    payload: {
      _kind: "metabolism_relation_cleanup",
      reason: "worker test",
      before: await relationSnapshot(fixture)
    },
    sourceChunkIds: [],
    status: "pending"
  });
  if (status !== "pending") {
    await env.DB.prepare(
      `UPDATE memory_candidates
       SET status = ?, updated_at = ?
       WHERE namespace = ? AND external_key = ?`
    ).bind(status, "2026-07-30T01:01:00.000Z", fixture.namespace, externalKey).run();
  }
  const candidate = await env.DB.prepare(
    "SELECT id FROM memory_candidates WHERE namespace = ? AND external_key = ?"
  ).bind(fixture.namespace, externalKey).first<{ id: string }>();
  if (!candidate) throw new Error("candidate fixture missing");
  return candidate.id;
}

async function scan(fixture: RelationFixture, dryRun: boolean) {
  return scanMetabolismReviewCandidates(
    { DB: env.DB },
    fixture.namespace,
    { memoryIds: [fixture.memoryId], dryRun }
  );
}

describe("M relation cleanup incarnation ownership", () => {
  it("suppresses a terminal candidate for the same incarnation in dry-run and apply", async () => {
    const fixture = await createSelfLoopRelation();
    const key = `m-review:relation:${fixture.relationId}:${fixture.createdAt}`;
    await seedCandidate(fixture, key, "rejected");

    await expect(scan(fixture, true)).resolves.toMatchObject({ relations: 0 });
    await expect(scan(fixture, false)).resolves.toMatchObject({ relations: 0 });
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count FROM memory_candidates
       WHERE namespace = ? AND action = 'm_relation_cleanup'`
    ).bind(fixture.namespace).first<{ count: number }>())
      .resolves.toMatchObject({ count: 1 });
  });

  it("suppresses an exact legacy candidate regardless of pending or terminal status", async () => {
    for (const status of ["pending", "rolled_back"] as const) {
      const fixture = await createSelfLoopRelation(
        status === "pending"
          ? "2026-07-30T02:00:00.000Z"
          : "2026-07-30T03:00:00.000Z"
      );
      await seedCandidate(
        fixture,
        `m-review:relation:${fixture.relationId}`,
        status
      );

      await expect(scan(fixture, true)).resolves.toMatchObject({ relations: 0 });
      await expect(scan(fixture, false)).resolves.toMatchObject({ relations: 0 });
    }
  });

  it("queues a reinserted relation as a new incarnation exactly once", async () => {
    const fixture = await createSelfLoopRelation("2026-07-30T04:00:00.000Z");
    const legacyKey = `m-review:relation:${fixture.relationId}`;
    await seedCandidate(fixture, legacyKey, "rejected");

    await env.DB.prepare(
      "DELETE FROM memory_relations WHERE namespace = ? AND id = ?"
    ).bind(fixture.namespace, fixture.relationId).run();
    const nextCreatedAt = "2026-07-30T04:30:00.000Z";
    await env.DB.prepare(
      `INSERT INTO memory_relations (
         id, namespace, source_memory_id, target_memory_id,
         relation_type, strength, reason, created_at
       ) VALUES (?, ?, ?, ?, 'same_topic', 0.8, 'worker test reinsert', ?)`
    ).bind(
      fixture.relationId,
      fixture.namespace,
      fixture.memoryId,
      fixture.memoryId,
      nextCreatedAt
    ).run();
    const nextFixture = { ...fixture, createdAt: nextCreatedAt };
    const nextKey = `m-review:relation:${fixture.relationId}:${nextCreatedAt}`;

    await expect(scan(nextFixture, true)).resolves.toMatchObject({ relations: 1 });
    const queued = await scan(nextFixture, false);
    expect(queued).toMatchObject({
      relations: 1,
      candidateExternalKeys: [nextKey]
    });
    await expect(scan(nextFixture, false)).resolves.toMatchObject({ relations: 0 });
    await expect(env.DB.prepare(
      `SELECT external_key, status FROM memory_candidates
       WHERE namespace = ? AND action = 'm_relation_cleanup'
       ORDER BY external_key`
    ).bind(fixture.namespace).all<{ external_key: string; status: string }>())
      .resolves.toMatchObject({
        results: expect.arrayContaining([
          { external_key: legacyKey, status: "rejected" },
          { external_key: nextKey, status: "pending" }
        ])
      });
  });

  it("keeps a rolled-back new-key incarnation suppressed after restoring the relation", async () => {
    const fixture = await createSelfLoopRelation(
      "2026-07-30T05:00:00.000Z",
      "default"
    );
    const key = `m-review:relation:${fixture.relationId}:${fixture.createdAt}`;
    const candidateId = await seedCandidate(fixture, key, "pending");
    const form = new FormData();
    form.set("id", candidateId);

    await expect(approveMetabolismCandidate(
      { DB: env.DB } as Env,
      form
    )).resolves.toMatchObject({ action: "m_relation_cleanup" });
    await expect(rollbackMetabolismCandidate(
      { DB: env.DB } as Env,
      form
    )).resolves.toMatchObject({ action: "rollback" });
    await expect(env.DB.prepare(
      "SELECT created_at FROM memory_relations WHERE namespace = ? AND id = ?"
    ).bind(fixture.namespace, fixture.relationId).first<{ created_at: string }>())
      .resolves.toEqual({ created_at: fixture.createdAt });
    await expect(env.DB.prepare(
      "SELECT status FROM memory_candidates WHERE namespace = ? AND id = ?"
    ).bind(fixture.namespace, candidateId).first<{ status: string }>())
      .resolves.toEqual({ status: "rolled_back" });
    await expect(scan(fixture, true)).resolves.toMatchObject({ relations: 0 });
    await expect(scan(fixture, false)).resolves.toMatchObject({ relations: 0 });
  });
});
