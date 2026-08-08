import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { ADMIN_BOARD_ROUTES } from "../src/api/adminBoard/routes";
import { createMemory } from "../src/db/memories";
import type { Env, MemoryRecord } from "../src/types";

const ORIGIN = "https://dream-batch.test";
const ADMIN_PASSWORD = "dream-batch-admin";
const ADMIN_AUTHORIZATION = `Basic ${btoa(`admin:${ADMIN_PASSWORD}`)}`;

const runtimeEnv = {
  DB: env.DB,
  DEBUG_API_KEY: "dream-batch-key",
  ADMIN_PASSWORD,
  DREAM_NAMESPACE: "default",
  ENABLE_FIVE_AXIS: "true"
} as Env;

function batchRequest(decision: "approve" | "reject", ids: string[]): Request {
  const body = new URLSearchParams();
  body.set("decision", decision);
  for (const id of ids) body.append("id", id);
  return new Request(`${ORIGIN}${ADMIN_BOARD_ROUTES.batchDreamReview.path}`, {
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

async function createTarget(label: string): Promise<MemoryRecord> {
  return createMemory(env.DB, {
    namespace: "default",
    type: "note",
    content: `${label} ${crypto.randomUUID()}`,
    importance: 0.3,
    confidence: 0.8,
    status: "active",
    source: "dream-batch-test"
  });
}

async function createUpdateProposal(
  target: MemoryRecord,
  patchedContent: string,
  overrides?: { status?: string; tags?: string[] }
): Promise<MemoryRecord> {
  return createMemory(env.DB, {
    namespace: "default",
    type: "dream_review",
    content: `Review a proposed update for ${target.id}.`,
    summary: JSON.stringify({
      kind: "dream_review",
      action: "update",
      target_id: target.id,
      patch: { content: patchedContent },
      reason: "batch test"
    }),
    status: overrides?.status ?? "active",
    tags: overrides?.tags ?? ["pending-review"],
    source: "dream-batch-test"
  });
}

async function memoryState(id: string) {
  return env.DB.prepare(
    "SELECT status, tags, content FROM memories WHERE namespace = 'default' AND id = ?"
  ).bind(id).first<{ status: string; tags: string | null; content: string }>();
}

describe("dream review batch review", () => {
  it("batch-approves two update proposals end to end", async () => {
    const targetA = await createTarget("batch approve a");
    const targetB = await createTarget("batch approve b");
    const proposalA = await createUpdateProposal(targetA, `approved content ${crypto.randomUUID()}`);
    const proposalB = await createUpdateProposal(targetB, `approved content ${crypto.randomUUID()}`);

    const response = await worker.fetch(
      batchRequest("approve", [proposalA.id, proposalB.id]),
      runtimeEnv,
      createExecutionContext()
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("notice=dream-batch-approved");
    await expect(memoryState(proposalA.id)).resolves.toMatchObject({ status: "superseded" });
    await expect(memoryState(proposalB.id)).resolves.toMatchObject({ status: "superseded" });
    const afterA = await memoryState(targetA.id);
    const afterB = await memoryState(targetB.id);
    expect(afterA?.content).toContain("approved content");
    expect(afterB?.content).toContain("approved content");
  });

  it("reports partial when one proposal is already resolved", async () => {
    const target = await createTarget("batch partial");
    const fresh = await createUpdateProposal(target, `partial content ${crypto.randomUUID()}`);
    const staleTarget = await createTarget("batch partial stale");
    const stale = await createUpdateProposal(staleTarget, "stale", {
      status: "superseded",
      tags: ["approved"]
    });

    const response = await worker.fetch(
      batchRequest("approve", [fresh.id, stale.id]),
      runtimeEnv,
      createExecutionContext()
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("notice=dream-batch-partial");
    await expect(memoryState(fresh.id)).resolves.toMatchObject({ status: "superseded" });
    const afterTarget = await memoryState(target.id);
    expect(afterTarget?.content).toContain("partial content");
  });

  it("batch-rejects proposals without touching targets", async () => {
    const targetA = await createTarget("batch reject a");
    const targetB = await createTarget("batch reject b");
    const proposalA = await createUpdateProposal(targetA, "must not land a");
    const proposalB = await createUpdateProposal(targetB, "must not land b");

    const response = await worker.fetch(
      batchRequest("reject", [proposalA.id, proposalB.id]),
      runtimeEnv,
      createExecutionContext()
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("notice=dream-batch-rejected");
    for (const proposal of [proposalA, proposalB]) {
      const state = await memoryState(proposal.id);
      expect(state?.status).toBe("superseded");
      expect(state?.tags).toContain("rejected");
    }
    const afterA = await memoryState(targetA.id);
    const afterB = await memoryState(targetB.id);
    expect(afterA?.content).toContain("batch reject a");
    expect(afterB?.content).toContain("batch reject b");
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

  it("refuses an oversized batch before any write", async () => {
    const target = await createTarget("batch oversize");
    const proposal = await createUpdateProposal(target, "oversize must not land");
    const ids = [proposal.id, ...Array.from({ length: 24 }, () => `mem_${crypto.randomUUID()}`)];

    const response = await worker.fetch(
      batchRequest("approve", ids),
      runtimeEnv,
      createExecutionContext()
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("notice=error");
    await expect(memoryState(proposal.id)).resolves.toMatchObject({ status: "active" });
  });
});
