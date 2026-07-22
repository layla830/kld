import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleMemoryCandidates } from "../src/api/memoryCandidates";
import { createMemory } from "../src/db/memories";
import type { Env } from "../src/types";

describe("Dream candidate ingress accounting", () => {
  it("does not count a protected delete as both accepted and suppressed", async () => {
    const target = await createMemory(env.DB, {
      namespace: "default",
      type: "rule",
      content: `protected ingress target ${crypto.randomUUID()}`,
      importance: 1
    });
    const externalKey = `protected-ingress-delete:${crypto.randomUUID()}`;
    const response = await handleMemoryCandidates(new Request("https://worker.test/v1/memory-candidates", {
      method: "POST",
      headers: {
        authorization: "Bearer candidate-ingress-key",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        candidates: [{
          external_key: externalKey,
          dream_date: "2026-07-22",
          action: "delete",
          status: "pending",
          target_id: target.id,
          payload: {},
          source_chunk_ids: [1],
          source_chunks: [{
            summary: "This is a sufficiently detailed source summary for a protected deletion proposal."
          }]
        }]
      })
    }), {
      DB: env.DB,
      DEBUG_API_KEY: "candidate-ingress-key"
    } as Env);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      data: {
        received: 1,
        accepted: 0,
        stored: 0,
        suppressed: 1,
        namespace: "default"
      }
    });
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM memory_candidates WHERE namespace = 'default' AND external_key = ?"
    ).bind(externalKey).first()).resolves.toMatchObject({ count: 0 });
  });
});
