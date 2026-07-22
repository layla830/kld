import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleRecall } from "../src/api/recall";
import { createMemory } from "../src/db/memories";
import { TIMELINE_DAY_CONTENT_TAG } from "../src/recall/outputPolicy";
import type { Env, MemoryApiRecord } from "../src/types";

function executionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {}
  } as unknown as ExecutionContext;
}

async function recall(namespace: string, prompt: string): Promise<MemoryApiRecord[]> {
  const response = await handleRecall(new Request("https://worker.test/v1/memories/recall", {
    method: "POST",
    headers: {
      authorization: "Bearer timeline-recall-key",
      "content-type": "application/json"
    },
    body: JSON.stringify({ namespace, prompt, top_k: 5, force: true })
  }), {
    DB: env.DB,
    DEBUG_API_KEY: "timeline-recall-key",
    ENABLE_MEMORY_FILTER: "false"
  } as Env, executionContext());
  expect(response.status).toBe(200);
  return ((await response.json()) as { memories: MemoryApiRecord[] }).memories;
}

describe("timeline day recall ownership", () => {
  it("recalls reviewed event summaries while rejecting unowned date shells", async () => {
    const namespace = `timeline-recall-${crypto.randomUUID()}`;
    const summary = await createMemory(env.DB, {
      namespace,
      type: "timeline_day",
      content: "timeline orchid remembered a concrete evening event",
      activeFact: true,
      tags: ["timeline", "date:2026-07-14", TIMELINE_DAY_CONTENT_TAG]
    });
    const shell = await createMemory(env.DB, {
      namespace,
      type: "timeline_day",
      content: "timeline cobalt date shell only",
      activeFact: true,
      tags: ["timeline", "date:2026-07-15", "timeline_day_fallback:verbatim"]
    });

    await expect(recall(namespace, "timeline orchid concrete evening event"))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: summary.id })]));
    await expect(recall(namespace, "timeline cobalt date shell only"))
      .resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ id: shell.id })]));
  });
});
