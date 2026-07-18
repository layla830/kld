import { getMemoryCandidate, resolveMemoryCandidate } from "../../db/memoryCandidates";
import { createMemoryEvent } from "../../db/memoryEvents";
import { getMemoryById, updateMemory } from "../../db/memories";
import { loadDreamConfig } from "../../config/runtime";
import { extractExplicitDates } from "../../memory/timelineBackfill";
import { rebuildTimelineSequenceForMemory } from "../../memory/timelineRelations";
import { analyzeTimelineDateTags, parseTimelineDate } from "../../memory/timelineDates";
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
  const repair = payload._kind === "timeline_date_repair";
  const requestedDate = readFormText(form, "date") || (typeof payload.date === "string" ? payload.date : "");
  const date = parseTimelineDate(requestedDate);
  if (!date) throw new Error("timeline_candidate_has_invalid_date");
  const currentDates = extractExplicitDates(target.content);
  const tags = parseTags(target.tags);
  if (repair) {
    const beforeTags = Array.isArray(payload.before_tags) ? payload.before_tags.map(String) : [];
    const options = Array.isArray(payload.date_options)
      ? payload.date_options.map(String).map(parseTimelineDate).filter((value): value is string => Boolean(value))
      : [];
    const currentOptions = [...new Set([
      ...analyzeTimelineDateTags(tags).validDates,
      ...currentDates
    ])].sort();
    if (JSON.stringify(tags) !== JSON.stringify(beforeTags)
      || JSON.stringify(currentOptions) !== JSON.stringify([...new Set(options)].sort())
      || (options.length > 0 && !options.includes(date))
      || (options.length === 0 && payload.allow_manual_date !== true)) {
      throw new Error("timeline_candidate_is_stale");
    }
  } else if (currentDates.length !== 1 || currentDates[0] !== date) {
    throw new Error("timeline_candidate_is_stale");
  } else if (tags.some((tag) => tag.startsWith("date:") && tag !== `date:${date}`)) {
    throw new Error("timeline_candidate_conflicts_with_existing_date");
  }
  const updated = await updateMemory(env.DB, {
    namespace,
    id: target.id,
    patch: {
      tags: [...new Set([...tags.filter((tag) => !tag.startsWith("date:")), `date:${date}`, "timeline"])]
    }
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
