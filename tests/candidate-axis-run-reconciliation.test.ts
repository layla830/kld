import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dismissPendingMemoryCandidateByExternalKey,
  resolveMemoryCandidate,
  rollbackMemoryCandidate
} from "../src/db/memoryCandidates";
import {
  completeFiveAxisRun,
  getFiveAxisRun,
  type FiveAxisName,
  type FiveAxisRunKey
} from "../src/db/memoryFiveAxisRuns";

interface SqliteStatement {
  run(...values: unknown[]): { changes: number | bigint };
  get(...values: unknown[]): Record<string, unknown> | undefined;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

function d1FromSqlite(sqlite: SqliteDatabase): D1Database {
  function prepared(sql: string, values: unknown[] = []) {
    return {
      bind: (...next: unknown[]) => prepared(sql, next),
      first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
      run: async () => {
        const result = sqlite.prepare(sql).run(...values);
        return { meta: { changes: Number(result.changes) } };
      }
    };
  }

  return {
    prepare: (sql: string) => prepared(sql),
    batch: async (statements: Array<{ run(): Promise<D1Result<unknown>> }>) => {
      sqlite.exec("BEGIN");
      try {
        const results: D1Result<unknown>[] = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  } as unknown as D1Database;
}

function key(memoryRevision: number, axis: FiveAxisName = "X"): FiveAxisRunKey {
  return {
    namespace: "default",
    memoryId: "mem_1",
    memoryRevision,
    axis
  };
}

describe("candidate and five-axis run reconciliation", () => {
  let sqlite: SqliteDatabase;
  let db: D1Database;

  beforeEach(async () => {
    // Node 24 provides this built-in SQLite engine; the project intentionally has no Node type dependency.
    // @ts-expect-error node:sqlite is available in the test runtime but not in the Worker tsconfig types.
    const { DatabaseSync } = await import("node:sqlite");
    sqlite = new DatabaseSync(":memory:") as SqliteDatabase;
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE memory_candidates (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        external_key TEXT NOT NULL,
        action TEXT NOT NULL DEFAULT '',
        target_id TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        result_memory_id TEXT,
        resolved_at TEXT,
        created_at TEXT NOT NULL DEFAULT '2026-07-16T00:00:00.000Z',
        updated_at TEXT NOT NULL,
        UNIQUE(namespace, external_key)
      );
      CREATE TABLE memories (
        namespace TEXT NOT NULL,
        id TEXT NOT NULL,
        fact_key TEXT,
        PRIMARY KEY(namespace, id)
      );
      CREATE TABLE memory_five_axis_runs (
        namespace TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        memory_revision INTEGER NOT NULL,
        axis TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        result_json TEXT,
        last_error TEXT,
        claim_token TEXT,
        lease_expires_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(namespace, memory_id, memory_revision, axis)
      );
      CREATE TABLE memory_candidate_axis_runs (
        namespace TEXT NOT NULL,
        candidate_external_key TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        memory_revision INTEGER NOT NULL,
        axis TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(namespace, candidate_external_key, memory_id, memory_revision, axis),
        FOREIGN KEY(namespace, candidate_external_key)
          REFERENCES memory_candidates(namespace, external_key) ON DELETE CASCADE,
        FOREIGN KEY(namespace, memory_id, memory_revision, axis)
          REFERENCES memory_five_axis_runs(namespace, memory_id, memory_revision, axis) ON DELETE CASCADE
      );
    `);
    db = d1FromSqlite(sqlite);
  });

  afterEach(() => sqlite.close());

  function insertCandidate(id: string, externalKey: string, status = "pending") {
    sqlite.prepare(
      "INSERT INTO memory_candidates (id, namespace, external_key, status, updated_at) VALUES (?, 'default', ?, ?, '2026-07-16T00:00:00.000Z')"
    ).run(id, externalKey, status);
  }

  function insertRunningRun(runKey: FiveAxisRunKey, claimToken: string) {
    sqlite.prepare(
      `INSERT INTO memory_five_axis_runs (
         namespace, memory_id, memory_revision, axis, status, claim_token, updated_at
       ) VALUES (?, ?, ?, ?, 'running', ?, '2026-07-16T00:00:00.000Z')`
    ).run(runKey.namespace, runKey.memoryId, runKey.memoryRevision, runKey.axis, claimToken);
  }

  it("reconciles one-to-many and many-to-many candidate decisions across revisions", async () => {
    insertCandidate("cand_1", "candidate:1");
    insertCandidate("cand_2", "candidate:2");
    insertRunningRun(key(1), "claim-1");
    insertRunningRun(key(2), "claim-2");

    await expect(completeFiveAxisRun(
      db,
      key(1),
      "claim-1",
      "pending_review",
      { candidates: 2 },
      ["candidate:1", "candidate:2", "candidate:1"]
    )).resolves.toBe(true);
    await expect(completeFiveAxisRun(
      db,
      key(2),
      "claim-2",
      "pending_review",
      { candidates: 1 },
      ["candidate:1"]
    )).resolves.toBe(true);
    expect((await getFiveAxisRun(db, key(1)))?.status).toBe("pending_review");
    expect((await getFiveAxisRun(db, key(2)))?.status).toBe("pending_review");

    await expect(resolveMemoryCandidate(db, "default", "cand_1", "approved")).resolves.toBe(true);
    expect((await getFiveAxisRun(db, key(1)))?.status).toBe("pending_review");
    expect((await getFiveAxisRun(db, key(2)))?.status).toBe("applied");

    await expect(resolveMemoryCandidate(db, "default", "cand_2", "rejected")).resolves.toBe(true);
    expect((await getFiveAxisRun(db, key(1)))?.status).toBe("applied");

    await expect(rollbackMemoryCandidate(db, "default", "cand_1")).resolves.toBe(true);
    expect((await getFiveAxisRun(db, key(1)))?.status).toBe("skipped");
    expect((await getFiveAxisRun(db, key(2)))?.status).toBe("skipped");
  });

  it("immediately reuses an already-approved de-duplicated candidate", async () => {
    insertCandidate("cand_approved", "candidate:approved", "approved");
    insertRunningRun(key(3, "Y"), "claim-3");

    await expect(completeFiveAxisRun(
      db,
      key(3, "Y"),
      "claim-3",
      "pending_review",
      { candidates: 1 },
      ["candidate:approved"]
    )).resolves.toBe(true);
    expect((await getFiveAxisRun(db, key(3, "Y")))?.status).toBe("applied");
  });

  it("reconciles an E candidate rejected by external key and rejects unlinked pending runs", async () => {
    insertCandidate("cand_e", "candidate:e");
    insertRunningRun(key(4, "E"), "claim-4");
    insertRunningRun(key(5, "M"), "claim-5");

    await expect(completeFiveAxisRun(
      db,
      key(4, "E"),
      "claim-4",
      "pending_review",
      { queued: 1 },
      ["candidate:e"]
    )).resolves.toBe(true);
    await expect(dismissPendingMemoryCandidateByExternalKey(db, "default", "candidate:e"))
      .resolves.toBe(true);
    expect((await getFiveAxisRun(db, key(4, "E")))?.status).toBe("skipped");

    await expect(completeFiveAxisRun(
      db,
      key(5, "M"),
      "claim-5",
      "pending_review",
      { candidates: 1 }
    )).resolves.toBe(false);
    expect((await getFiveAxisRun(db, key(5, "M")))?.status).toBe("running");
  });

  it("backfills and immediately reconciles legacy pending-review runs during migration", async () => {
    sqlite.prepare(
      "INSERT INTO memories (namespace, id, fact_key) VALUES ('default', 'mem_1', 'project:kld')"
    ).run();
    const historicalRuns: Array<[number, FiveAxisName]> = [
      [11, "X"],
      [12, "E"],
      [13, "Y"],
      [14, "Z"],
      [15, "M"]
    ];
    for (const [revision, axis] of historicalRuns) {
      sqlite.prepare(
        `INSERT INTO memory_five_axis_runs (
           namespace, memory_id, memory_revision, axis, status, updated_at
         ) VALUES ('default', 'mem_1', ?, ?, 'pending_review', '2026-07-16T00:00:00.000Z')`
      ).run(revision, axis);
    }
    const insertHistoricalCandidate = (
      id: string,
      externalKey: string,
      action: string,
      status: string,
      targetId: string | null,
      payload: unknown
    ) => sqlite.prepare(
      `INSERT INTO memory_candidates (
         id, namespace, external_key, action, target_id, payload_json, status, updated_at
       ) VALUES (?, 'default', ?, ?, ?, ?, ?, '2026-07-16T00:00:00.000Z')`
    ).run(id, externalKey, action, targetId, JSON.stringify(payload), status);
    insertHistoricalCandidate("legacy_x", "legacy:x", "timeline_date", "approved", "mem_1", {});
    insertHistoricalCandidate("legacy_e", "legacy:e", "update", "rejected", "mem_1", {
      _kind: "coordinate_backfill"
    });
    insertHistoricalCandidate("legacy_y", "legacy:y", "y_relation_review", "approved", null, {
      projection_key: "five-axis:mem_1:r13"
    });
    insertHistoricalCandidate("legacy_z", "legacy:z", "z_supersede", "pending", null, {
      fact_key: "project:kld"
    });
    insertHistoricalCandidate("legacy_m", "legacy:m", "m_archive", "rolled_back", "mem_1", {});

    // @ts-expect-error node:fs is available in the test runtime but not in the Worker tsconfig types.
    const { readFileSync } = await import("node:fs");
    sqlite.exec(readFileSync("migrations/20260717_candidate_axis_run_links.sql", "utf8"));

    await expect(getFiveAxisRun(db, key(11, "X"))).resolves.toMatchObject({ status: "applied" });
    await expect(getFiveAxisRun(db, key(12, "E"))).resolves.toMatchObject({ status: "skipped" });
    await expect(getFiveAxisRun(db, key(13, "Y"))).resolves.toMatchObject({ status: "applied" });
    await expect(getFiveAxisRun(db, key(14, "Z"))).resolves.toMatchObject({ status: "pending_review" });
    await expect(getFiveAxisRun(db, key(15, "M"))).resolves.toMatchObject({ status: "skipped" });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_candidate_axis_runs").get()?.count).toBe(5);
  });
});
