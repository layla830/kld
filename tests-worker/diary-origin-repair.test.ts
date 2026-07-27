import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  buildInactiveFiveAxisAuditQueries,
  buildInactiveFiveAxisAuditReport
} from "../scripts/inactive-five-axis-audit.mjs";
import {
  assertReadOnlyDiaryOriginRepairQuery,
  buildDiaryOriginRepairApplyQueries,
  buildDiaryOriginRepairDryRunQuery
} from "../scripts/diary-origin-timeline-repair.mjs";
import { createMemory } from "../src/db/memories";

async function runAudit(namespace: string) {
  const queries = buildInactiveFiveAxisAuditQueries({ namespace, staleHours: 24 });
  const rowsByName: Record<string, Array<Record<string, unknown>>> = {};
  for (const query of queries) {
    const rows = await env.DB.prepare(query.sql).all<Record<string, unknown>>();
    rowsByName[query.name] = rows.results ?? [];
  }
  return buildInactiveFiveAxisAuditReport({
    namespace,
    queries,
    rowsByName,
    generatedAt: "2026-07-28T00:00:00.000Z"
  });
}

describe("bounded diary origin timeline repair", () => {
  it("repairs only invalid-origin memberships and deterministic owned relations", async () => {
    const namespace = `diary-origin-repair-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const validOrigin = await createMemory(env.DB, {
      namespace,
      type: "diary",
      content: "Valid origin",
      status: "active"
    });
    const deletedOrigin = await createMemory(env.DB, {
      namespace,
      type: "diary",
      content: "Deleted origin",
      status: "deleted"
    });
    const validMember = await createMemory(env.DB, {
      namespace,
      type: "event",
      content: "Valid member",
      status: "active"
    });
    const invalidMember = await createMemory(env.DB, {
      namespace,
      type: "event",
      content: "Invalid member",
      status: "active"
    });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO memory_diary_timeline_memberships (
           namespace, memory_id, origin_diary_id, timeline_key,
           event_date, role, day_memory_id, updated_at
         ) VALUES (?, ?, ?, 'diary:kld', '2026-07-27', 'day', ?, ?)`
      ).bind(namespace, validMember.id, validOrigin.id, validMember.id, now),
      env.DB.prepare(
        `INSERT INTO memory_diary_timeline_memberships (
           namespace, memory_id, origin_diary_id, timeline_key,
           event_date, role, day_memory_id, updated_at
         ) VALUES (?, ?, ?, 'diary:kld', '2026-07-28', 'day', ?, ?)`
      ).bind(namespace, invalidMember.id, deletedOrigin.id, invalidMember.id, now),
      env.DB.prepare(
        `INSERT INTO memory_relations (
           id, namespace, source_memory_id, target_memory_id,
           relation_type, strength, reason, created_at
         ) VALUES (?, ?, ?, ?, 'in_episode', 1, ?, ?)`
      ).bind(
        `rel_${crypto.randomUUID()}`,
        namespace,
        invalidMember.id,
        validMember.id,
        `diary_day:${deletedOrigin.id}:2026-07-28`,
        now
      ),
      env.DB.prepare(
        `INSERT INTO memory_relations (
           id, namespace, source_memory_id, target_memory_id,
           relation_type, strength, reason, created_at
         ) VALUES (?, ?, ?, ?, 'derived_from', 1, 'historical free text', ?)`
      ).bind(
        `rel_${crypto.randomUUID()}`,
        namespace,
        invalidMember.id,
        validMember.id,
        now
      )
    ]);

    const before = await runAudit(namespace);
    expect(before.sections.timeline[0]).toMatchObject({
      diary_drift_rows: 1,
      invalid_origin_diary_rows: 1
    });

    const dryRun = buildDiaryOriginRepairDryRunQuery({ namespace, limit: 10 });
    expect(() => assertReadOnlyDiaryOriginRepairQuery(dryRun)).not.toThrow();
    await expect(env.DB.prepare(dryRun.sql).all()).resolves.toMatchObject({
      results: [{
        repairable_origins: 1,
        membership_rows: 1,
        owned_in_episode_rows: 1,
        selected: 1,
        has_more: 0
      }]
    });

    for (const query of buildDiaryOriginRepairApplyQueries({ namespace, limit: 10 })) {
      await env.DB.prepare(query.sql).all();
    }

    const after = await runAudit(namespace);
    expect(after.sections.timeline[0]).toMatchObject({
      diary_drift_rows: 0,
      invalid_origin_diary_rows: 0,
      origin_diary_provenance_rows: 1
    });
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM memory_diary_timeline_memberships
       WHERE namespace = ? AND origin_diary_id = ?`
    ).bind(namespace, validOrigin.id).first()).resolves.toMatchObject({ count: 1 });
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM memory_relations
       WHERE namespace = ? AND relation_type = 'derived_from'
         AND reason = 'historical free text'`
    ).bind(namespace).first()).resolves.toMatchObject({ count: 1 });
    await expect(env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM memory_relations
       WHERE namespace = ? AND relation_type = 'in_episode'
         AND reason = ?`
    ).bind(
      namespace,
      `diary_day:${deletedOrigin.id}:2026-07-28`
    ).first()).resolves.toMatchObject({ count: 0 });
  });
});
