import { describe, expect, it } from "vitest";
import { hasNewerFiveAxisOutboxVersion } from "../src/db/memoryFiveAxisOutbox";
import { handleQueueMessage } from "../src/queue/consumer";
import { enqueuePendingFiveAxisProjections } from "../src/queue/producer";
import type { Env, MemoryFiveAxisProjectionQueueMessage } from "../src/types";

function inaccessibleDb(): D1Database {
  return new Proxy({} as D1Database, {
    get() { throw new Error("database should not be accessed"); }
  });
}

describe("five-axis outbox policy", () => {
  it("does not enqueue projections while five-axis processing is disabled", async () => {
    const env = { ENABLE_FIVE_AXIS: "false", DB: inaccessibleDb() } as Env;
    await expect(enqueuePendingFiveAxisProjections(env)).resolves.toBe(0);
  });

  it("does not consume an already queued projection while disabled", async () => {
    const message: MemoryFiveAxisProjectionQueueMessage = {
      type: "memory_five_axis_projection",
      namespace: "default",
      memoryId: "mem_1",
      memoryUpdatedAt: "2026-07-15T00:00:00.000Z",
      outboxId: 1,
      idempotencyKey: "five-axis:1:v1"
    };
    const env = { ENABLE_FIVE_AXIS: "false", DB: inaccessibleDb() } as Env;
    await expect(handleQueueMessage(message, env)).resolves.toBeUndefined();
  });

  it("detects a newer durable outbox version for the same memory", async () => {
    let bound: unknown[] = [];
    const db = {
      prepare(sql: string) {
        expect(sql).toContain("id > ?");
        return {
          bind(...values: unknown[]) {
            bound = values;
            return { first: async () => ({ id: 12 }) };
          }
        };
      }
    } as unknown as D1Database;

    await expect(hasNewerFiveAxisOutboxVersion(db, {
      id: 11,
      namespace: "default",
      memory_id: "mem_1"
    })).resolves.toBe(true);
    expect(bound).toEqual(["default", "mem_1", 11]);
  });
});
