import {
  commitMemoryCandidateApproval,
  getMemoryCandidate,
  resolveMemoryCandidate
} from "../../db/memoryCandidates";
import { createMemoryEvent, prepareMemoryEventInsert } from "../../db/memoryEvents";
import { getMemoryById, prepareMemoryUpdate } from "../../db/memories";
import {
  combineMutationGuards,
  memoryCandidateStatusGuard,
  memoryEventExistsGuard
} from "../../db/mutationGuards";
import { loadDreamConfig } from "../../config/runtime";
import { rebuildDiaryTimelineForMemory } from "../../memory/diaryTimeline";
import { extractExplicitDates } from "../../memory/timelineBackfill";
import { rebuildTimelineSequenceForMemory } from "../../memory/timelineRelations";
import { analyzeTimelineDateTags, parseTimelineDate } from "../../memory/timelineDates";
import type { Env, MemoryRecord } from "../../types";
import { nowIso } from "../../utils/time";
import { parseTags, payloadOf, readFormText } from "./utils";

export type TimelineCandidateErrorCode = "invalid_date" | "stale" | "date_conflict";

export class TimelineCandidateError extends Error {
  constructor(readonly code: TimelineCandidateErrorCode) {
    super(`timeline_candidate_${code}`);
    this.name = "TimelineCandidateError";
  }
}

export function timelineCandidateNotice(error: unknown): string {
  return error instanceof TimelineCandidateError ? `timeline-${error.code.replaceAll("_", "-")}` : "error";
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
  if (!date) throw new TimelineCandidateError("invalid_date");
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
      throw new TimelineCandidateError("stale");
    }
  } else if (currentDates.length !== 1 || currentDates[0] !== date) {
    throw new TimelineCandidateError("stale");
  } else if (tags.some((tag) => tag.startsWith("date:") && tag !== `date:${date}`)) {
    throw new TimelineCandidateError("date_conflict");
  }
  const mutationAt = nowIso();
  const candidateGuard = memoryCandidateStatusGuard(namespace, candidate.id, "pending");
  const statement = prepareMemoryUpdate(env.DB, {
    namespace,
    id: target.id,
    patch: {
      tags: [...new Set([...tags.filter((tag) => !tag.startsWith("date:")), `date:${date}`, "timeline"])]
    },
    expectedStatus: "active",
    expectedRevision: target.five_axis_revision ?? 1,
    guard: candidateGuard,
    markVectorUnsynced: true,
    now: mutationAt
  });
  if (!statement) return null;
  const approvalEventId = `ev_x_timeline_approved_${candidate.id}`;
  const memoryUpdatedGuard = {
    sql: "EXISTS (SELECT 1 FROM memories WHERE namespace = ? AND id = ? AND status = 'active' AND updated_at = ?)",
    binds: [namespace, target.id, mutationAt]
  };
  const approvalEvent = prepareMemoryEventInsert(env.DB, {
    namespace,
    eventType: "x_timeline_candidate_approved",
    memoryId: target.id,
    payload: { candidate_id: candidate.id, date }
  }, {
    id: approvalEventId,
    now: mutationAt,
    guard: combineMutationGuards(candidateGuard, memoryUpdatedGuard)
  });
  const committed = await commitMemoryCandidateApproval(env.DB, {
    namespace,
    id: candidate.id,
    expectedStatus: "pending",
    resultMemoryId: target.id,
    businessStatements: [statement, approvalEvent],
    successGuard: combineMutationGuards(
      memoryUpdatedGuard,
      memoryEventExistsGuard(namespace, approvalEventId)
    )
  });
  if (!committed) return null;
  const updated = await getMemoryById(env.DB, { namespace, id: target.id });
  if (!updated) throw new Error("timeline_candidate_target_missing_after_commit");
  const ordinarySequence = await rebuildTimelineSequenceForMemory(env.DB, updated);
  const owner = updated.source === "timeline_split" ? "diary" : "sequence";
  const sequence = owner === "diary"
    ? await rebuildDiaryTimelineForMemory(env.DB, updated)
    : ordinarySequence;
  await createMemoryEvent(env.DB, {
    namespace,
    eventType: "x_timeline_sequence_rebuilt",
    memoryId: updated.id,
    payload: { candidate_id: candidate.id, date, owner, sequence }
  });
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
