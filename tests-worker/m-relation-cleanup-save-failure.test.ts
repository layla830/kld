import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approveMetabolismCandidate } from "../src/api/adminBoard/metabolismActions";
import { createMemory } from "../src/db/memories";
import { scanMetabolismReviewCandidates } from "../src/memory/metabolismReview";

interface CandidateRow {
  id: string;
  status: string;
}

function formFor(id: string): FormData {
  const form = new FormData();
  form.set("id", id);
  return form;
}

async function candidateFor(relationId: string): Promise<CandidateRow | null> {
  return env.DB.prepare(
    `SELECT id, status FROM memory_candidates
     WHERE namespace = 'default' AND external_key = ?`
  ).bind(`m-review:relation:${relationId}`).first<CandidateRow>();
}

async function addSelfLoop(relationId: string, content: string): Promise<void> {
  const memory = await createMemory(env.DB, {
    namespace: "default",
    type: "project_state",
    content,
    thread: "runtime-m-cleanup",
    riskLevel: "low",
    urgencyLevel: "normal",
    tensionScore: 0.1,
    responsePosture: "supportive",
    valence: 0.1,
    arousal: 0.2
  });
  await env.DB.prepare(
    `INSERT INTO memory_relations (
       id, namespace, source_memory_id, target_memory_id, relation_type, strength, reason, created_at
     ) VALUES (?, 'default', ?, ?, 'same_topic', 0.8, 'runtime self-loop', ?)`
  ).bind(relationId, memory.id, memory.id, new Date().toISOString()).run();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("M relation cleanup save recovery", () => {
  it("deletes or closes the reviewed edge when candidate-axis schema is not deployed yet", async () => {
    const existingRelation = "rel_m_schema_lag_existing";
    const previouslyDeletedRelation = "rel_m_schema_lag_deleted";
    await addSelfLoop(existingRelation, "schema lag relation still exists");
    await addSelfLoop(previouslyDeletedRelation, "previous attempt already removed relation");

    await expect(scanMetabolismReviewCandidates(env, "default"))
      .resolves.toMatchObject({ relations: 2 });
    const existingCandidate = await candidateFor(existingRelation);
    const deletedCandidate = await candidateFor(previouslyDeletedRelation);
    expect(existingCandidate?.status).toBe("pending");
    expect(deletedCandidate?.status).toBe("pending");

    await env.DB.prepare("DROP TABLE memory_candidate_axis_runs").run();
    await env.DB.prepare("DELETE FROM memory_relations WHERE namespace = 'default' AND id = ?")
      .bind(previouslyDeletedRelation).run();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(approveMetabolismCandidate(env, formFor(existingCandidate!.id)))
      .resolves.toMatchObject({ action: "m_relation_cleanup", memory: null });
    await expect(approveMetabolismCandidate(env, formFor(deletedCandidate!.id)))
      .resolves.toMatchObject({ action: "m_relation_cleanup", memory: null });

    await expect(env.DB.prepare(
      "SELECT id FROM memory_relations WHERE namespace = 'default' AND id IN (?, ?) LIMIT 1"
    ).bind(existingRelation, previouslyDeletedRelation).first()).resolves.toBeNull();
    await expect(candidateFor(existingRelation)).resolves.toMatchObject({ status: "approved" });
    await expect(candidateFor(previouslyDeletedRelation)).resolves.toMatchObject({ status: "approved" });
    const snapshots = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM memory_events
       WHERE namespace = 'default' AND event_type = 'm_snapshot'
         AND json_extract(payload_json, '$.candidate_id') IN (?, ?)`
    ).bind(existingCandidate!.id, deletedCandidate!.id).first<{ count: number }>();
    expect(snapshots?.count).toBe(2);
  });
});
