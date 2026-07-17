import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  approveRelationReviewCandidate,
  rejectRelationReviewCandidate,
  rollbackRelationReviewCandidate
} from "../src/api/adminBoard/relationReviewActions";
import { createMemoryRelation, listRelationExpandedMemories } from "../src/db/memoryRelations";
import { createMemory } from "../src/db/memories";
import { queueRelationReviewCandidate } from "../src/memory/relationReview";
import { projectMemoryIntoFiveAxes } from "../src/memory/fiveAxis/projection";
import {
  runRelationBuild,
  type RelationBuildDependencies,
  type RelationCandidate,
  type RelationHint
} from "../src/memory/fiveAxis/yRelations";

interface CandidateRow {
  id: string;
  status: string;
  payload_json: string;
}

function formFor(id: string): FormData {
  const form = new FormData();
  form.set("id", id);
  return form;
}

function relationType(candidate: CandidateRow): string | null {
  const payload = JSON.parse(candidate.payload_json) as { relation_type?: unknown };
  return typeof payload.relation_type === "string" ? payload.relation_type : null;
}

function createYMemory(content: string) {
  return createMemory(env.DB, {
    namespace: "default",
    type: "project_state",
    content,
    thread: "y-runtime",
    riskLevel: "low",
    urgencyLevel: "normal",
    tensionScore: 0.2,
    responsePosture: "supportive",
    valence: 0.2,
    arousal: 0.3,
    importance: 0.8
  });
}

describe("Y-axis Worker circuit", () => {
  it("persists safe edges immediately and gates reviewed edges through approve, reject, rollback, and two-hop recall", async () => {
    const [a, b, c, d] = await Promise.all([
      createYMemory("Y runtime A"),
      createYMemory("Y runtime B"),
      createYMemory("Y runtime C"),
      createYMemory("Y runtime D")
    ]);
    const candidates: RelationCandidate[] = [
      { pairId: "safe", source: a, target: b, vectorScore: 0.93 },
      { pairId: "approve", source: b, target: c, vectorScore: 0.91 },
      { pairId: "reject", source: a, target: d, vectorScore: 0.89 }
    ];
    const hints: RelationHint[] = [
      { pair_id: "safe", relation_type: "same_topic", strength: 0.9, reason: "safe runtime edge" },
      { pair_id: "approve", relation_type: "supports", strength: 0.9, reason: "reviewed runtime edge" },
      { pair_id: "reject", relation_type: "cause_effect", strength: 0.9, reason: "rejected runtime edge" }
    ];
    const dependencies = {
      findCandidates: async () => candidates,
      proposeRelations: async () => ({ hints }),
      createRelation: createMemoryRelation,
      queueReviewCandidate: queueRelationReviewCandidate
    } satisfies RelationBuildDependencies;

    await expect(projectMemoryIntoFiveAxes(env, {
      namespace: "default",
      memoryId: a.id,
      memoryRevision: 1,
      projectionKey: "runtime-y"
    }, {
      projectRelations: (runtimeEnv, namespace, options) => runRelationBuild(
        runtimeEnv,
        namespace,
        options,
        dependencies
      )
    })).resolves.toMatchObject({
      axes: { Y: { status: "pending_review" } },
      y: { inserted: 1, review: 2, proposed: 0, candidates: 3 }
    });

    const pending = await env.DB.prepare(
      `SELECT id, status, payload_json FROM memory_candidates
       WHERE namespace = 'default' AND action = 'y_relation_review' AND status = 'pending'`
    ).all<CandidateRow>();
    expect(pending.results).toHaveLength(2);
    const approveCandidate = pending.results.find((candidate) => relationType(candidate) === "supports");
    const rejectCandidate = pending.results.find((candidate) => relationType(candidate) === "cause_effect");
    expect(approveCandidate).toBeTruthy();
    expect(rejectCandidate).toBeTruthy();

    const beforeApproval = await listRelationExpandedMemories(env.DB, {
      namespace: "default",
      baseIds: [a.id],
      limit: 10
    });
    expect(beforeApproval.map((memory) => memory.id)).toContain(b.id);
    expect(beforeApproval.map((memory) => memory.id)).not.toContain(c.id);
    expect(beforeApproval.map((memory) => memory.id)).not.toContain(d.id);

    await expect(approveRelationReviewCandidate(env, formFor(approveCandidate!.id)))
      .resolves.toMatchObject({ axis: "Y", action: "approve", changed: true });
    await expect(rejectRelationReviewCandidate(env, formFor(rejectCandidate!.id))).resolves.toBe(true);
    await expect(env.DB.prepare(
      `SELECT status FROM memory_five_axis_runs
       WHERE namespace = 'default' AND memory_id = ? AND memory_revision = 1 AND axis = 'Y'`
    ).bind(a.id).first()).resolves.toMatchObject({ status: "applied" });

    const afterApproval = await listRelationExpandedMemories(env.DB, {
      namespace: "default",
      baseIds: [a.id],
      limit: 10
    });
    expect(afterApproval.map((memory) => memory.id)).toContain(c.id);
    expect(afterApproval.map((memory) => memory.id)).not.toContain(d.id);
    await expect(env.DB.prepare(
      `SELECT id FROM memory_relations
       WHERE namespace = 'default' AND source_memory_id = ? AND target_memory_id = ? AND relation_type = 'cause_effect'`
    ).bind(a.id, d.id).first()).resolves.toBeNull();

    await expect(rollbackRelationReviewCandidate(env, formFor(approveCandidate!.id)))
      .resolves.toMatchObject({ axis: "Y", action: "rollback", changed: true });
    await expect(env.DB.prepare(
      `SELECT status FROM memory_five_axis_runs
       WHERE namespace = 'default' AND memory_id = ? AND memory_revision = 1 AND axis = 'Y'`
    ).bind(a.id).first()).resolves.toMatchObject({ status: "skipped" });
    const afterRollback = await listRelationExpandedMemories(env.DB, {
      namespace: "default",
      baseIds: [a.id],
      limit: 10
    });
    expect(afterRollback.map((memory) => memory.id)).not.toContain(c.id);
  });

  it("reports review proposals without claiming they were queued during dry-run", async () => {
    const [a, b] = await Promise.all([
      createYMemory("Y dry-run A"),
      createYMemory("Y dry-run B")
    ]);
    const dependencies = {
      findCandidates: async () => [{ pairId: "review", source: a, target: b, vectorScore: 0.9 }],
      proposeRelations: async () => ({
        hints: [{ pair_id: "review", relation_type: "supports", strength: 0.8 }]
      }),
      createRelation: createMemoryRelation,
      queueReviewCandidate: queueRelationReviewCandidate
    } satisfies RelationBuildDependencies;

    await expect(runRelationBuild(env, "default", { dryRun: true, memoryIds: [a.id] }, dependencies))
      .resolves.toMatchObject({ inserted: 0, review: 0, proposed: 1, candidates: 1 });
  });
});
