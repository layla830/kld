import { listMessagesByNamespaceInRange } from "../../db/messages";
import { getMemoryById, listMemories } from "../../db/memories";
import { readCursor, writeCursor } from "../../db/retention";
import { upsertSummary } from "../../db/summaries";
import {
  createMemoryRelation,
  normalizeRelationType,
  REVIEW_RELATION_TYPES,
  SAFE_RELATION_TYPES
} from "../../db/memoryRelations";
import { loadDreamConfig, systemClock, type AppClock } from "../../config/runtime";
import { queueRelationReviewCandidate } from "../relationReview";
import { createSyncedMemory } from "../state";
import { toMemoryApiRecord } from "../search";
import type { Env, MemoryApiRecord, MemoryRecord } from "../../types";
import {
  readDailyCursor,
  getDateRangeForLabel,
  getTargetDigestDateLabel
} from "./timeWindow";
import { buildDigestPrompt } from "./prompt";
import { callDigestModel } from "./modelClient";
import {
  cleanEmptyMemories,
  collectSnapshot,
  formatDailySummary,
  queueMemoryMutationReviews,
  recordDreamSnapshot,
  recordDryRunPlan,
  saveDailySummaryMemory,
  saveImportantExcerpts
} from "./persistence";
import { readString } from "./parser";
import type { DailyDigestRunResult, DailyDigestStats } from "./schema";

export async function runDailyMemoryDigest(
  env: Env,
  namespace: string,
  options: { dateLabel?: string; force?: boolean; clock?: AppClock } = {}
): Promise<DailyDigestRunResult> {
  const config = loadDreamConfig(env);
  const clock = options.clock ?? systemClock;
  if (!config.enabled) return { ran: false, mode: "dream", reason: "dream_disabled" };

  const dryRun = config.dryRun;
  const timeZone = config.timeZone;
  const dateLabel = readString(options.dateLabel) || getTargetDigestDateLabel(timeZone, clock.now());
  const { startIso, endIso } = getDateRangeForLabel(dateLabel, timeZone);
  const cursorName = `dream:${namespace}:${dateLabel}`;
  const cursor = await readCursor(env.DB, cursorName);
  const cursorState = options.force ? { done: false, after: null } : readDailyCursor(cursor, startIso, endIso);
  if (cursorState.done) {
    return { ran: false, mode: "dream", date: dateLabel, reason: "already_done", startIso, endIso, cursor };
  }

  const maxMessages = config.maxMessages;
  const messages = await listMessagesByNamespaceInRange(env.DB, {
    namespace,
    startCreatedAt: startIso,
    endCreatedAt: endIso,
    afterCreatedAt: cursorState.after,
    limit: maxMessages
  });
  if (messages.length === 0) {
    await writeCursor(env.DB, cursorName, `done:${cursorState.after ?? startIso}`);
    return { ran: false, mode: "dream", date: dateLabel, reason: "no_messages", startIso, endIso, cursor };
  }

  const lastMessage = messages[messages.length - 1];
  const hasMore = messages.length >= maxMessages;
  const memoryContextLimit = config.memoryContextLimit;
  let existingMemories: MemoryApiRecord[] = [];
  try {
    const records = await listMemories(env.DB, { namespace, status: "active", limit: memoryContextLimit });
    existingMemories = records.map((record) => toMemoryApiRecord(record));
  } catch (error) {
    console.error("dream: failed to list existing memories", error);
  }

  const cleanedEmptyMemories = dryRun ? 0 : await cleanEmptyMemories(env, namespace, config.emptyMemoryMinChars);

  const prompt = buildDigestPrompt({
    dateLabel,
    startIso,
    endIso,
    messages,
    existingMemories,
    excerptLimit: config.excerptLimit,
    hasMore
  });
  const modelResult = await callDigestModel(env, prompt, {
    dateLabel,
    messageCount: messages.length,
    memoryCount: existingMemories.length,
    hasMore
  }, config, clock);
  const digest = modelResult.digest;
  if (!digest) {
    console.error("dream: model did not return valid JSON; cursor not advanced", {
      reason: modelResult.reason,
      model: modelResult.model,
      status: modelResult.status
    });
    return {
      ran: false,
      mode: "dream",
      date: dateLabel,
      reason: modelResult.reason ?? "model_error",
      startIso,
      endIso,
      cursor,
      processedMessages: messages.length,
      model: modelResult.model,
      status: modelResult.status,
      finishReason: modelResult.finishReason
    };
  }

  const messageIds = messages.map((message) => message.id);

  if (dryRun) {
    await recordDryRunPlan(env, { namespace, dateLabel, digest, messageIds });
    await writeCursor(env.DB, cursorName, hasMore ? lastMessage.created_at : `done:${lastMessage.created_at}`);
    console.log("dream: dry-run plan recorded", { date: dateLabel, namespace, hasMore });
    return {
      ran: true,
      stats: {
        date: dateLabel,
        mode: "dream",
        dryRun: true,
        processedMessages: messages.length,
        addedMemories: 0,
        updatedMemories: 0,
        deletedMemories: 0,
        updateReviewsQueued: (digest.memories_to_update ?? []).length,
        deleteReviewsQueued: (digest.memories_to_delete ?? []).length,
        savedExcerpts: 0,
        cleanedEmptyMemories: 0,
        cursorAdvanced: true,
        hasMore
      },
      plan: digest
    };
  }

  const summaryContent = formatDailySummary(digest, dateLabel, messages);

  const snapshotData = await collectSnapshot(env, namespace);
  await recordDreamSnapshot(env, { namespace, dateLabel, memoryIds: snapshotData.ids, memorySnapshot: snapshotData.snapshot });

  await upsertSummary(env.DB, {
    namespace,
    content: summaryContent,
    fromMessageId: messages[0]?.id ?? null,
    toMessageId: lastMessage.id,
    messageCount: messages.length
  });
  if (config.saveDailySummaryMemory) {
    await saveDailySummaryMemory(env, { namespace, dateLabel, content: summaryContent, messageIds });
  }

  const mutationReviews = await queueMemoryMutationReviews(env, {
    namespace,
    updates: digest.memories_to_update ?? [],
    deletes: digest.memories_to_delete ?? []
  });

  let addedMemories = 0;
  const placeholderToId = new Map<string, string>();
  const memoriesToAdd = digest.memories_to_add ?? [];
  for (let index = 0; index < memoriesToAdd.length; index += 1) {
    const memory = memoriesToAdd[index];
    const saved = await createSyncedMemory(env, {
      namespace,
      type: memory.type,
      content: memory.content,
      importance: memory.importance,
      confidence: memory.confidence,
      tags: memory.tags,
      factKey: memory.fact_key,
      thread: memory.thread,
      riskLevel: memory.risk_level,
      urgencyLevel: memory.urgency_level,
      tensionScore: memory.tension_score,
      responsePosture: memory.response_posture,
      valence: memory.valence,
      arousal: memory.arousal,
      source: "dream",
      sourceMessageIds: memory.source_message_ids.length ? memory.source_message_ids : messageIds
    });
    if (saved) {
      addedMemories += 1;
      placeholderToId.set(`add_${index}`, saved.id);
    }
  }

  const savedExcerpts = await saveImportantExcerpts(env, {
    namespace,
    dateLabel,
    excerpts: digest.important_excerpts ?? [],
    fallbackMessageIds: messageIds,
    limit: config.excerptLimit
  });

  let relationsInserted = 0;
  let relationsReview = 0;
  for (const hint of digest.relation_hints ?? []) {
    const sourceId = placeholderToId.get(hint.source_id) ?? (hint.source_id.startsWith("mem_") ? hint.source_id : null);
    const targetId = placeholderToId.get(hint.target_id) ?? (hint.target_id.startsWith("mem_") ? hint.target_id : null);
    if (!sourceId || !targetId || sourceId === targetId) continue;
    const relationType = normalizeRelationType(hint.relation_type);
    if (relationType === "none") continue;
    if (SAFE_RELATION_TYPES.has(relationType) && relationType !== "temporal_sequence") {
      if (await createMemoryRelation(env.DB, {
        namespace,
        sourceMemoryId: sourceId,
        targetMemoryId: targetId,
        relationType,
        strength: hint.strength ?? 0.6,
        reason: hint.reason ?? null
      })) {
        relationsInserted += 1;
      }
    } else if (REVIEW_RELATION_TYPES.has(relationType)) {
      const [source, target] = await Promise.all([
        getMemoryById(env.DB, { namespace, id: sourceId }),
        getMemoryById(env.DB, { namespace, id: targetId })
      ]);
      if (!source || source.status !== "active" || !target || target.status !== "active") continue;
      await queueRelationReviewCandidate(env, namespace, {
        relationType,
        source,
        target,
        strength: hint.strength ?? 0.6,
        reason: hint.reason ?? null,
        projectionKey: `dream:${dateLabel}`
      });
      relationsReview += 1;
    }
  }

  await writeCursor(env.DB, cursorName, hasMore ? lastMessage.created_at : `done:${lastMessage.created_at}`);

  return {
    ran: true,
    stats: {
      date: dateLabel,
      mode: "dream",
      dryRun: false,
      processedMessages: messages.length,
      addedMemories,
      updatedMemories: 0,
      deletedMemories: 0,
      updateReviewsQueued: mutationReviews.updateReviewsQueued,
      deleteReviewsQueued: mutationReviews.deleteReviewsQueued,
      savedExcerpts,
      cleanedEmptyMemories,
      cursorAdvanced: true,
      hasMore,
      relationsInserted,
      relationsReview
    } as DailyDigestStats & { relationsInserted: number; relationsReview: number }
  };
}
