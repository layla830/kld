import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createMemory, getMemoryById } from "../src/db/memories";
import { createMemoryRelation } from "../src/db/memoryRelations";
import { upsertMemoryCandidate } from "../src/db/memoryCandidates";
import { approveCandidate } from "../src/api/adminBoard/candidateActions";
import { approveMetabolismCandidate } from "../src/api/adminBoard/metabolismActions";
import {
  clearDiaryTimelineGroupsForOrigin,
  rebuildDiaryTimelineForMemory
} from "../src/memory/diaryTimeline";
import {
  deleteSyncedMemory,
  patchSyncedMemory
} from "../src/memory/state";
import { rebuildTimelineSequenceForMemory } from "../src/memory/timelineRelations";
import { deprojectMemoryFromFiveAxes } from "../src/memory/deprojection";
import { activateRescreenedDiary } from "../src/memory/diarySplit";
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
  it("clears origin-owned groups when a Dream update candidate re-types the origin", async () => {
    const namespace = "default";
    const seeded = await seedDiaryDay(namespace, "2026-07-30");
    const sibling = await createMemory(env.DB, {
      namespace,
      type: "event",
      content: "Second item owned by the same diary origin",
      status: "active",
      importance: 0.4,
      source: "timeline_split",
      sourceMessageIds: [seeded.origin.id],
      tags: ["timeline", "date:2026-07-30", `origin:${seeded.origin.id}`, "split_version:v2"]
    });
    await rebuildDiaryTimelineForMemory(env.DB, sibling);

    const externalKey = `dream-update:diary-origin:${crypto.randomUUID()}`;
    await upsertMemoryCandidate(env.DB, namespace, {
      externalKey,
      dreamDate: "2026-07-30",
      action: "update",
      targetId: seeded.origin.id,
      payload: { type: "note" },
      sourceChunkIds: [],
      status: "pending"
    });
    const candidate = await env.DB.prepare(
      "SELECT id FROM memory_candidates WHERE namespace = ? AND external_key = ?"
    ).bind(namespace, externalKey).first<{ id: string }>();
    if (!candidate) throw new Error("missing diary-origin update candidate");
    const form = new FormData();
    form.set("id", candidate.id);

    await expect(approveCandidate(runtime(), form)).resolves.toMatchObject({
      id: seeded.origin.id,
      type: "note",
      status: "active"
    });
    await expect(count(
      "SELECT COUNT(*) AS count FROM memory_diary_timeline_memberships WHERE namespace = ? AND origin_diary_id = ?",
      namespace,
      seeded.origin.id
    )).resolves.toBe(0);
    await expect(count(
      `SELECT COUNT(*) AS count FROM memory_relations
       WHERE namespace = ? AND relation_type = 'in_episode'
         AND reason = ?`,
      namespace,
      `diary_day:${seeded.origin.id}:2026-07-30`
    )).resolves.toBe(0);
  });

  it("leaves diary groups untouched when approving an ordinary note update candidate", async () => {
    const namespace = "default";
    const seeded = await seedDiaryDay(namespace, "2026-07-31");
    const note = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "Ordinary note before candidate approval",
      status: "active"
    });
    const externalKey = `dream-update:ordinary-note:${crypto.randomUUID()}`;
    await upsertMemoryCandidate(env.DB, namespace, {
      externalKey,
      dreamDate: "2026-07-31",
      action: "update",
      targetId: note.id,
      payload: { content: "Ordinary note after candidate approval" },
      sourceChunkIds: [],
      status: "pending"
    });
    const candidate = await env.DB.prepare(
      "SELECT id FROM memory_candidates WHERE namespace = ? AND external_key = ?"
    ).bind(namespace, externalKey).first<{ id: string }>();
    if (!candidate) throw new Error("missing ordinary note update candidate");
    const form = new FormData();
    form.set("id", candidate.id);

    await expect(approveCandidate(runtime(), form)).resolves.toMatchObject({
      id: note.id,
      type: "note",
      content: "Ordinary note after candidate approval"
    });
    await expect(count(
      `SELECT COUNT(*) AS count
       FROM memory_diary_timeline_memberships
       WHERE namespace = ? AND origin_diary_id = ? AND memory_id = ?`,
      namespace,
      seeded.origin.id,
      seeded.item.id
    )).resolves.toBe(1);
  });

  it("re-elects the canonical diary day and reconnects the sequence after deprojection", async () => {
    const namespace = `diary-member-transition-${crypto.randomUUID()}`;
    const first = await seedDiaryDay(namespace, "2026-07-27");
    const surviving = await createMemory(env.DB, {
      namespace,
      type: "event",
      content: "Surviving item for the first diary day",
      status: "active",
      importance: 0.3,
      source: "timeline_split",
      sourceMessageIds: [first.origin.id],
      tags: ["timeline", "date:2026-07-27", `origin:${first.origin.id}`, "split_version:v2"]
    });
    await rebuildDiaryTimelineForMemory(env.DB, surviving);
    const second = await seedDiaryDay(namespace, "2026-07-28");

    await expect(env.DB.prepare(
      `SELECT role, day_memory_id
       FROM memory_diary_timeline_memberships
       WHERE namespace = ? AND memory_id = ?`
    ).bind(namespace, first.item.id).first()).resolves.toMatchObject({
      role: "day",
      day_memory_id: first.item.id
    });

    await deleteSyncedMemory(runtime(), namespace, first.item.id);

    await expect(env.DB.prepare(
      `SELECT role, day_memory_id
       FROM memory_diary_timeline_memberships
       WHERE namespace = ? AND memory_id = ?`
    ).bind(namespace, surviving.id).first()).resolves.toMatchObject({
      role: "day",
      day_memory_id: surviving.id
    });
    await expect(count(
      `SELECT COUNT(*) AS count FROM memory_relations
       WHERE namespace = ? AND relation_type = 'temporal_sequence'
         AND reason = 'diary_timeline:diary:kld'
         AND (
           (source_memory_id = ? AND target_memory_id = ?)
           OR (source_memory_id = ? AND target_memory_id = ?)
         )`,
      namespace,
      surviving.id,
      second.item.id,
      second.item.id,
      surviving.id
    )).resolves.toBe(1);
    await expect(count(
      `SELECT COUNT(*) AS count
       FROM memory_diary_timeline_memberships AS membership
       LEFT JOIN memories AS day
         ON day.namespace = membership.namespace AND day.id = membership.day_memory_id
       WHERE membership.namespace = ?
         AND (day.id IS NULL OR day.status != 'active')`,
      namespace
    )).resolves.toBe(0);
  });

  it("removes an ordinary diary member without changing the canonical day or sequence", async () => {
    const namespace = `diary-ordinary-member-${crypto.randomUUID()}`;
    const first = await seedDiaryDay(namespace, "2026-07-27");
    const member = await createMemory(env.DB, {
      namespace,
      type: "event",
      content: "Non-canonical member leaving the first day",
      status: "active",
      importance: 0.2,
      source: "timeline_split",
      sourceMessageIds: [first.origin.id],
      tags: ["timeline", "date:2026-07-27", `origin:${first.origin.id}`, "split_version:v2"]
    });
    await rebuildDiaryTimelineForMemory(env.DB, member);
    const second = await seedDiaryDay(namespace, "2026-07-28");

    await deleteSyncedMemory(runtime(), namespace, member.id);

    await expect(env.DB.prepare(
      `SELECT role, day_memory_id
       FROM memory_diary_timeline_memberships
       WHERE namespace = ? AND memory_id = ?`
    ).bind(namespace, first.item.id).first()).resolves.toMatchObject({
      role: "day",
      day_memory_id: first.item.id
    });
    await expect(count(
      `SELECT COUNT(*) AS count
       FROM memory_diary_timeline_memberships
       WHERE namespace = ? AND memory_id = ?`,
      namespace,
      member.id
    )).resolves.toBe(0);
    await expect(count(
      `SELECT COUNT(*) AS count FROM memory_relations
       WHERE namespace = ? AND relation_type = 'in_episode'
         AND (source_memory_id = ? OR target_memory_id = ?)`,
      namespace,
      member.id,
      member.id
    )).resolves.toBe(0);
    await expect(count(
      `SELECT COUNT(*) AS count FROM memory_relations
       WHERE namespace = ? AND relation_type = 'temporal_sequence'
         AND reason = 'diary_timeline:diary:kld'
         AND (
           (source_memory_id = ? AND target_memory_id = ?)
           OR (source_memory_id = ? AND target_memory_id = ?)
         )`,
      namespace,
      first.item.id,
      second.item.id,
      second.item.id,
      first.item.id
    )).resolves.toBe(1);
  });

  it("replays diary group reconstruction idempotently from the deprojection snapshot", async () => {
    const namespace = `diary-deprojection-replay-${crypto.randomUUID()}`;
    const seeded = await seedDiaryDay(namespace, "2026-07-27");
    const surviving = await createMemory(env.DB, {
      namespace,
      type: "event",
      content: "Surviving replay member",
      status: "active",
      importance: 0.2,
      source: "timeline_split",
      sourceMessageIds: [seeded.origin.id],
      tags: ["timeline", "date:2026-07-27", `origin:${seeded.origin.id}`, "split_version:v2"]
    });
    await rebuildDiaryTimelineForMemory(env.DB, surviving);
    const operationId = `deproj_diary_replay_${seeded.item.id}`;
    const input = {
      namespace,
      memoryId: seeded.item.id,
      patch: { status: "deleted" as const },
      expectedStatus: "active" as const,
      expectedRevision: seeded.item.five_axis_revision ?? 1,
      source: "system" as const,
      reason: "diary_deprojection_replay_test",
      operationId
    };

    await expect(deprojectMemoryFromFiveAxes(runtime(), input)).resolves.toMatchObject({
      reused: false
    });
    await expect(deprojectMemoryFromFiveAxes(runtime(), input)).resolves.toMatchObject({
      reused: true
    });
    await expect(env.DB.prepare(
      `SELECT role, day_memory_id
       FROM memory_diary_timeline_memberships
       WHERE namespace = ? AND memory_id = ?`
    ).bind(namespace, surviving.id).first()).resolves.toMatchObject({
      role: "day",
      day_memory_id: surviving.id
    });
  });

  it("rebuilds a diary group after an m_archive approval commits deprojection", async () => {
    const namespace = "default";
    const seeded = await seedDiaryDay(namespace, "2026-08-01");
    const archivedDay = await createMemory(env.DB, {
      namespace,
      type: "project_state",
      content: "Expired diary project state",
      status: "active",
      importance: 0.95,
      confidence: 0.9,
      expiresAt: "2020-01-01T00:00:00.000Z",
      source: "timeline_split",
      sourceMessageIds: [seeded.origin.id],
      tags: [
        "timeline",
        "date:2026-08-01",
        `origin:${seeded.origin.id}`,
        "split_version:v2"
      ]
    });
    await rebuildDiaryTimelineForMemory(env.DB, archivedDay);
    await expect(env.DB.prepare(
      `SELECT role, day_memory_id
       FROM memory_diary_timeline_memberships
       WHERE namespace = ? AND memory_id = ?`
    ).bind(namespace, archivedDay.id).first()).resolves.toMatchObject({
      role: "day",
      day_memory_id: archivedDay.id
    });

    const externalKey = `m-archive:diary-member:${crypto.randomUUID()}`;
    await upsertMemoryCandidate(env.DB, namespace, {
      externalKey,
      dreamDate: "2026-08-01",
      action: "m_archive",
      subject: "system",
      targetId: archivedDay.id,
      payload: {
        _kind: "metabolism_archive",
        policy: "expired_project_state",
        before: archivedDay
      },
      sourceChunkIds: [],
      status: "pending"
    });
    const candidate = await env.DB.prepare(
      "SELECT id FROM memory_candidates WHERE namespace = ? AND external_key = ?"
    ).bind(namespace, externalKey).first<{ id: string }>();
    if (!candidate) throw new Error("missing metabolism archive candidate");
    const form = new FormData();
    form.set("id", candidate.id);

    await expect(approveMetabolismCandidate(runtime(), form)).resolves.toMatchObject({
      action: "m_archive",
      memory: {
        id: archivedDay.id,
        status: "archived"
      }
    });
    await expect(env.DB.prepare(
      `SELECT role, day_memory_id
       FROM memory_diary_timeline_memberships
       WHERE namespace = ? AND memory_id = ?`
    ).bind(namespace, seeded.item.id).first()).resolves.toMatchObject({
      role: "day",
      day_memory_id: seeded.item.id
    });
    await expect(count(
      `SELECT COUNT(*) AS count
       FROM memory_diary_timeline_memberships
       WHERE namespace = ? AND memory_id = ?`,
      namespace,
      archivedDay.id
    )).resolves.toBe(0);
  });

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

  it("rebuilds old and new diary groups when an active member changes date", async () => {
    const namespace = `diary-member-move-${crypto.randomUUID()}`;
    const seeded = await seedDiaryDay(namespace, "2026-07-28");
    const moved = await patchSyncedMemory(runtime(), namespace, seeded.item.id, {
      tags: [
        "timeline",
        "date:2026-07-29",
        `origin:${seeded.origin.id}`,
        "split_version:v2"
      ]
    });

    expect(moved).toMatchObject({ id: seeded.item.id, status: "active" });
    await expect(count(
      `SELECT COUNT(*) AS count
       FROM memory_diary_timeline_memberships
       WHERE namespace = ? AND memory_id = ? AND event_date = '2026-07-28'`,
      namespace,
      seeded.item.id
    )).resolves.toBe(0);
    await expect(env.DB.prepare(
      `SELECT event_date, role, day_memory_id
       FROM memory_diary_timeline_memberships
       WHERE namespace = ? AND memory_id = ?`
    ).bind(namespace, seeded.item.id).first()).resolves.toMatchObject({
      event_date: "2026-07-29",
      role: "day",
      day_memory_id: seeded.item.id
    });
  });

  it("clears an active timeline membership when its canonical date disappears", async () => {
    const namespace = `timeline-member-clear-${crypto.randomUUID()}`;
    const first = await createMemory(env.DB, {
      namespace,
      type: "project_state",
      content: "First timeline state",
      status: "active",
      thread: "release",
      factKey: "project:release",
      tags: ["timeline", "date:2026-07-28"]
    });
    const second = await createMemory(env.DB, {
      namespace,
      type: "project_state",
      content: "Second timeline state",
      status: "active",
      thread: "release",
      factKey: "project:release",
      tags: ["timeline", "date:2026-07-29"]
    });
    await rebuildTimelineSequenceForMemory(env.DB, first);
    await rebuildTimelineSequenceForMemory(env.DB, second);
    await expect(count(
      "SELECT COUNT(*) AS count FROM memory_timeline_memberships WHERE namespace = ?",
      namespace
    )).resolves.toBe(2);
    const owner = 'timeline_approved:["release","project:release"]';
    await expect(count(
      `SELECT COUNT(*) AS count FROM memory_relations
       WHERE namespace = ? AND relation_type = 'temporal_sequence'
         AND reason = ?`,
      namespace,
      owner
    )).resolves.toBe(1);

    await patchSyncedMemory(runtime(), namespace, first.id, {
      tags: ["timeline"]
    });

    await expect(count(
      "SELECT COUNT(*) AS count FROM memory_timeline_memberships WHERE namespace = ? AND memory_id = ?",
      namespace,
      first.id
    )).resolves.toBe(0);
    await expect(count(
      `SELECT COUNT(*) AS count FROM memory_relations
       WHERE namespace = ? AND relation_type = 'temporal_sequence'
         AND reason = ?`,
      namespace,
      owner
    )).resolves.toBe(0);
  });

  it("routes rescreen activation and replacement through lifecycle owners", async () => {
    const namespace = `diary-rescreen-lifecycle-${crypto.randomUUID()}`;
    const eventDate = "2026-07-20";
    const origin = await createMemory(env.DB, {
      namespace,
      type: "diary",
      content: "Diary origin for rescreen lifecycle",
      status: "active",
      tags: [`date:${eventDate}`],
      source: "diary-origin-lifecycle-test"
    });
    const oldItem = await createMemory(env.DB, {
      namespace,
      type: "event",
      content: "Legacy imported event",
      status: "active",
      source: "timeline_split",
      sourceMessageIds: [origin.id],
      tags: [
        "timeline",
        `date:${eventDate}`,
        `origin:${origin.id}`,
        "importer:legacy",
        "split_version:v1"
      ]
    });
    const peer = await createMemory(env.DB, {
      namespace,
      type: "note",
      content: "Relation peer",
      status: "active"
    });
    const replacement = await createMemory(env.DB, {
      namespace,
      type: "event",
      content: "A durable event happened.",
      status: "review",
      activeFact: false,
      source: "timeline_split",
      sourceMessageIds: [origin.id],
      tags: [
        "timeline",
        `date:${eventDate}`,
        `origin:${origin.id}`,
        "rescreened_from:legacy",
        "split_version:v2"
      ]
    });
    await rebuildDiaryTimelineForMemory(env.DB, oldItem);
    await createMemoryRelation(env.DB, {
      namespace,
      sourceMemoryId: oldItem.id,
      targetMemoryId: peer.id,
      relationType: "same_topic",
      reason: "rescreen lifecycle test"
    });
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE memory_five_axis_outbox
         SET status = 'queued', attempts = 1, queued_at = ?, updated_at = ?
         WHERE namespace = ? AND memory_id = ? AND memory_revision = ?`
      ).bind(now, now, namespace, oldItem.id, oldItem.five_axis_revision ?? 1),
      env.DB.prepare(
        `INSERT INTO memory_five_axis_runs (
           namespace, memory_id, memory_revision, axis, status, attempts,
           claim_token, lease_expires_at, started_at, updated_at
         ) VALUES (?, ?, ?, 'Y', 'running', 1, ?, ?, ?, ?)`
      ).bind(
        namespace,
        oldItem.id,
        oldItem.five_axis_revision ?? 1,
        `claim_${crypto.randomUUID()}`,
        "2099-07-28T03:00:00.000Z",
        now,
        now
      )
    ]);

    const replacedIds = await activateRescreenedDiary(runtime(), {
      namespace,
      diaryId: origin.id,
      importer: "legacy",
      createdIds: [replacement.id]
    });

    expect(replacedIds).toContain(oldItem.id);
    await expect(getMemoryById(env.DB, { namespace, id: oldItem.id })).resolves.toMatchObject({
      status: "review",
      active_fact: 0
    });
    await expect(getMemoryById(env.DB, { namespace, id: replacement.id })).resolves.toMatchObject({
      status: "active",
      active_fact: 1
    });
    await expect(count(
      `SELECT COUNT(*) AS count FROM memory_relations
       WHERE namespace = ? AND (source_memory_id = ? OR target_memory_id = ?)`,
      namespace,
      oldItem.id,
      oldItem.id
    )).resolves.toBe(0);
    await expect(count(
      `SELECT COUNT(*) AS count FROM memory_diary_timeline_memberships
       WHERE namespace = ? AND memory_id = ?`,
      namespace,
      oldItem.id
    )).resolves.toBe(0);
    await expect(count(
      `SELECT COUNT(*) AS count FROM memory_diary_timeline_memberships
       WHERE namespace = ? AND memory_id = ? AND role = 'day'`,
      namespace,
      replacement.id
    )).resolves.toBe(1);
    await expect(env.DB.prepare(
      `SELECT status FROM memory_five_axis_runs
       WHERE namespace = ? AND memory_id = ? AND memory_revision = ? AND axis = 'Y'`
    ).bind(namespace, oldItem.id, oldItem.five_axis_revision ?? 1).first())
      .resolves.toMatchObject({ status: "skipped" });
    await expect(count(
      `SELECT COUNT(*) AS count FROM memory_five_axis_outbox
       WHERE namespace = ? AND memory_id = ? AND status != 'skipped'`,
      namespace,
      oldItem.id
    )).resolves.toBe(0);
  });
});
