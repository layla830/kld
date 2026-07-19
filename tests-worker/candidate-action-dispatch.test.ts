import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { approveCandidate } from "../src/api/adminBoard/candidateActions";
import { upsertMemoryCandidate } from "../src/db/memoryCandidates";
import { createMemory } from "../src/db/memories";
import type { Env, MemoryRecord } from "../src/types";

const runtimeEnv = { DB: env.DB } as Env;
const runId = crypto.randomUUID();

async function queueCandidate(input: {
  key: string;
  action: string;
  payload?: Record<string, unknown>;
  targetId?: string;
}): Promise<{ id: string; approve(): Promise<MemoryRecord | null> }> {
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

async function expectApproved(candidateId: string, targetId: string): Promise<void> {
  await expect(env.DB.prepare(
    "SELECT status, result_memory_id FROM memory_candidates WHERE namespace = 'default' AND id = ?"
  ).bind(candidateId).first()).resolves.toMatchObject({ status: "approved", result_memory_id: targetId });
}

describe("generic candidate action dispatch", () => {
  it("runs every declared generic approval action through its preserved behavior", async () => {
    const add = await queueCandidate({
      key: "add",
      action: "add",
      payload: { type: "note", content: "dispatch add memory" }
    });
    const added = await add.approve();
    expect(added).toMatchObject({ type: "note", content: "dispatch add memory", status: "active" });
    await expectApproved(add.id, added!.id);

    const excerpt = await queueCandidate({
      key: "excerpt",
      action: "excerpt",
      payload: { quote: "dispatch quoted evidence", reason: "keeps context" }
    });
    const excerpted = await excerpt.approve();
    expect(excerpted?.content).toContain("【2026-07-19 重要原文】\ndispatch quoted evidence");
    await expectApproved(excerpt.id, excerpted!.id);

    const diary = await createMemory(env.DB, {
      namespace: "default",
      type: "diary",
      content: "2026-07-19：dispatch diary evidence appears here",
      source: "cc-manual"
    });
    const diaryFact = await queueCandidate({
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
    const diaryMemory = await diaryFact.approve();
    expect(diaryMemory).toMatchObject({ type: "lesson", source: "timeline_split" });
    await expectApproved(diaryFact.id, diaryMemory!.id);

    const updateTarget = await createMemory(env.DB, {
      namespace: "default",
      type: "note",
      content: "before dispatch update"
    });
    const update = await queueCandidate({
      key: "update",
      action: "update",
      targetId: updateTarget.id,
      payload: { content: "after dispatch update" }
    });
    const updated = await update.approve();
    expect(updated?.content).toBe("after dispatch update");
    await expectApproved(update.id, updateTarget.id);

    const deleteTarget = await createMemory(env.DB, {
      namespace: "default",
      type: "note",
      content: "dispatch delete target"
    });
    const remove = await queueCandidate({
      key: "delete",
      action: "delete",
      targetId: deleteTarget.id
    });
    const deleted = await remove.approve();
    expect(deleted?.status).toBe("deleted");
    await expectApproved(remove.id, deleteTarget.id);

    const factA = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "dispatch fact A"
    });
    const factB = await createMemory(env.DB, {
      namespace: "default",
      type: "project_state",
      content: "dispatch fact B"
    });
    const factGroup = await queueCandidate({
      key: "fact-group",
      action: "fact_group",
      payload: { fact_key: "dispatch.fact.group", memory_ids: [factA.id, factB.id] }
    });
    const grouped = await factGroup.approve();
    expect(grouped).toMatchObject({ id: factA.id, fact_key: "dispatch.fact.group" });
    await expectApproved(factGroup.id, factA.id);
    await expect(env.DB.prepare(
      `SELECT relation_type FROM memory_relations
       WHERE namespace = 'default' AND relation_type = 'same_fact_key'
         AND ((source_memory_id = ? AND target_memory_id = ?)
           OR (source_memory_id = ? AND target_memory_id = ?))`
    ).bind(factA.id, factB.id, factB.id, factA.id).first()).resolves.toMatchObject({
      relation_type: "same_fact_key"
    });
  });

  it("keeps specialized and unknown actions pending instead of routing them generically", async () => {
    for (const action of ["relation", "timeline_date", "unknown_candidate_action"]) {
      const candidate = await queueCandidate({ key: `closed-${action}`, action });
      await expect(candidate.approve()).resolves.toBeNull();
      await expect(env.DB.prepare(
        "SELECT status FROM memory_candidates WHERE namespace = 'default' AND id = ?"
      ).bind(candidate.id).first()).resolves.toMatchObject({ status: "pending" });
    }
  });
});
