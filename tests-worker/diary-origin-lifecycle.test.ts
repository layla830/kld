import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createMemory } from "../src/db/memories";
import {
  clearDiaryTimelineGroupsForOrigin,
  rebuildDiaryTimelineForMemory
} from "../src/memory/diaryTimeline";
import {
  deleteSyncedMemory,
  patchSyncedMemory
} from "../src/memory/state";
import type { Env, MemoryRecord } from "../src/types";

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ count: number }>();
  return row?.count ?? 0;
}

async function seedDiaryDay(
  namespace: string,
  eventDate: string
): Promise<{ origin: MemoryRecord; item: MemoryRecord }> {
  const origin = await createMemory(env.DB, {
    namespace,
    type: "diary",
    content: `Diary origin ${eventDate}`,
    status: "active",
    source: "diary-origin-lifecycle-test"
  });
  const item = await createMemory(env.DB, {
    namespace,
    type: "event",
    content: `Diary event ${eventDate}`,
    status: "active",
    importance: 0.8,
    source: "timeline_split",
    sourceMessageIds: [origin.id],
    tags: ["timeline", `date:${eventDate}`, `origin:${origin.id}`, "split_version:v2"]
  });
  await rebuildDiaryTimelineForMemory(env.DB, item);
  return { origin, item };
}

function runtime(): Env {
  return { DB: env.DB } as Env;
}

describe("diary origin lifecycle", () => {
  it("clears origin-owned groups on re-type and rebuilds the shared sequence", async () => {
    const namespace = `diary-origin-retype-${crypto.randomUUID()}`;
    const first = await seedDiaryDay(namespace, "2026-07-27");
    const second = await seedDiaryDay(namespace, "2026-07-28");

    await expect(count(
      `SELECT COUNT(*) AS count
       FROM memory_relations
       WHERE namespace = ? AND relation_type = 'temporal_sequence'
         AND reason = 'diary_timeline:diary:kld'`,
      namespace
    )).resolves.toBe(1);

    const updated = await patchSyncedMemory(runtime(), namespace, first.origin.id, {
      type: "note"
    });

    expect(updated).toMatchObject({
      id: first.origin.id,
      type: "note",
      status: "active",
      active_fact: 1
    });
    await expect(count(
      "SELECT COUNT(*) AS count FROM memory_diary_timeline_memberships WHERE namespace = ? AND origin_diary_id = ?",
      namespace,
      first.origin.id
    )).resolves.toBe(0);
    await expect(count(
      `SELECT COUNT(*) AS count FROM memory_relations
       WHERE namespace = ? AND relation_type = 'in_episode'
         AND reason = ?`,
      namespace,
      `diary_day:${first.origin.id}:2026-07-27`
    )).resolves.toBe(0);
    await expect(count(
      `SELECT COUNT(*) AS count FROM memory_relations
       WHERE namespace = ? AND relation_type = 'temporal_sequence'
         AND reason = 'diary_timeline:diary:kld'`,
      namespace
    )).resolves.toBe(0);

    const third = await seedDiaryDay(namespace, "2026-07-29");
    await expect(count(
      `SELECT COUNT(*) AS count FROM memory_relations
       WHERE namespace = ? AND relation_type = 'temporal_sequence'
         AND reason = 'diary_timeline:diary:kld'
         AND (
           source_memory_id IN (?, ?)
           OR target_memory_id IN (?, ?)
         )`,
      namespace,
      second.item.id,
      third.item.id,
      second.item.id,
      third.item.id
    )).resolves.toBe(1);
  });

  it("clears on delete, ignores unrelated edits, and is idempotent", async () => {
    const namespace = `diary-origin-delete-${crypto.randomUUID()}`;
    const seeded = await seedDiaryDay(namespace, "2026-07-28");
    const unrelated = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "Unrelated note",
      status: "active",
      source: "diary-origin-lifecycle-test"
    });

    await patchSyncedMemory(runtime(), namespace, unrelated.id, {
      content: "Unrelated note edited"
    });
    await expect(count(
      "SELECT COUNT(*) AS count FROM memory_diary_timeline_memberships WHERE namespace = ? AND origin_diary_id = ?",
      namespace,
      seeded.origin.id
    )).resolves.toBe(1);

    const deleted = await deleteSyncedMemory(runtime(), namespace, seeded.origin.id);
    expect(deleted).toMatchObject({
      id: seeded.origin.id,
      type: "diary",
      status: "deleted"
    });
    await expect(count(
      "SELECT COUNT(*) AS count FROM memory_diary_timeline_memberships WHERE namespace = ? AND origin_diary_id = ?",
      namespace,
      seeded.origin.id
    )).resolves.toBe(0);

    await clearDiaryTimelineGroupsForOrigin(env.DB, {
      namespace,
      originDiaryId: seeded.origin.id
    });
    await clearDiaryTimelineGroupsForOrigin(env.DB, {
      namespace,
      originDiaryId: seeded.origin.id
    });
    await expect(count(
      "SELECT COUNT(*) AS count FROM memory_diary_timeline_memberships WHERE namespace = ? AND origin_diary_id = ?",
      namespace,
      seeded.origin.id
    )).resolves.toBe(0);
  });
});
