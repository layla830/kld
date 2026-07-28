import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { approveOperationalReviewCandidate } from "../src/api/adminBoard/operationalReviewActions";
import { putCacheEntry } from "../src/db/cacheEntries";
import {
  claimFiveAxisRun,
  completeFiveAxisRun,
  failFiveAxisRun,
  FIVE_AXIS_RUN_ATTEMPTS_EXHAUSTED,
  getFiveAxisRun,
  MAX_FIVE_AXIS_RUN_ATTEMPTS,
  type FiveAxisRunKey
} from "../src/db/memoryFiveAxisRuns";
import { createMemory, updateMemory } from "../src/db/memories";
import { E_AXIS_STATE_KEY, readShadowState, shouldApplyEAxisToRanking } from "../src/memory/eAxis";
import type { ScoredMemoryRecord } from "../src/memory/vectorStore";
import { mergeSearchResults } from "../src/recall/fusion";
import type { Env } from "../src/types";

describe("E-axis Worker runtime state", () => {
  it("starts a fresh database shadow window at first use and keeps the first start time", async () => {
    const startedAt = "2026-07-17T09:30:00.000Z";
    await expect(env.DB.prepare(
      "SELECT id FROM cache_entries WHERE namespace = 'default' AND key = ?"
    ).bind(E_AXIS_STATE_KEY).first()).resolves.toBeNull();

    const runtimeEnv: Env = {
      DB: env.DB,
      E_AXIS_SHADOW_DAYS: "7",
      E_AXIS_RANKING_ENABLED: "true"
    };
    await expect(readShadowState(runtimeEnv, "default", Date.parse(startedAt))).resolves.toMatchObject({
      configured: true,
      startedAt,
      inShadow: true,
      readyForPromotion: false,
      daysElapsed: 0,
      daysRemaining: 7
    });
    await expect(readShadowState(runtimeEnv, "default", Date.parse("2026-07-18T09:30:00.000Z")))
      .resolves.toMatchObject({ startedAt, daysElapsed: 1, daysRemaining: 6 });
  });

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
  it("terminalizes a claimed run when its completion arrives after a newer revision", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "lesson",
      content: `Runtime completion supersession ${crypto.randomUUID()}`,
      status: "active"
    });
    const oldKey: FiveAxisRunKey = {
      namespace: memory.namespace,
      memoryId: memory.id,
      memoryRevision: memory.five_axis_revision ?? 1,
      axis: "E"
    };
    const oldToken = await claimFiveAxisRun(env.DB, oldKey);
    expect(oldToken).toBeTruthy();
    const updated = await updateMemory(env.DB, {
      namespace: memory.namespace,
      id: memory.id,
      patch: { thread: `runtime.supersession.${crypto.randomUUID()}` },
      expectedRevision: oldKey.memoryRevision
    });
    expect(updated?.five_axis_revision).toBe(oldKey.memoryRevision + 1);

    await expect(completeFiveAxisRun(
      env.DB,
      oldKey,
      oldToken!,
      "applied",
      { applied: 1 }
    )).resolves.toBe("superseded");
    const oldRun = await getFiveAxisRun(env.DB, oldKey);
    expect(oldRun).toMatchObject({
      status: "skipped",
      claim_token: null,
      lease_expires_at: null
    });
    expect(JSON.parse(String(oldRun?.result_json))).toEqual({
      reason: "superseded_by_newer_memory_revision",
      previous_revision: oldKey.memoryRevision,
      current_revision: oldKey.memoryRevision + 1
    });
  });

  it("terminalizes an abandoned older run when the same axis claims the current revision", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "lesson",
      content: `Runtime claim supersession ${crypto.randomUUID()}`,
      status: "active"
    });
    const oldKey: FiveAxisRunKey = {
      namespace: memory.namespace,
      memoryId: memory.id,
      memoryRevision: memory.five_axis_revision ?? 1,
      axis: "E"
    };
    const abandonedToken = await claimFiveAxisRun(env.DB, oldKey);
    expect(abandonedToken).toBeTruthy();
    const updated = await updateMemory(env.DB, {
      namespace: memory.namespace,
      id: memory.id,
      patch: { thread: `runtime.claim-cleanup.${crypto.randomUUID()}` },
      expectedRevision: oldKey.memoryRevision
    });
    const currentRevision = updated?.five_axis_revision ?? 0;
    const currentKey = { ...oldKey, memoryRevision: currentRevision };

    const currentToken = await claimFiveAxisRun(env.DB, currentKey);
    expect(currentToken).toBeTruthy();
    await expect(getFiveAxisRun(env.DB, oldKey)).resolves.toMatchObject({
      status: "skipped",
      claim_token: null,
      lease_expires_at: null
    });
    const oldResult = await getFiveAxisRun(env.DB, oldKey);
    expect(JSON.parse(String(oldResult?.result_json))).toEqual({
      reason: "superseded_by_newer_memory_revision",
      previous_revision: oldKey.memoryRevision,
      current_revision: currentRevision
    });
    await expect(failFiveAxisRun(
      env.DB,
      currentKey,
      currentToken!,
      new Error("test cleanup")
    )).resolves.toBe("failed");
  });

  it("terminalizes a clean failed older run when the same axis claims the current revision", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "lesson",
      content: `Runtime failed claim supersession ${crypto.randomUUID()}`,
      status: "active"
    });
    const oldKey: FiveAxisRunKey = {
      namespace: memory.namespace,
      memoryId: memory.id,
      memoryRevision: memory.five_axis_revision ?? 1,
      axis: "E"
    };
    const oldToken = await claimFiveAxisRun(env.DB, oldKey);
    expect(oldToken).toBeTruthy();
    await expect(failFiveAxisRun(
      env.DB,
      oldKey,
      oldToken!,
      new Error("old revision failure")
    )).resolves.toBe("failed");
    const updated = await updateMemory(env.DB, {
      namespace: memory.namespace,
      id: memory.id,
      patch: { thread: `runtime.failed-claim-cleanup.${crypto.randomUUID()}` },
      expectedRevision: oldKey.memoryRevision
    });
    const currentKey = {
      ...oldKey,
      memoryRevision: updated?.five_axis_revision ?? 0
    };

    const currentToken = await claimFiveAxisRun(env.DB, currentKey);
    expect(currentToken).toBeTruthy();
    await expect(getFiveAxisRun(env.DB, oldKey)).resolves.toMatchObject({
      status: "skipped",
      last_error: null,
      claim_token: null,
      lease_expires_at: null
    });
    await expect(failFiveAxisRun(
      env.DB,
      currentKey,
      currentToken!,
      new Error("test cleanup")
    )).resolves.toBe("failed");
  });

  it("does not swallow malformed ownership while claiming the current revision", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "lesson",
      content: `Runtime malformed ownership ${crypto.randomUUID()}`,
      status: "active"
    });
    const oldKey: FiveAxisRunKey = {
      namespace: memory.namespace,
      memoryId: memory.id,
      memoryRevision: memory.five_axis_revision ?? 1,
      axis: "E"
    };
    const oldToken = await claimFiveAxisRun(env.DB, oldKey);
    expect(oldToken).toBeTruthy();
    await env.DB.prepare(
      `UPDATE memory_five_axis_runs
       SET lease_expires_at = NULL
       WHERE namespace = ? AND memory_id = ? AND memory_revision = ? AND axis = ?`
    ).bind(oldKey.namespace, oldKey.memoryId, oldKey.memoryRevision, oldKey.axis).run();
    const updated = await updateMemory(env.DB, {
      namespace: memory.namespace,
      id: memory.id,
      patch: { thread: `runtime.malformed-ownership.${crypto.randomUUID()}` },
      expectedRevision: oldKey.memoryRevision
    });
    const currentKey = {
      ...oldKey,
      memoryRevision: updated?.five_axis_revision ?? 0
    };

    const currentToken = await claimFiveAxisRun(env.DB, currentKey);
    expect(currentToken).toBeTruthy();
    await expect(getFiveAxisRun(env.DB, oldKey)).resolves.toMatchObject({
      status: "running",
      claim_token: oldToken,
      lease_expires_at: null
    });
    await expect(failFiveAxisRun(
      env.DB,
      currentKey,
      currentToken!,
      new Error("test cleanup")
    )).resolves.toBe("failed");
  });

  it("terminalizes a late failure when the memory revision has advanced", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "lesson",
      content: `Runtime failure supersession ${crypto.randomUUID()}`,
      status: "active"
    });
    const oldKey: FiveAxisRunKey = {
      namespace: memory.namespace,
      memoryId: memory.id,
      memoryRevision: memory.five_axis_revision ?? 1,
      axis: "E"
    };
    const oldToken = await claimFiveAxisRun(env.DB, oldKey);
    expect(oldToken).toBeTruthy();
    await updateMemory(env.DB, {
      namespace: memory.namespace,
      id: memory.id,
      patch: { thread: `runtime.failure-cleanup.${crypto.randomUUID()}` },
      expectedRevision: oldKey.memoryRevision
    });

    await expect(failFiveAxisRun(
      env.DB,
      oldKey,
      oldToken!,
      new Error("late failure")
    )).resolves.toBe("superseded");
    await expect(getFiveAxisRun(env.DB, oldKey)).resolves.toMatchObject({
      status: "skipped",
      last_error: null,
      claim_token: null,
      lease_expires_at: null
    });
  });

  it("does not terminalize a future-revision run", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "lesson",
      content: `Runtime future revision ${crypto.randomUUID()}`,
      status: "active"
    });
    const futureKey: FiveAxisRunKey = {
      namespace: memory.namespace,
      memoryId: memory.id,
      memoryRevision: (memory.five_axis_revision ?? 1) + 1,
      axis: "E"
    };
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    await env.DB.prepare(
      `INSERT INTO memory_five_axis_runs (
         namespace, memory_id, memory_revision, axis, status, attempts,
         result_json, last_error, claim_token, lease_expires_at,
         started_at, completed_at, updated_at
       ) VALUES (?, ?, ?, ?, 'running', 1, NULL, NULL, ?, ?, ?, NULL, ?)`
    ).bind(
      futureKey.namespace,
      futureKey.memoryId,
      futureKey.memoryRevision,
      futureKey.axis,
      "future-claim",
      leaseExpiresAt,
      now,
      now
    ).run();

    await expect(completeFiveAxisRun(
      env.DB,
      futureKey,
      "future-claim",
      "applied",
      { future: true }
    )).resolves.toBe("not_owned");
    await expect(failFiveAxisRun(
      env.DB,
      futureKey,
      "future-claim",
      new Error("future failure")
    )).resolves.toBe("not_owned");
    await expect(getFiveAxisRun(env.DB, futureKey)).resolves.toMatchObject({
      status: "running",
      claim_token: "future-claim",
      lease_expires_at: leaseExpiresAt,
      result_json: null,
      last_error: null
    });
  });

  it("stops claiming a permanently failing axis after the bounded attempt count", async () => {
    const memory = await createMemory(env.DB, {
      namespace: "default",
      type: "lesson",
      content: `Runtime attempt cap ${crypto.randomUUID()}`,
      status: "active"
    });
    const key: FiveAxisRunKey = {
      namespace: "default",
      memoryId: memory.id,
      memoryRevision: 1,
      axis: "Y"
    };
    for (let attempt = 1; attempt <= MAX_FIVE_AXIS_RUN_ATTEMPTS; attempt += 1) {
      const token = await claimFiveAxisRun(env.DB, key);
      expect(token).toBeTruthy();
      await expect(failFiveAxisRun(env.DB, key, token!, new Error(`failure-${attempt}`)))
        .resolves.toBe("failed");
    }
    await expect(claimFiveAxisRun(env.DB, key)).resolves.toBeNull();
    const exhausted = await env.DB.prepare(
      `SELECT status, attempts, result_json, last_error FROM memory_five_axis_runs
       WHERE namespace = ? AND memory_id = ? AND memory_revision = ? AND axis = ?`
    ).bind(key.namespace, key.memoryId, key.memoryRevision, key.axis).first<{
      status: string;
      attempts: number;
      result_json: string;
      last_error: string | null;
    }>();
    expect(exhausted).toMatchObject({
      status: "skipped",
      attempts: MAX_FIVE_AXIS_RUN_ATTEMPTS,
      last_error: null
    });
    expect(JSON.parse(exhausted!.result_json)).toEqual({
      reason: FIVE_AXIS_RUN_ATTEMPTS_EXHAUSTED,
      attempts: MAX_FIVE_AXIS_RUN_ATTEMPTS,
      last_error: `failure-${MAX_FIVE_AXIS_RUN_ATTEMPTS}`
    });
  });

  it("does not route an unknown candidate action into M approval", async () => {
    const candidateId = `cand_unknown_${crypto.randomUUID()}`;
    const externalKey = `runtime:unknown-operational-action:${candidateId}`;
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO memory_candidates (
        id, namespace, external_key, dream_date, action, payload_json,
        source_chunk_ids_json, source_chunks_json, status, created_at, updated_at
      ) VALUES (?, 'default', ?, '2026-07-17', 'unknown_operational_action', '{}', '[]', '[]', 'pending', ?, ?)`
    ).bind(candidateId, externalKey, now, now).run();
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
