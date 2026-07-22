import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface SqliteStatement {
  run(...values: unknown[]): { changes: number | bigint };
  get(...values: unknown[]): Record<string, unknown> | undefined;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const TIMELINE_ID = "mem_c0fa942d17b24645842b55c7b9b941cf";
const DREAM_ID = "mem_0f734f50a7954cb9900773655efb0af1";

function insertMemory(sqlite: SqliteDatabase, input: {
  id: string;
  type: string;
  status: string;
  source?: string;
  activeFact?: number;
  tags?: string[];
  revision?: number;
}): void {
  sqlite.prepare(
    `INSERT INTO memories (
      id, namespace, type, content, status, active_fact, pinned, tags, source,
      vector_synced, vector_sync_status, five_axis_revision, updated_at
    ) VALUES (?, 'default', ?, 'recovery fixture', ?, ?, 0, ?, ?, 1, 'synced', ?, '2026-07-20T00:00:00.000Z')`
  ).run(
    input.id,
    input.type,
    input.status,
    input.activeFact ?? (input.status === "active" ? 1 : 0),
    JSON.stringify(input.tags ?? []),
    input.source ?? null,
    input.revision ?? 1
  );
}

describe("recovery reprojection SQL", () => {
  let sqlite: SqliteDatabase;
  let readFileSync: (path: string, encoding: "utf8") => string;

  beforeEach(async () => {
    // @ts-expect-error node:sqlite is available in the test runtime but not in the Worker tsconfig types.
    const { DatabaseSync } = await import("node:sqlite");
    // @ts-expect-error node:fs is available in the test runtime but not in the Worker tsconfig types.
    ({ readFileSync } = await import("node:fs"));
    sqlite = new DatabaseSync(":memory:") as SqliteDatabase;
    sqlite.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        active_fact INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        tags TEXT,
        source TEXT,
        vector_synced INTEGER NOT NULL DEFAULT 0,
        vector_sync_status TEXT,
        five_axis_revision INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE memory_events (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        event_type TEXT NOT NULL,
        memory_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE memory_five_axis_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        namespace TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        memory_updated_at TEXT NOT NULL,
        memory_revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(namespace, memory_id, memory_revision)
      );
    `);
  });

  afterEach(() => sqlite.close());

  it("restores only owned timeline summaries and enqueues their current revision exactly once", () => {
    insertMemory(sqlite, {
      id: TIMELINE_ID,
      type: "timeline_day",
      status: "deleted",
      source: "timeline_split"
    });
    insertMemory(sqlite, {
      id: "mem_date_shell_fixture",
      type: "timeline_day",
      status: "deleted",
      source: "timeline_split",
      tags: ["date:2026-07-14"]
    });
    const migration = readFileSync("migrations/20260722_restore_meaningful_timeline_days.sql", "utf8");

    sqlite.exec(migration);
    sqlite.exec(migration);

    expect(sqlite.prepare(
      "SELECT status, active_fact, tags, five_axis_revision FROM memories WHERE id = ?"
    ).get(TIMELINE_ID)).toMatchObject({
      status: "active",
      active_fact: 1,
      five_axis_revision: 2
    });
    expect(JSON.parse(String(sqlite.prepare("SELECT tags FROM memories WHERE id = ?").get(TIMELINE_ID)?.tags)))
      .toContain("timeline_day_content:v1");
    expect(sqlite.prepare(
      "SELECT memory_revision, status FROM memory_five_axis_outbox WHERE memory_id = ?"
    ).get(TIMELINE_ID)).toMatchObject({ memory_revision: 2, status: "pending" });
    expect(sqlite.prepare(
      "SELECT status FROM memories WHERE id = 'mem_date_shell_fixture'"
    ).get()).toMatchObject({ status: "deleted" });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM memory_five_axis_outbox WHERE memory_id = ?"
    ).get(TIMELINE_ID)).toMatchObject({ count: 1 });
  });

  it("enqueues named active targets even when an earlier run already restored them", () => {
    insertMemory(sqlite, {
      id: TIMELINE_ID,
      type: "timeline_day",
      status: "active",
      source: "timeline_split",
      activeFact: 1,
      tags: ["timeline_day_content:v1"],
      revision: 4
    });
    insertMemory(sqlite, {
      id: DREAM_ID,
      type: "rule",
      status: "deleted",
      revision: 7
    });
    const recovery = readFileSync("ops/recovery-20260722-pr88-dream-delete.sql", "utf8");

    sqlite.exec(recovery);
    sqlite.exec(recovery);

    expect(sqlite.prepare(
      "SELECT status, five_axis_revision FROM memories WHERE id = ?"
    ).get(TIMELINE_ID)).toMatchObject({ status: "active", five_axis_revision: 5 });
    expect(sqlite.prepare(
      "SELECT status, active_fact, five_axis_revision FROM memories WHERE id = ?"
    ).get(DREAM_ID)).toMatchObject({ status: "active", active_fact: 1, five_axis_revision: 8 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM memory_five_axis_outbox WHERE memory_id IN (?, ?)"
    ).get(TIMELINE_ID, DREAM_ID)).toMatchObject({ count: 2 });
    expect(sqlite.prepare(
      "SELECT memory_revision FROM memory_five_axis_outbox WHERE memory_id = ?"
    ).get(TIMELINE_ID)).toMatchObject({ memory_revision: 5 });
    expect(sqlite.prepare(
      "SELECT memory_revision FROM memory_five_axis_outbox WHERE memory_id = ?"
    ).get(DREAM_ID)).toMatchObject({ memory_revision: 8 });
  });
});
