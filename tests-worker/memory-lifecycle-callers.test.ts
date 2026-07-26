import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { ADMIN_BOARD_ROUTES } from "../src/api/adminBoard/routes";
import { handleMcp } from "../src/api/mcp";
import { upsertMemoryCandidate } from "../src/db/memoryCandidates";
import { createMemory } from "../src/db/memories";
import type { Env, MemoryRecord } from "../src/types";

const ORIGIN = "https://memory-lifecycle.test";
const API_KEY = "memory-lifecycle-key";
const ADMIN_PASSWORD = "memory-lifecycle-admin";
const ADMIN_AUTHORIZATION = `Basic ${btoa(`admin:${ADMIN_PASSWORD}`)}`;

const runtimeEnv = {
  DB: env.DB,
  DEBUG_API_KEY: API_KEY,
  ADMIN_PASSWORD,
  DREAM_NAMESPACE: "default",
  ENABLE_FIVE_AXIS: "true"
} as Env;

function vectorRuntime(): {
  runtime: Env;
  deletedIds: string[];
  upsertedIds: string[];
  fetchSpy: ReturnType<typeof vi.spyOn>;
} {
  const deletedIds: string[] = [];
  const upsertedIds: string[] = [];
  const vectorize = {
    deleteByIds: async (ids: string[]) => {
      deletedIds.push(...ids);
      return { mutationId: "delete-lifecycle" };
    },
    upsert: async (vectors: VectorizeVector[]) => {
      upsertedIds.push(...vectors.map((vector) => vector.id));
      return { mutationId: "upsert-lifecycle" };
    }
  };
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
    data: [{ embedding: [0.1, 0.2, 0.3] }]
  }), { status: 200, headers: { "content-type": "application/json" } }));
  return {
    runtime: {
      ...runtimeEnv,
      EMBEDDING_MODEL: "lifecycle-test-embedding",
      UPSTREAM_BASE_URL: "https://lifecycle-embedding.test/v1",
      UPSTREAM_API_KEY: "lifecycle-embedding-key",
      VECTORIZE: vectorize as Env["VECTORIZE"]
    },
    deletedIds,
    upsertedIds,
    fetchSpy
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function createEligibleMemory(label: string): Promise<MemoryRecord> {
  return createMemory(env.DB, {
    namespace: "default",
    type: "note",
    content: `${label} ${crypto.randomUUID()}`,
    importance: 0.3,
    confidence: 0.8,
    status: "active",
    source: "lifecycle-caller-test"
  });
}

async function seedRelation(memory: MemoryRecord, label: string): Promise<void> {
  const peer = await createEligibleMemory(`${label} peer`);
  await env.DB.prepare(
    `INSERT INTO memory_relations (
       id, namespace, source_memory_id, target_memory_id,
       relation_type, strength, reason, created_at
     ) VALUES (?, 'default', ?, ?, 'supports', 0.8, 'caller contract', ?)`
  ).bind(`rel_${crypto.randomUUID()}`, memory.id, peer.id, new Date().toISOString()).run();
}

async function relationCount(memoryId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM memory_relations
     WHERE namespace = 'default' AND (source_memory_id = ? OR target_memory_id = ?)`
  ).bind(memoryId, memoryId).first<{ count: number }>();
  return row?.count ?? 0;
}

async function vectorState(memoryId: string): Promise<{
  vector_sync_status: string | null;
  vector_synced: number;
}> {
  const row = await env.DB.prepare(
    `SELECT vector_sync_status, vector_synced
     FROM memories WHERE namespace = 'default' AND id = ?`
  ).bind(memoryId).first<{
    vector_sync_status: string | null;
    vector_synced: number;
  }>();
  if (!row) throw new Error(`missing vector state for ${memoryId}`);
  return row;
}

async function deprojection(memoryId: string): Promise<{
  source: string;
  reason: string;
  candidate_id: string | null;
  invariants_verified: number;
}> {
  const operation = await env.DB.prepare(
    `SELECT source, reason, candidate_id, invariants_verified
     FROM memory_deprojections
     WHERE namespace = 'default' AND memory_id = ?
     ORDER BY created_at DESC LIMIT 1`
  ).bind(memoryId).first<{
    source: string;
    reason: string;
    candidate_id: string | null;
    invariants_verified: number;
  }>();
  if (!operation) throw new Error(`missing deprojection for ${memoryId}`);
  return operation;
}

function apiRequest(path: string, method: "PATCH" | "DELETE", body?: Record<string, unknown>): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${API_KEY}`,
      ...(body ? { "content-type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}

function adminRequest(path: string, fields: Record<string, string>): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      authorization: ADMIN_AUTHORIZATION,
      origin: ORIGIN,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(fields)
  });
}

function mcpRequest(name: "update_memory" | "delete_memory", args: Record<string, unknown>): Request {
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
      "mcp-session-id": `memory-lifecycle-${crypto.randomUUID()}`
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args }
    })
  });
}

describe("inactive memory lifecycle callers", () => {
  it("routes Memory API DELETE through the deprojection contract", async () => {
    const memory = await createEligibleMemory("api delete");
    await seedRelation(memory, "api delete");

    const response = await worker.fetch(
      apiRequest(`/v1/memories/${memory.id}`, "DELETE"),
      runtimeEnv,
      createExecutionContext()
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { id: memory.id, status: "deleted", active_fact: false }
    });
    await expect(relationCount(memory.id)).resolves.toBe(0);
    await expect(deprojection(memory.id)).resolves.toMatchObject({
      source: "memory_api",
      reason: "memory_api_delete",
      candidate_id: null,
      invariants_verified: 1
    });
  });

  it("routes eligibility-changing Memory API PATCH through deprojection", async () => {
    const memory = await createEligibleMemory("api type patch");
    await seedRelation(memory, "api type patch");
    const vectors = vectorRuntime();

    const response = await worker.fetch(
      apiRequest(`/v1/memories/${memory.id}`, "PATCH", { type: "diary" }),
      vectors.runtime,
      createExecutionContext()
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { id: memory.id, type: "diary", status: "active" }
    });
    await expect(relationCount(memory.id)).resolves.toBe(0);
    await expect(deprojection(memory.id)).resolves.toMatchObject({
      source: "memory_api",
      reason: "memory_api_patch",
      invariants_verified: 1
    });
    expect(vectors.deletedIds).toContain(memory.vector_id);
    expect(vectors.upsertedIds).not.toContain(memory.vector_id);
    expect(vectors.fetchSpy).not.toHaveBeenCalled();
    await expect(vectorState(memory.id)).resolves.toEqual({
      vector_sync_status: "deleted",
      vector_synced: 0
    });
  });

  it("deletes the vector when active_fact makes an active memory ineligible", async () => {
    const memory = await createEligibleMemory("api active fact patch");
    await seedRelation(memory, "api active fact patch");
    const vectors = vectorRuntime();

    const response = await worker.fetch(
      apiRequest(`/v1/memories/${memory.id}`, "PATCH", { active_fact: false }),
      vectors.runtime,
      createExecutionContext()
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { id: memory.id, status: "active", active_fact: false }
    });
    await expect(relationCount(memory.id)).resolves.toBe(0);
    await expect(deprojection(memory.id)).resolves.toMatchObject({
      source: "memory_api",
      reason: "memory_api_patch",
      invariants_verified: 1
    });
    expect(vectors.deletedIds).toContain(memory.vector_id);
    expect(vectors.upsertedIds).not.toContain(memory.vector_id);
    expect(vectors.fetchSpy).not.toHaveBeenCalled();
    await expect(vectorState(memory.id)).resolves.toEqual({
      vector_sync_status: "deleted",
      vector_synced: 0
    });
  });

  it("keeps ordinary eligible updates on the vector upsert path", async () => {
    const memory = await createEligibleMemory("api content patch");
    const vectors = vectorRuntime();
    const updatedContent = `updated eligible content ${crypto.randomUUID()}`;

    const response = await worker.fetch(
      apiRequest(`/v1/memories/${memory.id}`, "PATCH", { content: updatedContent }),
      vectors.runtime,
      createExecutionContext()
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { id: memory.id, content: updatedContent, status: "active", active_fact: true }
    });
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count FROM memory_deprojections
       WHERE namespace = 'default' AND memory_id = ?`
    ).bind(memory.id).first()).resolves.toMatchObject({ count: 0 });
    expect(vectors.upsertedIds).toContain(memory.vector_id);
    expect(vectors.deletedIds).not.toContain(memory.vector_id);
    expect(vectors.fetchSpy).toHaveBeenCalledTimes(1);
    await expect(vectorState(memory.id)).resolves.toEqual({
      vector_sync_status: "synced",
      vector_synced: 1
    });
  });

  it("does not upsert an active dream_review during an ordinary lifecycle update", async () => {
    const proposal = await createMemory(env.DB, {
      namespace: "default",
      type: "dream_review",
      content: "Active review proposal before edit.",
      status: "active",
      source: "lifecycle-caller-test"
    });
    const vectors = vectorRuntime();

    const response = await worker.fetch(
      apiRequest(`/v1/memories/${proposal.id}`, "PATCH", {
        content: "Active review proposal after edit."
      }),
      vectors.runtime,
      createExecutionContext()
    );

    expect(response.status).toBe(200);
    expect(vectors.deletedIds).toContain(proposal.vector_id);
    expect(vectors.upsertedIds).not.toContain(proposal.vector_id);
    expect(vectors.fetchSpy).not.toHaveBeenCalled();
    await expect(vectorState(proposal.id)).resolves.toEqual({
      vector_sync_status: "deleted",
      vector_synced: 0
    });
  });

  it("routes MCP update_memory eligibility changes through deprojection", async () => {
    const memory = await createEligibleMemory("mcp type update");
    await seedRelation(memory, "mcp type update");

    const response = await handleMcp(
      mcpRequest("update_memory", { id: memory.id, type: "diary" }),
      { ...runtimeEnv, MEMORY_MCP_API_KEY: API_KEY } as Env,
      createExecutionContext()
    );

    expect(response.status).toBe(200);
    await expect(relationCount(memory.id)).resolves.toBe(0);
    await expect(deprojection(memory.id)).resolves.toMatchObject({
      source: "memory_api",
      reason: "mcp_memory_update",
      candidate_id: null,
      invariants_verified: 1
    });
  });

  it("routes MCP delete_memory through deprojection", async () => {
    const memory = await createEligibleMemory("mcp delete");
    await seedRelation(memory, "mcp delete");

    const response = await handleMcp(
      mcpRequest("delete_memory", { id: memory.id }),
      { ...runtimeEnv, MEMORY_MCP_API_KEY: API_KEY } as Env,
      createExecutionContext()
    );

    expect(response.status).toBe(200);
    await expect(relationCount(memory.id)).resolves.toBe(0);
    await expect(deprojection(memory.id)).resolves.toMatchObject({
      source: "memory_api",
      reason: "mcp_memory_delete",
      candidate_id: null,
      invariants_verified: 1
    });
  });

  it("routes Admin delete through the same standalone contract", async () => {
    const memory = await createEligibleMemory("admin delete");
    await seedRelation(memory, "admin delete");

    const response = await worker.fetch(
      adminRequest(ADMIN_BOARD_ROUTES.delete.path, { id: memory.id }),
      runtimeEnv,
      createExecutionContext()
    );

    expect(response.status).toBe(303);
    await expect(relationCount(memory.id)).resolves.toBe(0);
    await expect(deprojection(memory.id)).resolves.toMatchObject({
      source: "admin_board",
      reason: "admin_board_delete",
      candidate_id: null,
      invariants_verified: 1
    });
  });

  it("approves a Dream delete candidate in the same batch as deprojection", async () => {
    const memory = await createEligibleMemory("dream candidate delete");
    await seedRelation(memory, "dream candidate delete");
    const externalKey = `dream-delete:${crypto.randomUUID()}`;
    await upsertMemoryCandidate(env.DB, "default", {
      externalKey,
      dreamDate: "2026-07-23",
      action: "delete",
      targetId: memory.id,
      payload: {},
      sourceChunkIds: [1],
      sourceChunks: [{ summary: "A bounded source summary supporting this deletion review." }],
      status: "pending"
    });
    const candidate = await env.DB.prepare(
      "SELECT id FROM memory_candidates WHERE namespace = 'default' AND external_key = ?"
    ).bind(externalKey).first<{ id: string }>();

    const response = await worker.fetch(
      adminRequest(ADMIN_BOARD_ROUTES.approveCandidate.path, { id: candidate!.id }),
      runtimeEnv,
      createExecutionContext()
    );

    expect(response.status).toBe(303);
    await expect(env.DB.prepare(
      "SELECT status FROM memory_candidates WHERE namespace = 'default' AND id = ?"
    ).bind(candidate!.id).first()).resolves.toMatchObject({ status: "approved" });
    await expect(relationCount(memory.id)).resolves.toBe(0);
    await expect(deprojection(memory.id)).resolves.toMatchObject({
      source: "dream_candidate",
      reason: "dream_candidate_delete",
      candidate_id: candidate!.id,
      invariants_verified: 1
    });
  });

  it("routes Dream review delete through deprojection before resolving the proposal", async () => {
    const memory = await createEligibleMemory("dream review delete");
    await seedRelation(memory, "dream review delete");
    const proposal = await createMemory(env.DB, {
      namespace: "default",
      type: "dream_review",
      content: "Review a proposed memory deletion.",
      summary: JSON.stringify({
        kind: "dream_review",
        action: "delete",
        target_id: memory.id,
        reason: "stale memory"
      }),
      status: "active",
      tags: ["pending-review"],
      source: "lifecycle-caller-test"
    });

    const response = await worker.fetch(
      adminRequest(ADMIN_BOARD_ROUTES.approveDreamReview.path, { id: proposal.id }),
      runtimeEnv,
      createExecutionContext()
    );

    expect(response.status).toBe(303);
    await expect(env.DB.prepare(
      "SELECT status FROM memories WHERE namespace = 'default' AND id = ?"
    ).bind(proposal.id).first()).resolves.toMatchObject({ status: "superseded" });
    await expect(relationCount(memory.id)).resolves.toBe(0);
    await expect(deprojection(memory.id)).resolves.toMatchObject({
      source: "dream_review",
      reason: "dream_review_delete",
      candidate_id: null,
      invariants_verified: 1
    });
  });

  it("atomically resolves a Dream update that makes the target ineligible", async () => {
    const memory = await createEligibleMemory("dream review type update");
    await seedRelation(memory, "dream review type update");
    const vectors = vectorRuntime();
    const proposal = await createMemory(env.DB, {
      namespace: "default",
      type: "dream_review",
      content: "Review a proposed memory type update.",
      summary: JSON.stringify({
        kind: "dream_review",
        action: "update",
        target_id: memory.id,
        patch: { type: "diary" }
      }),
      status: "active",
      tags: ["pending-review"],
      source: "lifecycle-caller-test"
    });

    const response = await worker.fetch(
      adminRequest(ADMIN_BOARD_ROUTES.approveDreamReview.path, { id: proposal.id }),
      vectors.runtime,
      createExecutionContext()
    );

    expect(response.status).toBe(303);
    await expect(env.DB.prepare(
      "SELECT type, status FROM memories WHERE namespace = 'default' AND id = ?"
    ).bind(memory.id).first()).resolves.toMatchObject({ type: "diary", status: "active" });
    await expect(env.DB.prepare(
      "SELECT status FROM memories WHERE namespace = 'default' AND id = ?"
    ).bind(proposal.id).first()).resolves.toMatchObject({ status: "superseded" });
    await expect(relationCount(memory.id)).resolves.toBe(0);
    await expect(deprojection(memory.id)).resolves.toMatchObject({
      source: "dream_review",
      reason: "dream_review_update",
      candidate_id: null,
      invariants_verified: 1
    });
    expect(vectors.deletedIds).toContain(memory.vector_id);
    expect(vectors.upsertedIds).not.toContain(memory.vector_id);
    expect(vectors.fetchSpy).not.toHaveBeenCalled();
    await expect(vectorState(memory.id)).resolves.toEqual({
      vector_sync_status: "deleted",
      vector_synced: 0
    });
  });

  it("atomically creates a Dream replacement while deprojecting the superseded target", async () => {
    const memory = await createEligibleMemory("dream review supersede");
    await seedRelation(memory, "dream review supersede");
    const replacementContent = `replacement ${crypto.randomUUID()}`;
    const proposal = await createMemory(env.DB, {
      namespace: "default",
      type: "dream_review",
      content: "Review a proposed memory replacement.",
      summary: JSON.stringify({
        kind: "dream_review",
        action: "supersede",
        target_id: memory.id,
        replacement: {
          type: "note",
          content: replacementContent,
          importance: 0.7,
          confidence: 0.9,
          tags: ["replacement"]
        }
      }),
      status: "active",
      tags: ["pending-review"],
      source: "lifecycle-caller-test"
    });

    const response = await worker.fetch(
      adminRequest(ADMIN_BOARD_ROUTES.approveDreamReview.path, { id: proposal.id }),
      runtimeEnv,
      createExecutionContext()
    );

    expect(response.status).toBe(303);
    await expect(env.DB.prepare(
      "SELECT status FROM memories WHERE namespace = 'default' AND id = ?"
    ).bind(memory.id).first()).resolves.toMatchObject({ status: "superseded" });
    await expect(env.DB.prepare(
      "SELECT status FROM memories WHERE namespace = 'default' AND id = ?"
    ).bind(proposal.id).first()).resolves.toMatchObject({ status: "superseded" });
    await expect(env.DB.prepare(
      "SELECT status FROM memories WHERE namespace = 'default' AND content = ?"
    ).bind(replacementContent).first()).resolves.toMatchObject({ status: "active" });
    await expect(relationCount(memory.id)).resolves.toBe(0);
    await expect(deprojection(memory.id)).resolves.toMatchObject({
      source: "dream_review",
      reason: "dream_review_supersede",
      invariants_verified: 1
    });
  });

  it("rolls back Dream target deprojection when proposal resolution is silently skipped", async () => {
    const memory = await createEligibleMemory("dream review rollback");
    await seedRelation(memory, "dream review rollback");
    const proposal = await createMemory(env.DB, {
      namespace: "default",
      type: "dream_review",
      content: "Review a deletion with a forced proposal conflict.",
      summary: JSON.stringify({
        kind: "dream_review",
        action: "delete",
        target_id: memory.id
      }),
      status: "active",
      tags: ["pending-review"],
      source: "lifecycle-caller-test"
    });
    await env.DB.prepare(
      `CREATE TRIGGER ignore_dream_proposal_resolution
       BEFORE UPDATE OF status ON memories
       WHEN OLD.id = '${proposal.id}'
       BEGIN
         SELECT RAISE(IGNORE);
       END`
    ).run();

    try {
      const response = await worker.fetch(
        adminRequest(ADMIN_BOARD_ROUTES.approveDreamReview.path, { id: proposal.id }),
        runtimeEnv,
        createExecutionContext()
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toContain("notice=error");
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS ignore_dream_proposal_resolution").run();
    }

    await expect(env.DB.prepare(
      "SELECT status FROM memories WHERE namespace = 'default' AND id = ?"
    ).bind(memory.id).first()).resolves.toMatchObject({ status: "active" });
    await expect(env.DB.prepare(
      "SELECT status FROM memories WHERE namespace = 'default' AND id = ?"
    ).bind(proposal.id).first()).resolves.toMatchObject({ status: "active" });
    await expect(relationCount(memory.id)).resolves.toBe(1);
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM memory_deprojections WHERE namespace = 'default' AND memory_id = ?"
    ).bind(memory.id).first()).resolves.toMatchObject({ count: 0 });
  });
});
