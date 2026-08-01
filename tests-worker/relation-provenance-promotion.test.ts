import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createMemory } from "../src/db/memories";
import { createMemoryRelation, prepareMemoryRelationInsert } from "../src/db/memoryRelations";

interface RelationRow {
  id: string;
  strength: number;
  reason: string | null;
  created_at: string;
}

async function createEndpoints(namespace: string) {
  return Promise.all([
    createMemory(env.DB, {
      namespace,
      type: "note",
      content: "Relation provenance source",
      status: "active"
    }),
    createMemory(env.DB, {
      namespace,
      type: "note",
      content: "Relation provenance target",
      status: "active"
    })
  ]);
}

async function readRelation(namespace: string): Promise<RelationRow | null> {
  return env.DB.prepare(
    `SELECT id, strength, reason, created_at
     FROM memory_relations
     WHERE namespace = ? AND relation_type = 'same_topic'`
  ).bind(namespace).first<RelationRow>();
}

describe("memory relation provenance promotion", () => {
  it("promotes an exact unproven edge while preserving its semantic reason and identity", async () => {
    const namespace = `relation-provenance-promote-${crypto.randomUUID()}`;
    const [source, target] = await createEndpoints(namespace);
    const previousReason = "thread/type/tags overlap";

    await expect(createMemoryRelation(env.DB, {
      namespace,
      sourceMemoryId: source.id,
      targetMemoryId: target.id,
      relationType: "same_topic",
      strength: 0.42,
      reason: previousReason
    })).resolves.toBe(true);
    const before = await readRelation(namespace);

    await expect(createMemoryRelation(env.DB, {
      namespace,
      sourceMemoryId: source.id,
      targetMemoryId: target.id,
      relationType: "same_topic",
      strength: 0.99,
      reason: `y:auto:${source.id}:1`
    })).resolves.toBe(true);

    await expect(readRelation(namespace)).resolves.toEqual({
      id: before!.id,
      strength: 0.42,
      reason: `y:auto:${source.id}:1|previous_reason:${previousReason}`,
      created_at: before!.created_at
    });
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM memory_relations WHERE namespace = ?"
    ).bind(namespace).first<{ count: number }>()).resolves.toEqual({ count: 1 });
  });

  it("never overwrites human-reviewed provenance", async () => {
    const namespace = `relation-provenance-reviewed-${crypto.randomUUID()}`;
    const [source, target] = await createEndpoints(namespace);
    const reviewedReason = "y-review:approved:candidate:relation";

    await expect(createMemoryRelation(env.DB, {
      namespace,
      sourceMemoryId: source.id,
      targetMemoryId: target.id,
      relationType: "same_topic",
      strength: 0.8,
      reason: reviewedReason
    })).resolves.toBe(true);
    const before = await readRelation(namespace);

    await expect(createMemoryRelation(env.DB, {
      namespace,
      sourceMemoryId: source.id,
      targetMemoryId: target.id,
      relationType: "same_topic",
      strength: 0.9,
      reason: `y:auto:${source.id}:2`
    })).resolves.toBe(false);
    await expect(readRelation(namespace)).resolves.toEqual(before);
  });

  it("does not let a stale mutation guard promote an existing edge", async () => {
    const namespace = `relation-provenance-guard-${crypto.randomUUID()}`;
    const [source, target] = await createEndpoints(namespace);

    await expect(createMemoryRelation(env.DB, {
      namespace,
      sourceMemoryId: source.id,
      targetMemoryId: target.id,
      relationType: "same_topic",
      reason: "guarded legacy reason"
    })).resolves.toBe(true);
    const before = await readRelation(namespace);
    const statement = prepareMemoryRelationInsert(env.DB, {
      namespace,
      sourceMemoryId: source.id,
      targetMemoryId: target.id,
      relationType: "same_topic",
      reason: `y:auto:${source.id}:999`
    }, {
      sql: "EXISTS (SELECT 1 FROM memories WHERE namespace = ? AND id = ? AND five_axis_revision = ?)",
      binds: [namespace, source.id, 999]
    });

    await expect(statement!.run()).resolves.toMatchObject({ meta: { changes: 0 } });
    await expect(readRelation(namespace)).resolves.toEqual(before);
  });

  it("does not replace one unproven reason with another", async () => {
    const namespace = `relation-provenance-unproven-${crypto.randomUUID()}`;
    const [source, target] = await createEndpoints(namespace);

    await expect(createMemoryRelation(env.DB, {
      namespace,
      sourceMemoryId: source.id,
      targetMemoryId: target.id,
      relationType: "same_topic",
      reason: "original unproven reason"
    })).resolves.toBe(true);
    const before = await readRelation(namespace);

    await expect(createMemoryRelation(env.DB, {
      namespace,
      sourceMemoryId: source.id,
      targetMemoryId: target.id,
      relationType: "same_topic",
      reason: "different unproven reason"
    })).resolves.toBe(false);
    await expect(readRelation(namespace)).resolves.toEqual(before);
  });
});
