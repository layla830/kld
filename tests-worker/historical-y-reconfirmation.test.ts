import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createMemory } from "../src/db/memories";
import { createMemoryRelation, getMemoryRelationById } from "../src/db/memoryRelations";
import {
  HistoricalYReconfirmationError,
  runHistoricalYReconfirmation
} from "../src/memory/historicalYReconfirmation";
import { proposeHistoricalYRelations } from "../src/memory/historicalYProposer";
import {
  proposeRelationsViaLlm,
  type RelationCandidate
} from "../src/memory/fiveAxis/yRelations";
import type { Env } from "../src/types";
import {
  buildHistoricalRelationManifest,
  buildHistoricalRelationPageQuery,
  buildHistoricalRelationSummaryQuery
} from "../scripts/historical-relation-governance.mjs";
import {
  buildHistoricalRelationSnapshotBatchStatements,
  buildHistoricalRelationVerifySql
} from "../src/memory/historicalRelationSnapshotSql.js";

async function createVerifiedFixture(
  relationType = "same_topic",
  nonCanonical = false
) {
  const namespace = `historical-y-${crypto.randomUUID()}`;
  const [source, target] = await Promise.all([
    createMemory(env.DB, {
      namespace,
      type: "note",
      content: "The deployment incident affected the memory graph.",
      status: "active"
    }),
    createMemory(env.DB, {
      namespace,
      type: "note",
      content: "The same deployment incident was repaired later.",
      status: "active"
    })
  ]);
  if (nonCanonical) {
    const sourceId = source.id > target.id ? source.id : target.id;
    const targetId = source.id > target.id ? target.id : source.id;
    await env.DB.prepare(
      `INSERT INTO memory_relations (
         id, namespace, source_memory_id, target_memory_id,
         relation_type, strength, reason, created_at
       ) VALUES (?, ?, ?, ?, ?, 0.8, 'legacy semantic reason', ?)`
    ).bind(
      `rel_${crypto.randomUUID()}`,
      namespace,
      sourceId,
      targetId,
      relationType,
      "2026-08-01T23:00:00.000Z"
    ).run();
  } else {
    await createMemoryRelation(env.DB, {
      namespace,
      sourceMemoryId: source.id,
      targetMemoryId: target.id,
      relationType,
      strength: 0.8,
      reason: "legacy semantic reason"
    });
  }
  const summary = await env.DB.prepare(
    buildHistoricalRelationSummaryQuery({ namespace }).sql
  ).all<Record<string, unknown>>();
  const page = await env.DB.prepare(
    buildHistoricalRelationPageQuery({ namespace, pageSize: 100 }).sql
  ).all<Record<string, unknown>>();
  const generatedAt = "2026-08-02T00:00:00.000Z";
  const manifest = buildHistoricalRelationManifest({
    namespace,
    summaryRows: summary.results ?? [],
    rows: page.results ?? [],
    generatedAt
  });
  const cohort = manifest.cohort_manifests.eligible_unproven;
  const row = manifest.relations[0] as Record<string, unknown>;
  const descriptor = {
    manifest_id: cohort.manifest_id,
    namespace,
    lifecycle_cohort: "eligible_unproven",
    selection_predicate_version: manifest.selection_predicate_version,
    expected_relation_count: cohort.relation_count,
    expected_relations_sha256: cohort.relations_sha256,
    expected_selection_sha256: cohort.selection_sha256,
    created_at: generatedAt
  };
  await env.DB.batch(buildHistoricalRelationSnapshotBatchStatements(
    descriptor,
    [row],
    "2026-08-02T00:01:00.000Z"
  ).map((sql) => env.DB.prepare(sql)));
  await env.DB.prepare(buildHistoricalRelationVerifySql(
    descriptor,
    "2026-08-02T00:02:00.000Z"
  )).run();
  return {
    namespace,
    source: source.id === row.source_memory_id ? source : target,
    target: target.id === row.target_memory_id ? target : source,
    relationId: String(row.id),
    manifestId: cohort.manifest_id
  };
}

async function createVerifiedSubsetFixture() {
  const namespace = `historical-y-subset-${crypto.randomUUID()}`;
  const [source, targetOne, targetTwo] = await Promise.all([
    createMemory(env.DB, {
      namespace,
      type: "note",
      content: "A synthetic deployment incident affected the graph.",
      status: "active"
    }),
    createMemory(env.DB, {
      namespace,
      type: "lesson",
      content: "A synthetic lesson was recorded after the deployment incident.",
      status: "active"
    }),
    createMemory(env.DB, {
      namespace,
      type: "rule",
      content: "A synthetic operational rule also concerns that deployment.",
      status: "active"
    })
  ]);
  await Promise.all([
    createMemoryRelation(env.DB, {
      namespace,
      sourceMemoryId: source.id,
      targetMemoryId: targetOne.id,
      relationType: "same_topic",
      strength: 0.8,
      reason: "legacy subset reason one"
    }),
    createMemoryRelation(env.DB, {
      namespace,
      sourceMemoryId: source.id,
      targetMemoryId: targetTwo.id,
      relationType: "same_topic",
      strength: 0.7,
      reason: "legacy subset reason two"
    })
  ]);
  const summary = await env.DB.prepare(
    buildHistoricalRelationSummaryQuery({ namespace }).sql
  ).all<Record<string, unknown>>();
  const page = await env.DB.prepare(
    buildHistoricalRelationPageQuery({ namespace, pageSize: 100 }).sql
  ).all<Record<string, unknown>>();
  const generatedAt = "2026-08-02T00:00:00.000Z";
  const manifest = buildHistoricalRelationManifest({
    namespace,
    summaryRows: summary.results ?? [],
    rows: page.results ?? [],
    generatedAt
  });
  const cohort = manifest.cohort_manifests.eligible_unproven;
  const rows = manifest.relations as Array<Record<string, unknown>>;
  const descriptor = {
    manifest_id: cohort.manifest_id,
    namespace,
    lifecycle_cohort: "eligible_unproven",
    selection_predicate_version: manifest.selection_predicate_version,
    expected_relation_count: cohort.relation_count,
    expected_relations_sha256: cohort.relations_sha256,
    expected_selection_sha256: cohort.selection_sha256,
    created_at: generatedAt
  };
  await env.DB.batch(buildHistoricalRelationSnapshotBatchStatements(
    descriptor,
    rows,
    "2026-08-02T00:01:00.000Z"
  ).map((sql) => env.DB.prepare(sql)));
  await env.DB.prepare(buildHistoricalRelationVerifySql(
    descriptor,
    "2026-08-02T00:02:00.000Z"
  )).run();
  return {
    namespace,
    manifestId: cohort.manifest_id,
    relationIds: rows.map((row) => String(row.id)).sort(),
    reasons: new Map(rows.map((row) => [String(row.id), String(row.reason)]))
  };
}

function exactProposal(relationType = "same_topic") {
  return vi.fn(async (
    _runtimeEnv: Env,
    candidates: RelationCandidate[],
    _modelOverride?: string
  ) => ({
    hints: candidates.map((candidate) => ({
      pair_id: candidate.pairId,
      relation_type: relationType,
      strength: 0.9,
      reason: "independent Y confirmation"
    }))
  }));
}

describe("historical Y relation reconfirmation", () => {
  it("keeps the historical and shared Y proposer request contracts isolated", async () => {
    const fixture = await createVerifiedFixture();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      choices: [{ message: { content: JSON.stringify({
        hints: [{
          pair_id: fixture.relationId,
          relation_type: "same_topic",
          strength: 0.8,
          reason: "synthetic shared-proposer reason"
        }]
      }) } }]
    }));
    const runtimeEnv = {
      ...env,
      UPSTREAM_BASE_URL: "https://example.test/v1",
      UPSTREAM_API_KEY: "test-token"
    } as Env;
    const candidates: RelationCandidate[] = [{
      pairId: fixture.relationId,
      source: fixture.source,
      target: fixture.target,
      vectorScore: 0.8
    }];

    await proposeHistoricalYRelations(runtimeEnv, candidates, "test-model");
    await proposeRelationsViaLlm(runtimeEnv, candidates, "test-model");

    const historicalRequest = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    const sharedRequest = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body));
    expect(historicalRequest.max_tokens).toBe(4096);
    expect(String(historicalRequest.messages?.[1]?.content)).not.toContain('"reason":');
    expect(sharedRequest).toMatchObject({
      max_tokens: 1800,
      temperature: 0,
      response_format: { type: "json_object" },
      stream: false
    });
    expect(String(sharedRequest.messages?.[1]?.content)).toContain('"reason":');
    fetchSpy.mockRestore();
  });

  it("runs a real LLM dry-run plan with zero D1 writes", async () => {
    const fixture = await createVerifiedFixture();
    const before = await getMemoryRelationById(env.DB, {
      namespace: fixture.namespace,
      id: fixture.relationId
    });
    const proposal = exactProposal();
    const runtimeEnv = {
      ...env,
      HISTORICAL_Y_RECONFIRM_MODEL: "deepseek/deepseek-v4-flash"
    } as Env;
    const result = await runHistoricalYReconfirmation(runtimeEnv, fixture.namespace, {
      manifestId: fixture.manifestId,
      relationIds: [fixture.relationId],
      dryRun: true
    }, { proposeRelations: proposal, now: () => "2026-08-02T01:00:00.000Z" });

    expect(proposal).toHaveBeenCalledTimes(1);
    expect(proposal.mock.calls[0]?.[2]).toBe("deepseek/deepseek-v4-flash");
    expect(result).toMatchObject({
      mode: "dry_run",
      promoted: 1,
      entries: [{
        relation_id: fixture.relationId,
        outcome: "would_promote",
        change_kind: "exact_match",
        provenance_claim: false,
        review_evidence: {
          original_relation_type: "same_topic",
          original_strength: 0.8,
          source: {
            id: fixture.source.id,
            type: "note",
            status: "active",
            active_fact: 1,
            five_axis_revision: 1,
            created_at: fixture.source.created_at,
            content_excerpt: fixture.source.content
          },
          target: {
            id: fixture.target.id,
            type: "note",
            status: "active",
            active_fact: 1,
            five_axis_revision: 1,
            created_at: fixture.target.created_at,
            content_excerpt: fixture.target.content
          }
        }
      }]
    });
    await expect(getMemoryRelationById(env.DB, {
      namespace: fixture.namespace,
      id: fixture.relationId
    })).resolves.toEqual(before);
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM historical_relation_reconfirmation_batches
       WHERE manifest_id = ?`
    ).bind(fixture.manifestId).first<number>("count")).resolves.toBe(0);
  });

  it("distinguishes explicit none, missing pairs, and provenance type changes in dry-run reports", async () => {
    const fixture = await createVerifiedFixture();
    const options = {
      manifestId: fixture.manifestId,
      relationIds: [fixture.relationId],
      dryRun: true
    };
    const explicitNone = await runHistoricalYReconfirmation(env, fixture.namespace, options, {
      proposeRelations: vi.fn(async () => ({
        hints: [{ pair_id: fixture.relationId, relation_type: "none", strength: null }]
      })),
      now: () => "2026-08-02T00:10:00.000Z"
    });
    expect(explicitNone.entries).toEqual([expect.objectContaining({
      change_kind: "none_returned",
      proposed_relation_type: "none",
      proposed_strength: null,
      provenance_claim: false
    })]);

    const missing = await runHistoricalYReconfirmation(env, fixture.namespace, options, {
      proposeRelations: vi.fn(async () => ({ hints: [] })),
      now: () => "2026-08-02T00:20:00.000Z"
    });
    expect(missing.entries).toEqual([expect.objectContaining({
      change_kind: "missing_pair",
      proposed_relation_type: "none",
      provenance_claim: false
    })]);

    const provenanceChange = await runHistoricalYReconfirmation(env, fixture.namespace, options, {
      proposeRelations: vi.fn(async () => ({
        hints: [{ pair_id: fixture.relationId, relation_type: "derived_from", strength: 0.8 }]
      })),
      now: () => "2026-08-02T00:30:00.000Z"
    });
    expect(provenanceChange.entries).toEqual([expect.objectContaining({
      change_kind: "type_changed",
      proposed_relation_type: "derived_from",
      provenance_claim: true
    })]);

    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM historical_relation_reconfirmation_batches
       WHERE manifest_id = ?`
    ).bind(fixture.manifestId).first<number>("count")).resolves.toBe(0);
  });

  it("atomically promotes an exact relation and records immutable before/after evidence", async () => {
    const fixture = await createVerifiedFixture();
    const proposal = exactProposal();
    const options = {
      manifestId: fixture.manifestId,
      relationIds: [fixture.relationId],
      dryRun: false,
      confirm: fixture.manifestId
    };
    const result = await runHistoricalYReconfirmation(env, fixture.namespace, options, {
      proposeRelations: proposal,
      now: () => "2026-08-02T01:00:00.000Z"
    });
    expect(result).toMatchObject({ mode: "apply", promoted: 1, not_applied: 0 });
    const relation = await getMemoryRelationById(env.DB, {
      namespace: fixture.namespace,
      id: fixture.relationId
    });
    expect(relation?.reason).toBe(
      `y:auto:${fixture.source.id}:1|previous_reason:legacy semantic reason`
    );
    expect(result.entries).toEqual([expect.objectContaining({
      relation_id: fixture.relationId,
      before_reason: "legacy semantic reason",
      after_reason: relation?.reason,
      proposed_relation_type: "same_topic",
      outcome: "promoted"
    })]);

    const neverCalled = vi.fn(async () => { throw new Error("should not rerun model"); });
    const replay = await runHistoricalYReconfirmation(env, fixture.namespace, options, {
      proposeRelations: neverCalled,
      now: () => "2026-08-02T02:00:00.000Z"
    });
    expect(replay.mode).toBe("replay");
    expect(replay.batch_id).toBe(result.batch_id);
    expect(neverCalled).not.toHaveBeenCalled();
    await expect(env.DB.prepare(
      `UPDATE historical_relation_reconfirmation_entries
       SET outcome = 'not_applied'
       WHERE batch_id = ?`
    ).bind(result.batch_id).run()).rejects.toThrow(
      "historical_relation_reconfirmation_entry_update_forbidden"
    );
  });

  it("applies and replays exactly an approved subset of a larger manifest", async () => {
    const fixture = await createVerifiedSubsetFixture();
    const selectedRelationId = fixture.relationIds[0]!;
    const unselectedRelationId = fixture.relationIds[1]!;
    const options = {
      manifestId: fixture.manifestId,
      relationIds: [selectedRelationId],
      dryRun: false,
      confirm: fixture.manifestId
    };
    const result = await runHistoricalYReconfirmation(env, fixture.namespace, options, {
      proposeRelations: exactProposal(),
      now: () => "2026-08-02T01:30:00.000Z"
    });

    expect(result).toMatchObject({
      mode: "apply",
      relation_count: 1,
      promoted: 1,
      entries: [{ relation_id: selectedRelationId, outcome: "promoted" }]
    });
    await expect(env.DB.prepare(
      `SELECT relation_ids_json
       FROM historical_relation_reconfirmation_batches
       WHERE batch_id = ?`
    ).bind(result.batch_id).first<string>("relation_ids_json"))
      .resolves.toBe(JSON.stringify([selectedRelationId]));
    await expect(env.DB.prepare(
      `SELECT relation_id
       FROM historical_relation_reconfirmation_entries
       WHERE batch_id = ?`
    ).bind(result.batch_id).first<string>("relation_id"))
      .resolves.toBe(selectedRelationId);
    await expect(getMemoryRelationById(env.DB, {
      namespace: fixture.namespace,
      id: selectedRelationId
    })).resolves.toEqual(expect.objectContaining({
      reason: expect.stringContaining("y:auto:")
    }));
    await expect(getMemoryRelationById(env.DB, {
      namespace: fixture.namespace,
      id: unselectedRelationId
    })).resolves.toEqual(expect.objectContaining({
      reason: fixture.reasons.get(unselectedRelationId)
    }));

    const neverCalled = vi.fn(async () => { throw new Error("should not rerun model"); });
    const replay = await runHistoricalYReconfirmation(env, fixture.namespace, options, {
      proposeRelations: neverCalled,
      now: () => "2026-08-02T02:30:00.000Z"
    });
    expect(replay).toMatchObject({
      mode: "replay",
      batch_id: result.batch_id,
      relation_count: 1,
      entries: [{ relation_id: selectedRelationId, outcome: "promoted" }]
    });
    expect(neverCalled).not.toHaveBeenCalled();
  });

  it("records a bounded no-op when Y does not independently confirm the same type", async () => {
    const fixture = await createVerifiedFixture();
    const result = await runHistoricalYReconfirmation(env, fixture.namespace, {
      manifestId: fixture.manifestId,
      relationIds: [fixture.relationId],
      dryRun: false,
      confirm: fixture.manifestId
    }, {
      proposeRelations: exactProposal("same_event"),
      now: () => "2026-08-02T01:00:00.000Z"
    });
    expect(result).toMatchObject({
      mode: "apply",
      promoted: 0,
      not_reconfirmed: 1,
      entries: [{ outcome: "not_reconfirmed" }]
    });
    await expect(getMemoryRelationById(env.DB, {
      namespace: fixture.namespace,
      id: fixture.relationId
    })).resolves.toMatchObject({ reason: "legacy semantic reason" });
  });

  it("fails closed before the model when either endpoint revision drifts", async () => {
    const fixture = await createVerifiedFixture();
    await env.DB.prepare(
      `UPDATE memories
       SET five_axis_revision = five_axis_revision + 1,
           updated_at = '2026-08-02T03:00:00.000Z'
       WHERE namespace = ? AND id = ?`
    ).bind(fixture.namespace, fixture.target.id).run();
    const proposal = exactProposal();
    await expect(runHistoricalYReconfirmation(env, fixture.namespace, {
      manifestId: fixture.manifestId,
      relationIds: [fixture.relationId],
      dryRun: false,
      confirm: fixture.manifestId
    }, { proposeRelations: proposal, now: () => "2026-08-02T04:00:00.000Z" }))
      .rejects.toEqual(expect.objectContaining<Partial<HistoricalYReconfirmationError>>({
        code: `historical_y_endpoint_drift:${fixture.relationId}`,
        status: 409
      }));
    expect(proposal).not.toHaveBeenCalled();
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM historical_relation_reconfirmation_batches
       WHERE manifest_id = ?`
    ).bind(fixture.manifestId).first<number>("count")).resolves.toBe(0);
  });

  it("keeps temporal_sequence outside Y ownership", async () => {
    const fixture = await createVerifiedFixture("temporal_sequence");
    const proposal = exactProposal("temporal_sequence");
    await expect(runHistoricalYReconfirmation(env, fixture.namespace, {
      manifestId: fixture.manifestId,
      relationIds: [fixture.relationId],
      dryRun: true
    }, { proposeRelations: proposal, now: () => "2026-08-02T05:00:00.000Z" }))
      .rejects.toEqual(expect.objectContaining({
        code: `historical_y_relation_type_not_reconfirmable:${fixture.relationId}`
      }));
    expect(proposal).not.toHaveBeenCalled();
  });

  it("rejects a non-canonical symmetric pair instead of inserting a reverse duplicate", async () => {
    const fixture = await createVerifiedFixture("same_topic", true);
    const proposal = exactProposal();
    await expect(runHistoricalYReconfirmation(env, fixture.namespace, {
      manifestId: fixture.manifestId,
      relationIds: [fixture.relationId],
      dryRun: false,
      confirm: fixture.manifestId
    }, { proposeRelations: proposal, now: () => "2026-08-02T06:00:00.000Z" }))
      .rejects.toEqual(expect.objectContaining({
        code: `historical_y_relation_pair_not_canonical:${fixture.relationId}`
      }));
    expect(proposal).not.toHaveBeenCalled();
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM memory_relations
       WHERE namespace = ?`
    ).bind(fixture.namespace).first<number>("count")).resolves.toBe(1);
  });
});
