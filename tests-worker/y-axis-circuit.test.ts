import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  approveRelationReviewCandidate,
  rejectRelationReviewCandidate,
  rollbackRelationReviewCandidate
} from "../src/api/adminBoard/relationReviewActions";
import { createMemoryRelation, listRelationExpandedMemories } from "../src/db/memoryRelations";
import { createMemory, updateMemory } from "../src/db/memories";
import { queueRelationReviewCandidate } from "../src/memory/relationReview";
import { projectMemoryIntoFiveAxes } from "../src/memory/fiveAxis/projection";
import {
  createFiveAxisMemoryRelation,
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
  it("does not traverse historical diary edges as a two-hop bridge", async () => {
    const [a, diary, b] = await Promise.all([
      createYMemory("Y historical bridge A"),
      createMemory(env.DB, {
        namespace: "default",
        type: "diary",
        content: "Historical original diary bridge",
        source: "cc-connect-vps",
        importance: 0.8
      }),
      createYMemory("Y historical bridge B")
    ]);
    await createMemoryRelation(env.DB, {
      namespace: "default",
      sourceMemoryId: a.id,
      targetMemoryId: diary.id,
      relationType: "same_topic",
      strength: 0.95,
      reason: "legacy edge before diary eligibility guard"
    });
    await createMemoryRelation(env.DB, {
      namespace: "default",
      sourceMemoryId: diary.id,
      targetMemoryId: b.id,
      relationType: "same_topic",
      strength: 0.95,
      reason: "legacy edge before diary eligibility guard"
    });

    const expanded = await listRelationExpandedMemories(env.DB, {
      namespace: "default",
      baseIds: [a.id],
      limit: 10
    });

    expect(expanded.map((memory) => memory.id)).not.toContain(diary.id);
    expect(expanded.map((memory) => memory.id)).not.toContain(b.id);
  });

  it("keeps original diaries out of Y edges while allowing their split memories", async () => {
    const [diary, splitMemory, target] = await Promise.all([
      createMemory(env.DB, {
        namespace: "default",
        type: "diary",
        content: "Original long diary retained as source material",
        source: "cc-connect-vps",
        importance: 0.8
      }),
      createMemory(env.DB, {
        namespace: "default",
        type: "lesson",
        content: "Atomic lesson extracted from the diary",
        source: "timeline_split",
        tags: ["origin:mem_diary_test", "date:2026-07-17"],
        importance: 0.8
      }),
      createYMemory("Y eligible relation target")
    ]);

    await expect(createFiveAxisMemoryRelation(env.DB, {
      namespace: "default",
      sourceMemoryId: diary.id,
      targetMemoryId: target.id,
      relationType: "same_topic"
    })).resolves.toBe(false);
    await expect(createFiveAxisMemoryRelation(env.DB, {
      namespace: "default",
      sourceMemoryId: splitMemory.id,
      targetMemoryId: target.id,
      relationType: "same_topic"
    })).resolves.toBe(true);

    const relations = await env.DB.prepare(
      `SELECT source_memory_id, target_memory_id FROM memory_relations
       WHERE namespace = 'default' AND relation_type = 'same_topic'
         AND (source_memory_id IN (?, ?) OR target_memory_id IN (?, ?))`
    ).bind(diary.id, splitMemory.id, diary.id, splitMemory.id).all<{
      source_memory_id: string;
      target_memory_id: string;
    }>();
    expect(relations.results.some((relation) =>
      relation.source_memory_id === diary.id || relation.target_memory_id === diary.id
    )).toBe(false);
    expect(relations.results.some((relation) =>
      relation.source_memory_id === splitMemory.id || relation.target_memory_id === splitMemory.id
    )).toBe(true);
  });

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

    const approvePayload = JSON.parse(approveCandidate!.payload_json) as Record<string, unknown>;
    expect(approvePayload).toMatchObject({ source_revision: 1, target_revision: 1 });
    await expect(env.DB.prepare(
      `SELECT dependency.memory_id, dependency.role
       FROM memory_candidate_dependencies AS dependency
       JOIN memory_candidates AS candidate
         ON candidate.namespace = dependency.namespace
        AND candidate.external_key = dependency.candidate_external_key
       WHERE candidate.namespace = 'default' AND candidate.id = ?
         AND dependency.role IN ('source', 'target')
       ORDER BY dependency.role`
    ).bind(approveCandidate!.id).all<{ memory_id: string; role: string }>())
      .resolves.toMatchObject({
        results: [
          { memory_id: approvePayload.source_id, role: "source" },
          { memory_id: approvePayload.target_id, role: "target" }
        ]
      });
    await env.DB.prepare(
      `UPDATE memories
       SET vector_id = ?, vector_synced = 1, urgency_level = 'high', updated_at = ?
       WHERE namespace = 'default' AND id = ?`
    ).bind("vector-infrastructure-only", "2026-07-19T01:00:00.000Z", approvePayload.source_id).run();

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

  it("uses the linked axis revision for legacy candidates after infrastructure-only updates", async () => {
    const [source, target] = await Promise.all([
      createYMemory("Y legacy revision source"),
      createYMemory("Y legacy revision target")
    ]);
    const dependencies = {
      findCandidates: async () => [{ pairId: "legacy", source, target, vectorScore: 0.9 }],
      proposeRelations: async () => ({
        hints: [{ pair_id: "legacy", relation_type: "supports", strength: 0.8 }]
      }),
      createRelation: createMemoryRelation,
      queueReviewCandidate: queueRelationReviewCandidate
    } satisfies RelationBuildDependencies;

    await projectMemoryIntoFiveAxes(env, {
      namespace: "default",
      memoryId: source.id,
      memoryRevision: 1,
      projectionKey: "legacy-y-revision"
    }, {
      projectRelations: (runtimeEnv, namespace, options) => runRelationBuild(
        runtimeEnv,
        namespace,
        options,
        dependencies
      )
    });
    const candidate = await env.DB.prepare(
      `SELECT id, status, payload_json FROM memory_candidates
       WHERE namespace = 'default' AND action = 'y_relation_review' AND status = 'pending'
         AND json_extract(payload_json, '$.source_id') = ?
         AND json_extract(payload_json, '$.target_id') = ?`
    ).bind(source.id, target.id).first<CandidateRow>();
    expect(candidate).toBeTruthy();
    const legacyPayload = JSON.parse(candidate!.payload_json) as Record<string, unknown>;
    delete legacyPayload.source_revision;
    delete legacyPayload.target_revision;
    await env.DB.prepare(
      "UPDATE memory_candidates SET payload_json = ? WHERE namespace = 'default' AND id = ?"
    ).bind(JSON.stringify(legacyPayload), candidate!.id).run();
    await env.DB.prepare(
      `UPDATE memories
       SET vector_id = ?, vector_synced = 1, response_posture = 'internal update', updated_at = ?
       WHERE namespace = 'default' AND id = ?`
    ).bind("legacy-vector", "2026-07-19T02:00:00.000Z", source.id).run();
    await env.DB.prepare(
      `UPDATE memories
       SET vector_id = ?, vector_synced = 1, response_posture = 'target internal update', updated_at = ?
       WHERE namespace = 'default' AND id = ?`
    ).bind("legacy-target-vector", "2026-07-19T02:00:01.000Z", target.id).run();

    await expect(approveRelationReviewCandidate(env, formFor(candidate!.id)))
      .resolves.toMatchObject({ axis: "Y", action: "approve", changed: true });
  });

  it("still rejects a reviewed relation after a semantic memory revision", async () => {
    const [source, target] = await Promise.all([
      createYMemory("Y semantic revision source"),
      createYMemory("Y semantic revision target")
    ]);
    const externalKey = await queueRelationReviewCandidate(env, "default", {
      relationType: "supports",
      source,
      target,
      strength: 0.8
    });
    const candidate = await env.DB.prepare(
      `SELECT id, status, payload_json FROM memory_candidates
       WHERE namespace = 'default' AND external_key = ?`
    ).bind(externalKey).first<CandidateRow>();
    expect(candidate).toBeTruthy();
    await updateMemory(env.DB, {
      namespace: "default",
      id: source.id,
      patch: { content: "Y semantic revision source changed" }
    });

    await expect(approveRelationReviewCandidate(env, formFor(candidate!.id)))
      .rejects.toThrow("relation_review_candidate_is_stale");
  });

  it("rejects a reviewed relation when an endpoint becomes an original diary", async () => {
    const [source, target] = await Promise.all([
      createYMemory("Y endpoint type source"),
      createYMemory("Y endpoint type target")
    ]);
    const externalKey = await queueRelationReviewCandidate(env, "default", {
      relationType: "supports",
      source,
      target,
      strength: 0.8
    });
    const candidate = await env.DB.prepare(
      `SELECT id, status, payload_json FROM memory_candidates
       WHERE namespace = 'default' AND external_key = ?`
    ).bind(externalKey).first<CandidateRow>();
    expect(candidate).toBeTruthy();
    await updateMemory(env.DB, {
      namespace: "default",
      id: target.id,
      patch: { type: "diary" }
    });

    await expect(approveRelationReviewCandidate(env, formFor(candidate!.id)))
      .rejects.toThrow("relation_review_candidate_is_stale");
    await expect(env.DB.prepare(
      `SELECT id FROM memory_relations
       WHERE namespace = 'default' AND source_memory_id = ? AND target_memory_id = ?
         AND relation_type = 'supports'`
    ).bind(source.id, target.id).first()).resolves.toBeNull();
  });

  it("does not recover a newer outbox revision for a legacy candidate built from an older snapshot", async () => {
    const [sourceSnapshot, targetSnapshot] = await Promise.all([
      createYMemory("Y legacy snapshot source"),
      createYMemory("Y legacy snapshot target")
    ]);
    await updateMemory(env.DB, {
      namespace: "default",
      id: targetSnapshot.id,
      patch: { content: "Y legacy snapshot target changed while the proposal was running" }
    });
    const externalKey = await queueRelationReviewCandidate(env, "default", {
      relationType: "supports",
      source: sourceSnapshot,
      target: targetSnapshot,
      strength: 0.8
    });
    const candidate = await env.DB.prepare(
      `SELECT id, status, payload_json FROM memory_candidates
       WHERE namespace = 'default' AND external_key = ?`
    ).bind(externalKey).first<CandidateRow>();
    expect(candidate).toBeTruthy();
    const legacyPayload = JSON.parse(candidate!.payload_json) as Record<string, unknown>;
    delete legacyPayload.source_revision;
    delete legacyPayload.target_revision;
    await env.DB.prepare(
      "UPDATE memory_candidates SET payload_json = ? WHERE namespace = 'default' AND id = ?"
    ).bind(JSON.stringify(legacyPayload), candidate!.id).run();

    await expect(approveRelationReviewCandidate(env, formFor(candidate!.id)))
      .rejects.toThrow("relation_review_candidate_is_stale");
  });
});
