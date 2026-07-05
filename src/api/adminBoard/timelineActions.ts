import { getMemoryCandidate, resolveMemoryCandidate } from "../../db/memoryCandidates";
import { getMemoryById, updateMemory } from "../../db/memories";
import { extractExplicitDates } from "../../memory/timelineBackfill";
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
  const candidate = await getMemoryCandidate(env.DB, "default", id);
  if (!candidate || candidate.status !== "pending" || candidate.action !== "timeline_date" || !candidate.target_id) return null;

  const target = await getMemoryById(env.DB, { namespace: "default", id: candidate.target_id });
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
    namespace: "default",
    id: target.id,
    patch: { tags: [...new Set([...tags, `date:${date}`, "timeline"])] }
  });
  if (!updated) return null;
  await resolveMemoryCandidate(env.DB, "default", candidate.id, "approved", updated.id);
  return updated;
}

export async function rejectTimelineCandidate(env: Env, form: FormData): Promise<boolean> {
  const id = readFormText(form, "id");
  if (!id) return false;
  const candidate = await getMemoryCandidate(env.DB, "default", id);
  if (!candidate || candidate.status !== "pending" || candidate.action !== "timeline_date") return false;
  return resolveMemoryCandidate(env.DB, "default", id, "rejected");
}
