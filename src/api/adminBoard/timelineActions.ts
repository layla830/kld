import { getMemoryCandidate, resolveMemoryCandidate } from "../../db/memoryCandidates";
import { createMemoryEvent } from "../../db/memoryEvents";
import { getMemoryById, updateMemory } from "../../db/memories";
import { loadDreamConfig } from "../../config/runtime";
import { extractExplicitDates } from "../../memory/timelineBackfill";
import { rebuildTimelineSequenceForMemory } from "../../memory/timelineRelations";
import type { Env, MemoryRecord } from "../../types";
import { parseTags, readFormText } from "./utils";

function payloadOf(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function approveTimelineCandidate(env: Env, form: FormData): Promise<MemoryRecord | null> {
  const id = readFormText(form, "id");
  if (!id) return null;
  const namespace = loadDreamConfig(env).namespace;
  const candidate = await getMemoryCandidate(env.DB, namespace, id);
  if (!candidate || candidate.status !== "pending" || candidate.action !== "timeline_date" || !candidate.target_id) return null;

  const target = await getMemoryById(env.DB, { namespace, id: candidate.target_id });
  if (!target || target.status !== "active" || target.type === "dream_review") return null;
  const payload = payloadOf(candidate.payload_json);
  const date = typeof payload.date === "string" ? payload.date : "";
  const currentDates = extractExplicitDates(target.content);
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(date) || currentDates.length !== 1 || currentDates[0] !== date) {
    throw new Error("timeline_candidate_is_stale");
  }

  const tags = parseTags(target.tags);
  const conflictingDate = tags.find((tag) => tag.startsWith("date:") && tag !== `date:${date}`);
  if (conflictingDate) throw new Error("timeline_candidate_conflicts_with_existing_date");
  const updated = await updateMemory(env.DB, {
    namespace,
    id: target.id,
    patch: { tags: [...new Set([...tags, `date:${date}`, "timeline"])] }
  });
  if (!updated) return null;
  const sequence = await rebuildTimelineSequenceForMemory(env.DB, updated);
  await createMemoryEvent(env.DB, {
    namespace,
    eventType: "x_timeline_sequence_rebuilt",
    memoryId: updated.id,
    payload: { candidate_id: candidate.id, date, sequence }
  });
  await resolveMemoryCandidate(env.DB, namespace, candidate.id, "approved", updated.id);
  return updated;
}

export async function rejectTimelineCandidate(env: Env, form: FormData): Promise<boolean> {
  const id = readFormText(form, "id");
  if (!id) return false;
  const namespace = loadDreamConfig(env).namespace;
  const candidate = await getMemoryCandidate(env.DB, namespace, id);
  if (!candidate || candidate.status !== "pending" || candidate.action !== "timeline_date") return false;
  return resolveMemoryCandidate(env.DB, namespace, id, "rejected");
}
