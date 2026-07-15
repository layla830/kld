import { describe, expect, it } from "vitest";
import { hasNewerFiveAxisOutboxVersion } from "../src/db/memoryFiveAxisOutbox";
import { handleQueueMessage } from "../src/queue/consumer";
import { enqueuePendingFiveAxisProjections } from "../src/queue/producer";
import type { Env, MemoryFiveAxisProjectionQueueMessage, MemoryRecord } from "../src/types";

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
      memoryRevision: 1,
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

  it("skips an outbox job when the material memory revision has advanced", async () => {
    let completion: Record<string, unknown> | null = null;
    const outbox = {
      id: 11,
      namespace: "default",
      memory_id: "mem_1",
      memory_updated_at: "2026-07-15T00:00:00.000Z",
      memory_revision: 1,
      status: "queued"
    };
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            if (sql === "SELECT * FROM memory_five_axis_outbox WHERE id = ?") {
              return { first: async () => outbox };
            }
            if (sql === "SELECT * FROM memories WHERE namespace = ? AND id = ?") {
              return { first: async () => ({ id: "mem_1", status: "active", five_axis_revision: 2 }) };
            }
            if (sql.startsWith("UPDATE memory_five_axis_outbox")) {
              return {
                run: async () => {
                  completion = JSON.parse(String(values[3])) as Record<string, unknown>;
                  return { meta: { changes: 1 } };
                }
              };
            }
            throw new Error(`unexpected SQL: ${sql}`);
          }
        };
      }
    } as unknown as D1Database;
    const message: MemoryFiveAxisProjectionQueueMessage = {
      type: "memory_five_axis_projection",
      namespace: "default",
      memoryId: "mem_1",
      memoryUpdatedAt: outbox.memory_updated_at,
      memoryRevision: outbox.memory_revision,
      outboxId: outbox.id,
      idempotencyKey: "five-axis:11:r1"
    };

    await handleQueueMessage(message, { DB: db } as Env);

    expect(completion).toEqual({ reason: "memory_revision_mismatch", expected: 1, current: 2 });
  });

  it("keeps pre-migration queued messages compatible until the revision migration is applied", async () => {
    let completion: Record<string, unknown> | null = null;
    const outbox = {
      id: 11,
      namespace: "default",
      memory_id: "mem_1",
      memory_updated_at: "2026-07-15T00:00:00.000Z",
      status: "queued"
    };
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            if (sql === "SELECT * FROM memory_five_axis_outbox WHERE id = ?") {
              return { first: async () => outbox };
            }
            if (sql === "SELECT * FROM memories WHERE namespace = ? AND id = ?") {
              return { first: async () => ({ id: "mem_1", status: "active" }) };
            }
            if (sql.includes("id > ?")) {
              return { first: async () => ({ id: 12 }) };
            }
            if (sql.startsWith("UPDATE memory_five_axis_outbox")) {
              return {
                run: async () => {
                  completion = JSON.parse(String(values[3])) as Record<string, unknown>;
                  return { meta: { changes: 1 } };
                }
              };
            }
            throw new Error(`unexpected SQL: ${sql}`);
          }
        };
      }
    } as unknown as D1Database;
    const message: MemoryFiveAxisProjectionQueueMessage = {
      type: "memory_five_axis_projection",
      namespace: "default",
      memoryId: "mem_1",
      memoryUpdatedAt: outbox.memory_updated_at,
      outboxId: outbox.id,
      idempotencyKey: "five-axis:11:legacy"
    };

    await handleQueueMessage(message, { DB: db } as Env);

    expect(completion).toEqual({ reason: "superseded_by_newer_memory_version" });
  });

  it("cleans X ownership and skips projection when an eligible memory becomes a diary", async () => {
    let completion: Record<string, unknown> | null = null;
    let membershipDeleted = false;
    const relationBatches: Array<Array<{ sql: string; args: unknown[] }>> = [];
    const outbox = {
      id: 13,
      namespace: "default",
      memory_id: "mem_1",
      memory_updated_at: "2026-07-15T00:00:00.000Z",
      memory_revision: 2,
      status: "queued"
    };
    const excluded = {
      id: "mem_1",
      namespace: "default",
      type: "auto_diary",
      status: "active",
      thread: "kld",
      fact_key: "project:kld.release",
      tags: '["date:2026-07-15"]',
      five_axis_revision: 2
    } as MemoryRecord;
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            if (sql === "SELECT * FROM memory_five_axis_outbox WHERE id = ?") {
              return { first: async () => outbox };
            }
            if (sql === "SELECT * FROM memories WHERE namespace = ? AND id = ?") {
              return { first: async () => excluded };
            }
            if (sql.trim().startsWith("SELECT thread, fact_key FROM memory_timeline_memberships")) {
              return { first: async () => ({ thread: "kld", fact_key: "project:kld.release" }) };
            }
            if (sql.includes("SELECT * FROM memories")) {
              return { all: async () => ({ results: [] }) };
            }
            if (sql.startsWith("DELETE FROM memory_timeline_memberships")) {
              return { run: async () => {
                membershipDeleted = true;
                return { meta: { changes: 1 } };
              } };
            }
            if (sql.startsWith("UPDATE memory_five_axis_outbox")) {
              return { run: async () => {
                completion = JSON.parse(String(values[3])) as Record<string, unknown>;
                return { meta: { changes: 1 } };
              } };
            }
            return { sql, args: values };
          }
        };
      },
      async batch(statements: Array<{ sql: string; args: unknown[] }>) {
        relationBatches.push(statements);
        return statements.map(() => ({ meta: { changes: 1 } }));
      }
    } as unknown as D1Database;
    const message: MemoryFiveAxisProjectionQueueMessage = {
      type: "memory_five_axis_projection",
      namespace: "default",
      memoryId: excluded.id,
      memoryUpdatedAt: outbox.memory_updated_at,
      memoryRevision: outbox.memory_revision,
      outboxId: outbox.id,
      idempotencyKey: "five-axis:13:r2"
    };

    await handleQueueMessage(message, { DB: db } as Env);

    expect(completion).toEqual({ reason: "memory_type_not_projectable" });
    expect(membershipDeleted).toBe(true);
    expect(relationBatches).toHaveLength(1);
    expect(relationBatches[0][0].args[1]).toBe('timeline_approved:["kld","project:kld.release"]');
  });
});
