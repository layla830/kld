import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { approveOperationalReviewCandidate } from "../src/api/adminBoard/operationalReviewActions";
import { putCacheEntry } from "../src/db/cacheEntries";
import { upsertMemoryCandidate } from "../src/db/memoryCandidates";
import {
  claimFiveAxisRun,
  failFiveAxisRun,
  MAX_FIVE_AXIS_RUN_ATTEMPTS,
  type FiveAxisRunKey
} from "../src/db/memoryFiveAxisRuns";
import { createMemory } from "../src/db/memories";
import { E_AXIS_STATE_KEY, readShadowState, shouldApplyEAxisToRanking } from "../src/memory/eAxis";
import type { ScoredMemoryRecord } from "../src/memory/vectorStore";
import { mergeSearchResults } from "../src/recall/fusion";
import type { Env } from "../src/types";

describe("E-axis Worker runtime state", () => {
  it("reads the durable D1 shadow start and switches the actual fusion order only when promotion is enabled", async () => {
    await putCacheEntry(env.DB, {
      namespace: "default",
      key: E_AXIS_STATE_KEY,
      value: { started_at: "2026-06-01T00:00:00.000Z" },
      contentType: "application/json",
      tags: ["lmc5", "e-axis", "runtime-state"]
    });
    const disabledEnv: Env = {
      DB: env.DB,
      E_AXIS_SHADOW_DAYS: "7",
      E_AXIS_RANKING_ENABLED: "false"
    };
    const enabledEnv: Env = {
      DB: env.DB,
      E_AXIS_SHADOW_DAYS: "7",
      E_AXIS_RANKING_ENABLED: "true"
    };
    await expect(readShadowState(disabledEnv, "default", Date.parse("2026-06-10T00:00:00.000Z")))
      .resolves.toMatchObject({ configured: true, inShadow: false, readyForPromotion: true, rankingEnabled: false });
    await expect(shouldApplyEAxisToRanking(disabledEnv, "default")).resolves.toBe(false);
    await expect(shouldApplyEAxisToRanking(enabledEnv, "default")).resolves.toBe(true);

    const baseline = await createMemory(env.DB, {
      namespace: "default",
      type: "rule",
      content: "relationship boundary",
      factKey: "relationship.rule.boundary_baseline",
      importance: 0.7,
      confidence: 0.8
    });
    const sensitive = await createMemory(env.DB, {
      namespace: "default",
      type: "rule",
      content: "relationship boundary",
      factKey: "relationship.rule.boundary",
      thread: "relationship.boundaries.safety",
      riskLevel: "high",
      tensionScore: 0.8,
      importance: 0.7,
      confidence: 0.8
    });
    const records: ScoredMemoryRecord[] = [
      { ...baseline, score: 0.65, keywordScore: 0.65 },
      { ...sensitive, score: 0.6, keywordScore: 0.6 }
    ];
    const input = {
      query: "relationship boundary",
      expandedQuery: "relationship boundary",
      limit: 2,
      observeTopK: 2,
      timeIntent: { mode: "none" as const, terms: [] }
    };

    const shadow = mergeSearchResults(null, records, {
      ...input,
      applyEAxis: await shouldApplyEAxisToRanking(disabledEnv, "default")
    });
    const active = mergeSearchResults(null, records, {
      ...input,
      applyEAxis: await shouldApplyEAxisToRanking(enabledEnv, "default")
    });
    expect(shadow.records[0].id).toBe(baseline.id);
    expect(shadow.eAxis.mode).toBe("shadow");
    expect(active.records[0].id).toBe(sensitive.id);
    expect(active.eAxis.mode).toBe("active");
  });
});

describe("five-axis Worker guards", () => {
  it("stops claiming a permanently failing axis after the bounded attempt count", async () => {
    const key: FiveAxisRunKey = {
      namespace: "default",
      memoryId: "runtime-attempt-cap",
      memoryRevision: 1,
      axis: "Y"
    };
    for (let attempt = 1; attempt <= MAX_FIVE_AXIS_RUN_ATTEMPTS; attempt += 1) {
      const token = await claimFiveAxisRun(env.DB, key);
      expect(token).toBeTruthy();
      await expect(failFiveAxisRun(env.DB, key, token!, new Error(`failure-${attempt}`))).resolves.toBe(true);
    }
    await expect(claimFiveAxisRun(env.DB, key)).resolves.toBeNull();
    await expect(env.DB.prepare(
      `SELECT status, attempts FROM memory_five_axis_runs
       WHERE namespace = ? AND memory_id = ? AND memory_revision = ? AND axis = ?`
    ).bind(key.namespace, key.memoryId, key.memoryRevision, key.axis).first())
      .resolves.toMatchObject({ status: "failed", attempts: MAX_FIVE_AXIS_RUN_ATTEMPTS });
  });

  it("does not route an unknown candidate action into M approval", async () => {
    const externalKey = "runtime:unknown-operational-action";
    await upsertMemoryCandidate(env.DB, "default", {
      externalKey,
      dreamDate: "2026-07-17",
      action: "unknown_operational_action",
      payload: {},
      sourceChunkIds: [],
      status: "pending"
    });
    const candidate = await env.DB.prepare(
      "SELECT id FROM memory_candidates WHERE namespace = 'default' AND external_key = ?"
    ).bind(externalKey).first<{ id: string }>();
    const form = new FormData();
    form.set("id", candidate!.id);

    await expect(approveOperationalReviewCandidate(env, form)).resolves.toBeNull();
    await expect(env.DB.prepare(
      "SELECT status FROM memory_candidates WHERE namespace = 'default' AND id = ?"
    ).bind(candidate!.id).first()).resolves.toMatchObject({ status: "pending" });
  });
});
