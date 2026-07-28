import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createMemory, getMemoryById, updateMemory } from "../src/db/memories";
import { upsertMemoryCandidate } from "../src/db/memoryCandidates";
import { scanFactTransitionReviewCandidates } from "../src/memory/factTransitionReview";
import { scanMetabolismReviewCandidates } from "../src/memory/metabolismReview";
import { queueRelationReviewCandidate } from "../src/memory/relationReview";

interface CandidateRow {
  external_key: string;
  status: string;
  validation_error: string | null;
}

const coordinates = {
  thread: "candidate-supersession",
  riskLevel: "low",
  urgencyLevel: "normal",
  tensionScore: 0.2,
  responsePosture: "supportive",
  valence: 0.2,
  arousal: 0.3
};

async function candidates(
  namespace: string,
  action: string
): Promise<CandidateRow[]> {
  const rows = await env.DB.prepare(
    `SELECT external_key, status, validation_error
     FROM memory_candidates
     WHERE namespace = ? AND action = ?
     ORDER BY created_at, external_key`
  ).bind(namespace, action).all<CandidateRow>();
  return rows.results ?? [];
}

describe("operational candidate family supersession", () => {
  it("replaces a stale Y pair candidate without touching another pair", async () => {
    const namespace = `candidate-y-${crypto.randomUUID()}`;
    const [source, target, otherSource, otherTarget] = await Promise.all([
      createMemory(env.DB, {
        namespace,
        type: "project_state",
        content: "Y source before edit",
        ...coordinates
      }),
      createMemory(env.DB, {
        namespace,
        type: "project_state",
        content: "Y target",
        ...coordinates
      }),
      createMemory(env.DB, {
        namespace,
        type: "project_state",
        content: "Y unrelated source",
        ...coordinates
      }),
      createMemory(env.DB, {
        namespace,
        type: "project_state",
        content: "Y unrelated target",
        ...coordinates
      })
    ]);
    const staleKey = await queueRelationReviewCandidate(env, namespace, {
      relationType: "supports",
      source,
      target,
      strength: 0.8
    });
    const unrelatedKey = await queueRelationReviewCandidate(env, namespace, {
      relationType: "supports",
      source: otherSource,
      target: otherTarget,
      strength: 0.7
    });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO memory_five_axis_runs (
           namespace, memory_id, memory_revision, axis, status, attempts, updated_at
         ) VALUES (?, ?, 1, 'Y', 'pending_review', 1, ?)`
      ).bind(namespace, source.id, source.updated_at),
      env.DB.prepare(
        `INSERT INTO memory_candidate_axis_runs (
           namespace, candidate_external_key, memory_id, memory_revision, axis, created_at
         ) VALUES (?, ?, ?, 1, 'Y', ?)`
      ).bind(namespace, staleKey, source.id, source.updated_at)
    ]);

    await updateMemory(env.DB, {
      namespace,
      id: source.id,
      patch: { content: "Y source after edit" },
      expectedRevision: 1
    });
    const currentSource = await getMemoryById(env.DB, { namespace, id: source.id });
    const currentTarget = await getMemoryById(env.DB, { namespace, id: target.id });
    const replacementKey = await queueRelationReviewCandidate(env, namespace, {
      relationType: "supports",
      source: currentSource!,
      target: currentTarget!,
      strength: 0.9
    });

    expect(replacementKey).not.toBe(staleKey);
    await expect(candidates(namespace, "y_relation_review")).resolves.toEqual([
      expect.objectContaining({
        external_key: staleKey,
        status: "rejected",
        validation_error: "superseded_by_newer_candidate_snapshot"
      }),
      expect.objectContaining({
        external_key: unrelatedKey,
        status: "pending"
      }),
      expect.objectContaining({
        external_key: replacementKey,
        status: "pending"
      })
    ]);
    await expect(env.DB.prepare(
      `SELECT status FROM memory_five_axis_runs
       WHERE namespace = ? AND memory_id = ? AND memory_revision = 1 AND axis = 'Y'`
    ).bind(namespace, source.id).first()).resolves.toMatchObject({ status: "skipped" });
  });

  it("replaces an old M archive snapshot for the same memory", async () => {
    const namespace = `candidate-m-${crypto.randomUUID()}`;
    const memory = await createMemory(env.DB, {
      namespace,
      type: "project_state",
      content: "expired project state",
      importance: 0.3,
      confidence: 0.5,
      expiresAt: "2020-01-01T00:00:00.000Z",
      ...coordinates
    });
    await scanMetabolismReviewCandidates(env, namespace, { memoryIds: [memory.id] });
    const [stale] = await candidates(namespace, "m_archive");
    await updateMemory(env.DB, {
      namespace,
      id: memory.id,
      patch: { summary: "new archive snapshot" }
    });
    await scanMetabolismReviewCandidates(env, namespace, { memoryIds: [memory.id] });

    const rows = await candidates(namespace, "m_archive");
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual(expect.objectContaining({
      external_key: stale.external_key,
      status: "rejected",
      validation_error: "superseded_by_newer_candidate_snapshot"
    }));
    expect(rows).toContainEqual(expect.objectContaining({ status: "pending" }));
  });

  it("rejects an M archive candidate when a relation makes the policy false", async () => {
    const namespace = `candidate-m-policy-${crypto.randomUUID()}`;
    const [memory, related] = await Promise.all([
      createMemory(env.DB, {
        namespace,
        type: "note",
        content: "cold memory before relation",
        importance: 0.3,
        confidence: 0.5,
        ...coordinates
      }),
      createMemory(env.DB, {
        namespace,
        type: "note",
        content: "relation endpoint",
        ...coordinates
      })
    ]);
    await env.DB.prepare(
      `UPDATE memories
       SET created_at = '2020-01-01T00:00:00.000Z',
           last_recalled_at = NULL,
           recall_count = 0
       WHERE namespace = ? AND id = ?`
    ).bind(namespace, memory.id).run();
    await scanMetabolismReviewCandidates(env, namespace, { memoryIds: [memory.id] });
    await expect(candidates(namespace, "m_archive")).resolves.toEqual([
      expect.objectContaining({ status: "pending" })
    ]);

    await env.DB.prepare(
      `INSERT INTO memory_relations (
         id, namespace, source_memory_id, target_memory_id,
         relation_type, strength, reason, created_at
       ) VALUES (?, ?, ?, ?, 'same_topic', 0.8, 'test:relation', ?)`
    ).bind(
      `relation_${crypto.randomUUID()}`,
      namespace,
      memory.id,
      related.id,
      new Date().toISOString()
    ).run();
    await scanMetabolismReviewCandidates(env, namespace, { memoryIds: [memory.id] });
    await expect(candidates(namespace, "m_archive")).resolves.toEqual([
      expect.objectContaining({
        status: "rejected",
        validation_error: "superseded_by_newer_candidate_snapshot"
      })
    ]);
  });

  it("keeps M archive dry-run read-only", async () => {
    const namespace = `candidate-m-dry-run-${crypto.randomUUID()}`;
    const memory = await createMemory(env.DB, {
      namespace,
      type: "project_state",
      content: "dry-run expired project state",
      importance: 0.3,
      confidence: 0.5,
      expiresAt: "2020-01-01T00:00:00.000Z",
      ...coordinates
    });

    await expect(scanMetabolismReviewCandidates(env, namespace, {
      memoryIds: [memory.id],
      dryRun: true
    })).resolves.toMatchObject({ archive: 1 });
    await expect(candidates(namespace, "m_archive")).resolves.toEqual([]);
  });

  it("leaves non-operational candidate families unchanged", async () => {
    const namespace = `candidate-unaffected-${crypto.randomUUID()}`;
    const memory = await createMemory(env.DB, {
      namespace,
      type: "identity",
      content: "non-operational candidate dependency",
      ...coordinates
    });
    const actions = ["add", "timeline_date", "m_relation_cleanup"] as const;
    for (const action of actions) {
      await upsertMemoryCandidate(env.DB, namespace, {
        externalKey: `${action}:${crypto.randomUUID()}`,
        dreamDate: "2026-07-29",
        action,
        subject: "system",
        targetId: memory.id,
        payload: { _kind: "unaffected_candidate_test", memory_id: memory.id },
        sourceChunkIds: [],
        status: "pending",
        dependencies: [{ memoryId: memory.id, role: "target" }]
      });
    }

    await updateMemory(env.DB, {
      namespace,
      id: memory.id,
      patch: { content: "non-operational dependency updated" }
    });
    await scanFactTransitionReviewCandidates(env, namespace, {
      factKeys: [`unaffected:${crypto.randomUUID()}`]
    });
    await scanMetabolismReviewCandidates(env, namespace, {
      memoryIds: [memory.id]
    });

    for (const action of actions) {
      await expect(candidates(namespace, action)).resolves.toEqual([
        expect.objectContaining({
          status: "pending",
          validation_error: null
        })
      ]);
    }
  });

  it("replaces the whole Z fact family after ranking flips and records both endpoints", async () => {
    const namespace = `candidate-z-${crypto.randomUUID()}`;
    const factKey = `fact:${crypto.randomUUID()}`;
    const [first, second, third] = await Promise.all([
      createMemory(env.DB, {
        namespace,
        type: "project_state",
        content: "rank one",
        factKey,
        importance: 0.9,
        confidence: 0.9,
        ...coordinates
      }),
      createMemory(env.DB, {
        namespace,
        type: "project_state",
        content: "rank two",
        factKey,
        importance: 0.8,
        confidence: 0.9,
        ...coordinates
      }),
      createMemory(env.DB, {
        namespace,
        type: "project_state",
        content: "rank three",
        factKey,
        importance: 0.7,
        confidence: 0.9,
        ...coordinates
      })
    ]);
    await scanFactTransitionReviewCandidates(env, namespace, { factKeys: [factKey] });
    const initial = await candidates(namespace, "z_supersede");
    expect(initial).toHaveLength(2);

    const dependencies = await env.DB.prepare(
      `SELECT candidate_external_key, memory_id, role
       FROM memory_candidate_dependencies
       WHERE namespace = ? AND role IN ('source', 'target')
       ORDER BY candidate_external_key, role`
    ).bind(namespace).all<{
      candidate_external_key: string;
      memory_id: string;
      role: string;
    }>();
    expect(dependencies.results).toHaveLength(4);
    expect(dependencies.results?.filter((row) => row.role === "source").map((row) => row.memory_id))
      .toEqual([first.id, first.id]);
    expect(dependencies.results?.filter((row) => row.role === "target").map((row) => row.memory_id).sort())
      .toEqual([second.id, third.id].sort());

    await updateMemory(env.DB, {
      namespace,
      id: second.id,
      patch: { importance: 0.95 }
    });
    await expect(scanFactTransitionReviewCandidates(env, namespace, { factKeys: [factKey] }))
      .resolves.toMatchObject({ candidates: 2, superseded: 1 });

    const current = await candidates(namespace, "z_supersede");
    expect(current.filter((row) => row.status === "rejected")).toHaveLength(2);
    expect(current.filter((row) => row.status === "pending")).toHaveLength(2);
  });

  it("rejects a pending Z family when the conflict disappears", async () => {
    const namespace = `candidate-z-empty-${crypto.randomUUID()}`;
    const factKey = `fact:${crypto.randomUUID()}`;
    const [best, weaker] = await Promise.all([
      createMemory(env.DB, {
        namespace,
        type: "project_state",
        content: "remaining fact",
        factKey,
        importance: 0.9,
        ...coordinates
      }),
      createMemory(env.DB, {
        namespace,
        type: "project_state",
        content: "departing fact",
        factKey,
        importance: 0.5,
        ...coordinates
      })
    ]);
    await scanFactTransitionReviewCandidates(env, namespace, { factKeys: [factKey] });
    await updateMemory(env.DB, {
      namespace,
      id: weaker.id,
      patch: { factKey: `${factKey}:moved` }
    });

    await expect(scanFactTransitionReviewCandidates(env, namespace))
      .resolves.toMatchObject({ candidates: 0, superseded: 0 });
    await expect(candidates(namespace, "z_supersede")).resolves.toEqual([
      expect.objectContaining({
        status: "rejected",
        validation_error: "superseded_by_newer_candidate_snapshot"
      })
    ]);
    expect(best.id).not.toBe(weaker.id);
  });

  it("keeps dry-run and terminal candidates unchanged", async () => {
    const namespace = `candidate-z-terminal-${crypto.randomUUID()}`;
    const factKey = `fact:${crypto.randomUUID()}`;
    const [first, second, third] = await Promise.all([
      createMemory(env.DB, {
        namespace,
        type: "project_state",
        content: "terminal rank one",
        factKey,
        importance: 0.9,
        ...coordinates
      }),
      createMemory(env.DB, {
        namespace,
        type: "project_state",
        content: "terminal rank two",
        factKey,
        importance: 0.8,
        ...coordinates
      }),
      createMemory(env.DB, {
        namespace,
        type: "project_state",
        content: "terminal rank three",
        factKey,
        importance: 0.7,
        ...coordinates
      })
    ]);
    await scanFactTransitionReviewCandidates(env, namespace, { factKeys: [factKey] });
    const [approved, rejected] = await candidates(namespace, "z_supersede");
    await env.DB.batch([
      env.DB.prepare(
      `UPDATE memory_candidates
       SET status = 'approved', resolved_at = updated_at
       WHERE namespace = ? AND external_key = ?`
      ).bind(namespace, approved.external_key),
      env.DB.prepare(
        `UPDATE memory_candidates
         SET status = 'rejected',
             validation_error = 'manual_rejection',
             resolved_at = updated_at
         WHERE namespace = ? AND external_key = ?`
      ).bind(namespace, rejected.external_key)
    ]);
    await updateMemory(env.DB, {
      namespace,
      id: second.id,
      patch: { importance: 0.95 }
    });

    await scanFactTransitionReviewCandidates(env, namespace, {
      factKeys: [factKey],
      dryRun: true
    });
    await expect(candidates(namespace, "z_supersede")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          external_key: approved.external_key,
          status: "approved"
        }),
        expect.objectContaining({
          external_key: rejected.external_key,
          status: "rejected",
          validation_error: "manual_rejection"
        })
      ])
    );

    await scanFactTransitionReviewCandidates(env, namespace, {
      factKeys: [factKey]
    });
    const afterReplacement = await candidates(namespace, "z_supersede");
    expect(afterReplacement).toEqual(expect.arrayContaining([
      expect.objectContaining({
        external_key: approved.external_key,
        status: "approved"
      }),
      expect.objectContaining({
        external_key: rejected.external_key,
        status: "rejected",
        validation_error: "manual_rejection"
      })
    ]));
    expect(afterReplacement.filter((row) => row.status === "pending")).toHaveLength(2);
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
  });
});
