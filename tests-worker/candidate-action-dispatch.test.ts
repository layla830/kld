import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { approveCandidate } from "../src/api/adminBoard/candidateActions";
import { upsertMemoryCandidate } from "../src/db/memoryCandidates";
import { createMemory, getMemoryById } from "../src/db/memories";
import {
  APPROVABLE_CANDIDATE_ACTIONS,
  type ApprovableCandidateAction,
  type CandidateAction
} from "../src/memory/candidateActionContract";
import type { Env, MemoryRecord } from "../src/types";

const runtimeEnv = { DB: env.DB } as Env;
const runId = crypto.randomUUID();

interface QueuedCandidate {
  id: string;
  approve(): Promise<MemoryRecord | null>;
}

interface CandidateFixture {
  candidate: QueuedCandidate;
  verify(target: MemoryRecord): Promise<void>;
}

async function queueCandidate(input: {
  key: string;
  action: CandidateAction;
  payload?: Record<string, unknown>;
  targetId?: string;
}): Promise<QueuedCandidate> {
  const externalKey = `candidate-dispatch:${runId}:${input.key}`;
  await upsertMemoryCandidate(env.DB, "default", {
    externalKey,
    dreamDate: "2026-07-19",
    action: input.action,
    targetId: input.targetId,
    payload: input.payload ?? {},
    sourceChunkIds: [],
    status: "pending"
  });
  const row = await env.DB.prepare(
    "SELECT id FROM memory_candidates WHERE namespace = 'default' AND external_key = ?"
  ).bind(externalKey).first<{ id: string }>();
  const form = new FormData();
  form.set("id", row!.id);
  return { id: row!.id, approve: () => approveCandidate(runtimeEnv, form) };
}

async function queueUnknownCandidate(key: string): Promise<QueuedCandidate> {
  const id = `cand_unknown_${crypto.randomUUID()}`;
  const externalKey = `candidate-dispatch:${runId}:${key}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO memory_candidates (
      id, namespace, external_key, dream_date, action, payload_json,
      source_chunk_ids_json, source_chunks_json, status, created_at, updated_at
    ) VALUES (?, 'default', ?, '2026-07-19', 'unknown_candidate_action', '{}', '[]', '[]', 'pending', ?, ?)`
  ).bind(id, externalKey, now, now).run();
  const form = new FormData();
  form.set("id", id);
  return { id, approve: () => approveCandidate(runtimeEnv, form) };
}

async function expectApproved(candidateId: string, targetId: string): Promise<void> {
  await expect(env.DB.prepare(
    "SELECT status, result_memory_id FROM memory_candidates WHERE namespace = 'default' AND id = ?"
  ).bind(candidateId).first()).resolves.toMatchObject({ status: "approved", result_memory_id: targetId });
}

const fixtures = {
  add: async (): Promise<CandidateFixture> => {
    const candidate = await queueCandidate({
      key: "add",
      action: "add",
      payload: { type: "note", content: `dispatch add memory ${runId}` }
    });
    return {
      candidate,
      verify: async (target) => {
        expect(target).toMatchObject({ type: "note", content: `dispatch add memory ${runId}`, status: "active" });
      }
    };
  },
  excerpt: async (): Promise<CandidateFixture> => {
    const candidate = await queueCandidate({
      key: "excerpt",
      action: "excerpt",
      payload: { quote: "dispatch quoted evidence", reason: "keeps context" }
    });
    return {
      candidate,
      verify: async (target) => {
        expect(target.content).toContain("【2026-07-19 重要原文】\ndispatch quoted evidence");
      }
    };
  },
  diary_split_fact: async (): Promise<CandidateFixture> => {
    const diary = await createMemory(env.DB, {
      namespace: "default",
      type: "diary",
      content: "2026-07-19：dispatch diary evidence appears here",
      source: "cc-manual"
    });
    const candidate = await queueCandidate({
      key: "diary-fact",
      action: "diary_split_fact",
      payload: {
        origin_diary_id: diary.id,
        evidence: "dispatch diary evidence",
        split_item_key: `dispatch-diary-item:${runId}`,
        content: "Dispatch diary fact",
        type: "lesson"
      }
    });
    return {
      candidate,
      verify: async (target) => {
        expect(target).toMatchObject({ type: "lesson", source: "timeline_split" });
      }
    };
  },
  update: async (): Promise<CandidateFixture> => {
    const target = await createMemory(env.DB, {
      namespace: "default",
      type: "note",
      content: "before dispatch update"
    });
    const candidate = await queueCandidate({
      key: "update",
      action: "update",
      targetId: target.id,
      payload: { content: "after dispatch update" }
    });
    return {
      candidate,
      verify: async (updated) => {
        expect(updated).toMatchObject({ id: target.id, content: "after dispatch update" });
      }
    };
  },
  delete: async (): Promise<CandidateFixture> => {
    const target = await createMemory(env.DB, {
      namespace: "default",
      type: "note",
      content: "dispatch delete target"
    });
    const candidate = await queueCandidate({
      key: "delete",
      action: "delete",
      targetId: target.id
    });
    return {
      candidate,
      verify: async (deleted) => {
        expect(deleted).toMatchObject({ id: target.id, status: "deleted" });
      }
    };
  },
  fact_group: async (): Promise<CandidateFixture> => {
    const first = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "dispatch fact A"
    });
    const second = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "dispatch fact B"
    });
    const candidate = await queueCandidate({
      key: "fact-group",
      action: "fact_group",
      payload: { fact_key: "dispatch.fact.group", memory_ids: [first.id, second.id] }
    });
    return {
      candidate,
      verify: async (target) => {
        expect(target).toMatchObject({ id: first.id, fact_key: "dispatch.fact.group" });
        await expect(env.DB.prepare(
          `SELECT relation_type FROM memory_relations
           WHERE namespace = 'default' AND relation_type = 'same_fact_key'
             AND ((source_memory_id = ? AND target_memory_id = ?)
               OR (source_memory_id = ? AND target_memory_id = ?))`
        ).bind(first.id, second.id, second.id, first.id).first()).resolves.toMatchObject({
          relation_type: "same_fact_key"
        });
      }
    };
  }
} satisfies Record<ApprovableCandidateAction, () => Promise<CandidateFixture>>;

describe("generic candidate action dispatch", () => {
  it.each(APPROVABLE_CANDIDATE_ACTIONS)("runs %s through its preserved behavior", async (action) => {
    const fixture = await fixtures[action]();
    const target = await fixture.candidate.approve();
    expect(target).not.toBeNull();
    await expectApproved(fixture.candidate.id, target!.id);
    await fixture.verify(target!);
  });

  it("keeps specialized and unknown actions pending instead of routing them generically", async () => {
    const candidates = [
      await queueCandidate({ key: "closed-relation", action: "relation" }),
      await queueCandidate({ key: "closed-timeline", action: "timeline_date" }),
      await queueUnknownCandidate("closed-unknown")
    ];
    for (const candidate of candidates) {
      await expect(candidate.approve()).resolves.toBeNull();
      await expect(env.DB.prepare(
        "SELECT status FROM memory_candidates WHERE namespace = 'default' AND id = ?"
      ).bind(candidate.id).first()).resolves.toMatchObject({ status: "pending" });
    }
  });

  it("leaves every member unchanged when a fact group member is missing", async () => {
    const first = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "fact group atomic preflight"
    });
    const candidate = await queueCandidate({
      key: "fact-group-missing-member",
      action: "fact_group",
      payload: {
        fact_key: "dispatch.fact.missing",
        memory_ids: [first.id, `mem_missing_${crypto.randomUUID()}`]
      }
    });

    await expect(candidate.approve()).resolves.toBeNull();
    await expect(getMemoryById(env.DB, { namespace: "default", id: first.id }))
      .resolves.toMatchObject({ fact_key: null });
    await expect(env.DB.prepare(
      "SELECT status FROM memory_candidates WHERE namespace = 'default' AND id = ?"
    ).bind(candidate.id).first()).resolves.toMatchObject({ status: "pending" });
  });

  it("rolls back fact keys and candidate state when relation persistence fails", async () => {
    const first = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "fact group rollback A"
    });
    const second = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "fact group rollback B"
    });
    const candidate = await queueCandidate({
      key: "fact-group-relation-failure",
      action: "fact_group",
      payload: {
        fact_key: "dispatch.fact.rollback",
        memory_ids: [first.id, second.id]
      }
    });
    const endpoints = [first.id, second.id].sort();
    await env.DB.prepare("DROP TRIGGER IF EXISTS test_candidate_fact_group_relation_abort").run();
    await env.DB.prepare(
      `CREATE TRIGGER test_candidate_fact_group_relation_abort
       BEFORE INSERT ON memory_relations
       WHEN NEW.source_memory_id = '${endpoints[0]}' AND NEW.target_memory_id = '${endpoints[1]}'
       BEGIN
         SELECT RAISE(ABORT, 'forced fact group relation failure');
       END`
    ).run();
    try {
      await expect(candidate.approve()).rejects.toThrow();
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS test_candidate_fact_group_relation_abort").run();
    }

    await expect(getMemoryById(env.DB, { namespace: "default", id: first.id }))
      .resolves.toMatchObject({ fact_key: null });
    await expect(getMemoryById(env.DB, { namespace: "default", id: second.id }))
      .resolves.toMatchObject({ fact_key: null });
    await expect(env.DB.prepare(
      "SELECT status FROM memory_candidates WHERE namespace = 'default' AND id = ?"
    ).bind(candidate.id).first()).resolves.toMatchObject({ status: "pending" });
  });

  it("commits one memory when the same add candidate is approved concurrently", async () => {
    const content = `concurrent candidate add ${crypto.randomUUID()}`;
    const candidate = await queueCandidate({
      key: "concurrent-add",
      action: "add",
      payload: { type: "note", content }
    });

    const results = await Promise.all([candidate.approve(), candidate.approve()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM memories WHERE namespace = 'default' AND content = ?"
    ).bind(content).first()).resolves.toMatchObject({ count: 1 });
  });
});
