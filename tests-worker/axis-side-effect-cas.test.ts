import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createMemory, getMemoryById, updateMemory } from "../src/db/memories";
import { runCoordinateBackfill } from "../src/memory/coordinateBackfill";
import { projectMemoryIntoFiveAxes } from "../src/memory/fiveAxis/projection";
import {
  createFiveAxisMemoryRelation,
  runRelationBuild,
  type RelationBuildDependencies
} from "../src/memory/fiveAxis/yRelations";
import type { Env } from "../src/types";

function runtime(): Env {
  return {
    DB: env.DB,
    MEMORY_MODEL: "axis-side-effect-cas-test"
  } as Env;
}

describe("five-axis side-effect revision CAS", () => {
  it("does not let an old E run overwrite coordinates from a newer revision", async () => {
    const namespace = `e-side-effect-cas-${crypto.randomUUID()}`;
    const memory = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "Coordinate source before the concurrent edit",
      status: "active"
    });

    const result = await projectMemoryIntoFiveAxes(runtime(), {
      namespace,
      memoryId: memory.id,
      memoryRevision: memory.five_axis_revision ?? 1,
      projectionKey: `e-side-effect-cas:${memory.id}`
    }, {
      projectCoordinates: (_env, snapshot) => runCoordinateBackfill(runtime(), {
        namespace,
        apply: true,
        ids: [snapshot.id],
        selection: "missing_fields",
        expectedRevision: snapshot.five_axis_revision ?? 1
      }, async (_runtime, _model, memories) => {
        await updateMemory(env.DB, {
          namespace,
          id: snapshot.id,
          patch: { thread: "user.selected.thread" },
          expectedRevision: snapshot.five_axis_revision ?? 1
        });
        return memories.map((item) => ({
          id: item.id,
          thread: "stale.model.thread",
          risk_level: "high",
          urgency_level: "high",
          tension_score: 0.9,
          response_posture: "stale",
          valence: -0.8,
          arousal: 0.9
        }));
      }),
      syncVector: async () => {
        throw new Error("stale E result must not request vector sync");
      },
      projectTimeline: async () => {
        throw new Error("newer revision must stop downstream axes");
      },
      projectRelations: async () => {
        throw new Error("newer revision must stop downstream axes");
      },
      projectFacts: async () => {
        throw new Error("newer revision must stop downstream axes");
      },
      projectMetabolism: async () => {
        throw new Error("newer revision must stop downstream axes");
      }
    });

    expect(result).toMatchObject({
      supersededByRevision: (memory.five_axis_revision ?? 1) + 1,
      axes: { E: { status: "superseded" } },
      e: {
        applied: 0,
        results: [{ id: memory.id, outcome: "revision_changed" }]
      }
    });
    await expect(getMemoryById(env.DB, { namespace, id: memory.id })).resolves.toMatchObject({
      thread: "user.selected.thread",
      risk_level: null,
      urgency_level: null,
      tension_score: null,
      response_posture: null,
      valence: null,
      arousal: null
    });
  });

  it("uses the selected memory revision as the standalone E baseline", async () => {
    const namespace = `e-standalone-cas-${crypto.randomUUID()}`;
    const memory = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "Standalone coordinate source",
      status: "active"
    });

    const result = await runCoordinateBackfill(runtime(), {
      namespace,
      apply: true,
      ids: [memory.id],
      selection: "missing_fields"
    }, async (_runtime, _model, memories) => {
      await updateMemory(env.DB, {
        namespace,
        id: memory.id,
        patch: { thread: "newer.standalone.thread" },
        expectedRevision: memory.five_axis_revision ?? 1
      });
      return memories.map((item) => ({
        id: item.id,
        risk_level: "high",
        urgency_level: "high",
        tension_score: 0.9,
        response_posture: "stale",
        valence: -0.8,
        arousal: 0.9
      }));
    });

    expect(result).toMatchObject({
      applied: 0,
      queued: 0,
      results: [{ id: memory.id, outcome: "revision_changed" }]
    });
    await expect(getMemoryById(env.DB, { namespace, id: memory.id })).resolves.toMatchObject({
      thread: "newer.standalone.thread",
      risk_level: null,
      urgency_level: null,
      tension_score: null,
      response_posture: null,
      valence: null,
      arousal: null
    });
  });

  it("does not let an old Y run insert a safe relation after the source revision advances", async () => {
    const namespace = `y-side-effect-cas-${crypto.randomUUID()}`;
    const [source, target] = await Promise.all([
      createMemory(env.DB, {
        namespace,
        type: "note",
        content: "Old source relation content",
        status: "active"
      }),
      createMemory(env.DB, {
        namespace,
        type: "note",
        content: "Relation target",
        status: "active"
      })
    ]);
    const dependencies: RelationBuildDependencies = {
      findCandidates: async () => [{
        pairId: "safe",
        source,
        target,
        vectorScore: 0.9
      }],
      proposeRelations: async () => {
        await updateMemory(env.DB, {
          namespace,
          id: source.id,
          patch: { content: "New source relation content" },
          expectedRevision: source.five_axis_revision ?? 1
        });
        return {
          hints: [{
            pair_id: "safe",
            relation_type: "same_topic",
            strength: 0.8
          }]
        };
      },
      createRelation: createFiveAxisMemoryRelation,
      queueReviewCandidate: async () => {
        throw new Error("safe relation must not queue review");
      }
    };

    const result = await projectMemoryIntoFiveAxes(runtime(), {
      namespace,
      memoryId: source.id,
      memoryRevision: source.five_axis_revision ?? 1,
      projectionKey: `y-side-effect-cas:${source.id}`
    }, {
      projectCoordinates: async () => ({ skipped: "coordinates_present" }),
      projectTimeline: async () => ({
        scanned: 1,
        outcome: "no_explicit_date",
        dates: [],
        queued: 0
      }),
      projectRelations: (runtimeEnv, relationNamespace, options) => runRelationBuild(
        runtimeEnv,
        relationNamespace,
        options,
        dependencies
      ),
      projectFacts: async () => ({ conflicts: 0, candidates: 0 }),
      projectMetabolism: async () => ({ archive: 0, relations: 0 })
    });

    expect(result).toMatchObject({
      axes: { Y: { status: "superseded" } },
      y: { inserted: 0 }
    });
    expect(result?.y?.insertedRelations ?? []).toEqual([]);
    const relation = await env.DB.prepare(
      `SELECT id FROM memory_relations
       WHERE namespace = ?
         AND (source_memory_id = ? OR target_memory_id = ?)`
    ).bind(namespace, source.id, source.id).first();
    expect(relation).toBeNull();
  });
});
