import { createMemoryEvent } from "../../db/memoryEvents";
import { getMemoryCandidate, resolveMemoryCandidate } from "../../db/memoryCandidates";
import { getMemoryById, updateMemory } from "../../db/memories";
import type { Env, MemoryRecord } from "../../types";
import { nowIso } from "../../utils/time";
import { PROTECTED_MEMORY_TYPES } from "../../memory/metabolismReview";
import { readFormText } from "./utils";

type MetabolismAction = "m_archive" | "m_relation_cleanup";
type MetabolismResult = { memory: MemoryRecord | null; action: MetabolismAction | "rollback" };

function payloadOf(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function beforeOf(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.before && typeof payload.before === "object" ? payload.before as Record<string, unknown> : {};
}

async function snapshot(env: Env, candidateId: string, action: MetabolismAction, before: Record<string, unknown>): Promise<void> {
  await createMemoryEvent(env.DB, {
    namespace: "default",
    eventType: "m_snapshot",
    payload: { candidate_id: candidateId, action, before }
  });
}

export async function approveMetabolismCandidate(env: Env, form: FormData): Promise<MetabolismResult | null> {
  const id = readFormText(form, "id");
  if (!id) return null;
  const candidate = await getMemoryCandidate(env.DB, "default", id);
  if (!candidate || candidate.status !== "pending" || !["m_archive", "m_relation_cleanup"].includes(candidate.action)) return null;
  const action = candidate.action as MetabolismAction;
  const before = beforeOf(payloadOf(candidate.payload_json));

  if (action === "m_archive") {
    if (!candidate.target_id) return null;
    const target = await getMemoryById(env.DB, { namespace: "default", id: candidate.target_id });
    if (!target || target.status !== "active" || target.pinned || target.type !== "project_state" || PROTECTED_MEMORY_TYPES.has(target.type)) return null;
    if (!target.expires_at || new Date(target.expires_at).getTime() >= Date.now()) throw new Error("metabolism_candidate_is_stale");
    await snapshot(env, candidate.id, action, before);
    const archived = await updateMemory(env.DB, {
      namespace: "default",
      id: target.id,
      patch: { status: "archived", activeFact: false },
      expectedStatus: "active",
      requireUnpinned: true
    });
    if (!archived) return null;
    await resolveMemoryCandidate(env.DB, "default", candidate.id, "approved", archived.id);
    return { memory: archived, action };
  }

  const relationId = typeof before.id === "string" ? before.id : "";
  if (!relationId) return null;
  const existing = await env.DB.prepare("SELECT * FROM memory_relations WHERE namespace = ? AND id = ?")
    .bind("default", relationId).first<Record<string, unknown>>();
  if (!existing) throw new Error("metabolism_relation_candidate_is_stale");
  for (const key of ["source_memory_id", "target_memory_id", "relation_type"]) {
    if (existing[key] !== before[key]) throw new Error("metabolism_relation_candidate_changed");
  }
  await snapshot(env, candidate.id, action, before);
  const deleted = await env.DB.prepare("DELETE FROM memory_relations WHERE namespace = ? AND id = ?")
    .bind("default", relationId).run();
  if ((deleted.meta.changes ?? 0) !== 1) return null;
  await resolveMemoryCandidate(env.DB, "default", candidate.id, "approved");
  return { memory: null, action };
}

export async function rejectMetabolismCandidate(env: Env, form: FormData): Promise<boolean> {
  const id = readFormText(form, "id");
  if (!id) return false;
  const candidate = await getMemoryCandidate(env.DB, "default", id);
  if (!candidate || candidate.status !== "pending" || !candidate.action.startsWith("m_")) return false;
  return resolveMemoryCandidate(env.DB, "default", id, "rejected");
}

export async function rollbackMetabolismCandidate(env: Env, form: FormData): Promise<MetabolismResult | null> {
  const id = readFormText(form, "id");
  if (!id) return null;
  const candidate = await getMemoryCandidate(env.DB, "default", id);
  if (!candidate || candidate.status !== "approved" || !["m_archive", "m_relation_cleanup"].includes(candidate.action)) return null;
  const before = beforeOf(payloadOf(candidate.payload_json));
  let memory: MemoryRecord | null = null;

  if (candidate.action === "m_archive") {
    if (!candidate.target_id) return null;
    const current = await getMemoryById(env.DB, { namespace: "default", id: candidate.target_id });
    if (!current || current.status !== "archived") throw new Error("metabolism_rollback_target_changed");
    memory = await updateMemory(env.DB, {
      namespace: "default",
      id: current.id,
      patch: {
        status: typeof before.status === "string" ? before.status : "active",
        activeFact: before.active_fact !== 0
      },
      expectedStatus: "archived"
    });
    if (!memory) return null;
  } else {
    const required = ["id", "namespace", "source_memory_id", "target_memory_id", "relation_type", "strength", "created_at"];
    if (required.some((key) => before[key] === undefined || before[key] === null)) return null;
    const restored = await env.DB.prepare(
      `INSERT OR IGNORE INTO memory_relations
       (id, namespace, source_memory_id, target_memory_id, relation_type, strength, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      before.id, before.namespace, before.source_memory_id, before.target_memory_id,
      before.relation_type, before.strength, before.reason ?? null, before.created_at
    ).run();
    if ((restored.meta.changes ?? 0) !== 1) throw new Error("metabolism_relation_rollback_conflict");
  }

  const updated = await env.DB.prepare(
    "UPDATE memory_candidates SET status = 'rolled_back', resolved_at = ?, updated_at = ? WHERE namespace = ? AND id = ? AND status = 'approved'"
  ).bind(nowIso(), nowIso(), "default", candidate.id).run();
  if ((updated.meta.changes ?? 0) !== 1) throw new Error("metabolism_rollback_state_conflict");
  await createMemoryEvent(env.DB, {
    namespace: "default",
    eventType: "m_rollback",
    payload: { candidate_id: candidate.id, action: candidate.action, restored: before }
  });
  return { memory, action: "rollback" };
}
