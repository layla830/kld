import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { ADMIN_BOARD_ROUTES } from "../src/api/adminBoard/routes";
import { resolveMemoryCandidate, upsertMemoryCandidate } from "../src/db/memoryCandidates";
import type { Env } from "../src/types";

const ORIGIN = "https://candidate-batch.test";
const ADMIN_PASSWORD = "candidate-batch-admin";
const ADMIN_AUTHORIZATION = `Basic ${btoa(`admin:${ADMIN_PASSWORD}`)}`;

const runtimeEnv = {
  DB: env.DB,
  ADMIN_PASSWORD,
  DREAM_NAMESPACE: "default"
} as Env;

function batchRequest(decision: "approve" | "reject" | "override", ids: string[]): Request {
  const body = new URLSearchParams();
  body.set("decision", decision);
  for (const id of ids) body.append("ids", id);
  return new Request(`${ORIGIN}${ADMIN_BOARD_ROUTES.batchReviewCandidates.path}`, {
    method: "POST",
    headers: {
      authorization: ADMIN_AUTHORIZATION,
      origin: ORIGIN,
      referer: `${ORIGIN}/admin/memories?tab=review`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
}

async function queueAddCandidate(
  content: string,
  status: "pending" | "needs_subject_review" | "deferred_relation" = "pending"
): Promise<string> {
  const externalKey = `candidate-batch:${crypto.randomUUID()}`;
  await upsertMemoryCandidate(env.DB, "default", {
    externalKey,
    dreamDate: "2026-08-08",
    action: "add",
    payload: { type: "note", content },
    sourceChunkIds: [],
    status
  });
  const row = await env.DB.prepare(
    "SELECT id FROM memory_candidates WHERE namespace = 'default' AND external_key = ?"
  ).bind(externalKey).first<{ id: string }>();
  return row!.id;
}

async function candidateState(id: string) {
  return env.DB.prepare(
    "SELECT status, result_memory_id FROM memory_candidates WHERE namespace = 'default' AND id = ?"
  ).bind(id).first<{ status: string; result_memory_id: string | null }>();
}

describe("candidate batch review", () => {
  it("batch-approves two add candidates end to end", async () => {
    const contentA = `batch approve a ${crypto.randomUUID()}`;
    const contentB = `batch approve b ${crypto.randomUUID()}`;
    const idA = await queueAddCandidate(contentA);
    const idB = await queueAddCandidate(contentB);

    const response = await worker.fetch(
      batchRequest("approve", [idA, idB]),
      runtimeEnv,
      createExecutionContext()
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("notice=candidate-batch-approved");
    for (const [id, content] of [[idA, contentA], [idB, contentB]] as const) {
      const state = await candidateState(id);
      expect(state?.status).toBe("approved");
      expect(state?.result_memory_id).toBeTruthy();
      const memory = await env.DB.prepare(
        "SELECT status, content FROM memories WHERE namespace = 'default' AND id = ?"
      ).bind(state!.result_memory_id).first<{ status: string; content: string }>();
      expect(memory?.status).toBe("active");
      expect(memory?.content).toBe(content);
    }
  });

  it("reports partial when one candidate is already resolved", async () => {
    const content = `batch partial ${crypto.randomUUID()}`;
    const fresh = await queueAddCandidate(content);
    const stale = await queueAddCandidate(`batch partial stale ${crypto.randomUUID()}`);
    await resolveMemoryCandidate(env.DB, "default", stale, "rejected");

    const response = await worker.fetch(
      batchRequest("approve", [fresh, stale]),
      runtimeEnv,
      createExecutionContext()
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("notice=candidate-batch-partial");
    await expect(candidateState(fresh)).resolves.toMatchObject({ status: "approved" });
    await expect(candidateState(stale)).resolves.toMatchObject({ status: "rejected" });
  });

  it("batch-rejects candidates without creating memories", async () => {
    const idA = await queueAddCandidate(`batch reject a ${crypto.randomUUID()}`);
    const idB = await queueAddCandidate(`batch reject b ${crypto.randomUUID()}`);

    const response = await worker.fetch(
      batchRequest("reject", [idA, idB]),
      runtimeEnv,
      createExecutionContext()
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("notice=candidate-batch-rejected");
    for (const id of [idA, idB]) {
      await expect(candidateState(id)).resolves.toMatchObject({
        status: "rejected",
        result_memory_id: null
      });
    }
  });

  it("override-approves validation-blocked candidates with recorded override", async () => {
    const contentA = `batch override a ${crypto.randomUUID()}`;
    const contentB = `batch override b ${crypto.randomUUID()}`;
    const idA = await queueAddCandidate(contentA, "needs_subject_review");
    const idB = await queueAddCandidate(contentB, "needs_subject_review");

    const response = await worker.fetch(
      batchRequest("override", [idA, idB]),
      runtimeEnv,
      createExecutionContext()
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("notice=candidate-batch-overridden");
    for (const [id, content] of [[idA, contentA], [idB, contentB]] as const) {
      const state = await candidateState(id);
      expect(state?.status).toBe("approved");
      expect(state?.result_memory_id).toBeTruthy();
      const memory = await env.DB.prepare(
        "SELECT status, content FROM memories WHERE namespace = 'default' AND id = ?"
      ).bind(state!.result_memory_id).first<{ status: string; content: string }>();
      expect(memory?.status).toBe("active");
      expect(memory?.content).toBe(content);
    }
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count FROM memory_events
       WHERE namespace = 'default'
         AND event_type = 'memory_candidate_validation_override_applied'
         AND (payload_json LIKE ? OR payload_json LIKE ?)`
    ).bind(`%${idA}%`, `%${idB}%`).first<{ count: number }>()).resolves.toMatchObject({ count: 2 });
  });

  it("override skips candidates that cannot be overridden", async () => {
    const blocked = await queueAddCandidate(`batch override blocked ${crypto.randomUUID()}`, "needs_subject_review");
    const deferred = await queueAddCandidate(`batch override deferred ${crypto.randomUUID()}`, "deferred_relation");

    const response = await worker.fetch(
      batchRequest("override", [blocked, deferred]),
      runtimeEnv,
      createExecutionContext()
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("notice=candidate-batch-partial");
    await expect(candidateState(blocked)).resolves.toMatchObject({ status: "approved" });
    await expect(candidateState(deferred)).resolves.toMatchObject({ status: "deferred_relation" });
  });

  it("returns empty notice for an empty selection and writes nothing", async () => {
    const response = await worker.fetch(
      batchRequest("approve", []),
      runtimeEnv,
      createExecutionContext()
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("notice=empty");
  });
});
