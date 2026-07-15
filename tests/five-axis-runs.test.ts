import { describe, expect, it } from "vitest";
import {
  claimFiveAxisRun,
  completeFiveAxisRun,
  type FiveAxisRunKey,
  type FiveAxisRunStatus
} from "../src/db/memoryFiveAxisRuns";

describe("five-axis run claims", () => {
  it("allows one active lease and prevents a stale worker from overwriting the new owner", async () => {
    const key: FiveAxisRunKey = {
      namespace: "default",
      memoryId: "mem_1",
      memoryRevision: 3,
      axis: "X"
    };
    const row: {
      status: FiveAxisRunStatus | null;
      claimToken: string | null;
      leaseExpiresAt: string | null;
    } = { status: null, claimToken: null, leaseExpiresAt: null };
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              run: async () => {
                if (sql.includes("INSERT INTO memory_five_axis_runs")) {
                  const now = String(args[6]);
                  const claimable = row.status === null || row.status === "failed"
                    || (row.status === "running" && (!row.leaseExpiresAt || row.leaseExpiresAt <= now));
                  if (!claimable) return { meta: { changes: 0 } };
                  row.status = "running";
                  row.claimToken = String(args[4]);
                  row.leaseExpiresAt = String(args[5]);
                  return { meta: { changes: 1 } };
                }
                if (sql.includes("SET status = ?")) {
                  const claimToken = String(args[8]);
                  if (row.status !== "running" || row.claimToken !== claimToken) {
                    return { meta: { changes: 0 } };
                  }
                  row.status = String(args[0]) as FiveAxisRunStatus;
                  row.claimToken = null;
                  row.leaseExpiresAt = null;
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
            };
          }
        };
      }
    } as unknown as D1Database;

    const first = await claimFiveAxisRun(db, key);
    const overlapping = await claimFiveAxisRun(db, key);
    expect(first).toBeTruthy();
    expect(overlapping).toBeNull();

    row.leaseExpiresAt = "2000-01-01T00:00:00.000Z";
    const replacement = await claimFiveAxisRun(db, key);
    expect(replacement).toBeTruthy();
    expect(replacement).not.toBe(first);

    await expect(completeFiveAxisRun(db, key, first!, "applied", { owner: "stale" }))
      .resolves.toBe(false);
    await expect(completeFiveAxisRun(db, key, replacement!, "applied", { owner: "current" }))
      .resolves.toBe(true);
    await expect(claimFiveAxisRun(db, key)).resolves.toBeNull();
  });
});
