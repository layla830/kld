import {
  commitMemoryCandidateApproval,
  getMemoryCandidate,
  resolveMemoryCandidate,
  updateMemoryCandidateEvidence,
  type MemoryCandidateRecord
} from "../../db/memoryCandidates";
import {
  buildMemoryRecord,
  fetchMemoriesByIds,
  getMemoryById,
  prepareMemoryInsert,
  prepareMemoryUpdate,
  type MemoryMutationGuard,
  type UpdateMemoryInput
} from "../../db/memories";
import type { Env, MemoryRecord } from "../../types";
import { isActiveDiarySplitSource } from "../../memory/diaryPolicy";
import {
  isApprovableCandidateAction,
  type ApprovableCandidateAction
} from "../../memory/candidateActionContract";
import { payloadOf, readFormText } from "./utils";
import { prepareMemoryRelationInsert } from "../../db/memoryRelations";
import { syncMemoryVector } from "../../memory/state";
import { assessCandidateQuality } from "../../memory/candidateQuality";
import { canOverrideCandidateValidation } from "../../memory/candidateOverride";
import { createMemoryEvent } from "../../db/memoryEvents";

function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : undefined;
}
function coordinateNumber(value: unknown, min = 0): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(1, value)) : undefined;
}
function tags(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : undefined;
}

function hasOwn(payload: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key);
}

function nullableTextPatch(payload: Record<string, unknown>, key: string): string | null | undefined {
  if (!hasOwn(payload, key)) return undefined;
  if (payload[key] === null) return null;
  return text(payload[key]);
}

function nullableCoordinatePatch(
  payload: Record<string, unknown>,
  key: string,
  min = 0
): number | null | undefined {
  return hasOwn(payload, key) ? coordinateNumber(payload[key], min) : undefined;
}

function quotedEvidence(candidate: Awaited<ReturnType<typeof getMemoryCandidate>>): string[] {
  if (!candidate) return [];
  try {
    const chunks = JSON.parse(candidate.source_chunks_json) as unknown;
    if (!Array.isArray(chunks)) return [];
    return [...new Set(chunks.flatMap((chunk) => {
      if (!chunk || typeof chunk !== "object") return [];
      const quotes = (chunk as { important_quotes?: unknown }).important_quotes;
      return Array.isArray(quotes) ? quotes.map(String).map((quote) => quote.trim()).filter(Boolean) : [];
    }))];
  } catch {
    return [];
  }
}

export type CandidateEvidenceRepairResult = "repaired" | "not_found" | "not_verbatim" | "too_long";

export async function repairCandidateEvidence(env: Env, form: FormData): Promise<CandidateEvidenceRepairResult> {
  const id = readFormText(form, "id");
  const evidence = readFormText(form, "evidence");
  if (!id || !evidence) return "not_found";
  if (evidence.length > 80) return "too_long";
  const candidate = await getMemoryCandidate(env.DB, "default", id);
  if (!candidate || !["pending", "needs_subject_review"].includes(candidate.status)) return "not_found";
  if (!quotedEvidence(candidate).some((quote) => quote.includes(evidence))) return "not_verbatim";

  const payload = payloadOf(candidate.payload_json);
  payload.evidence = evidence;
  const remainingErrors = (candidate.validation_error || "").split(";")
    .map((error) => error.trim()).filter((error) => error && ![
      "missing_evidence", "evidence_too_long", "evidence_not_verbatim_in_source_chunks"
    ].includes(error));
  delete payload.validation_error;
  if (remainingErrors.length > 0) payload.validation_error = remainingErrors.join(";");
  const updated = await updateMemoryCandidateEvidence(
    env.DB, "default", id, payload, remainingErrors.length ? remainingErrors.join(";") : null
  );
  return updated ? "repaired" : "not_found";
}

async function existingDiarySplitMemory(env: Env, namespace: string, itemKey: string): Promise<MemoryRecord | null> {
  return (await env.DB.prepare(
    "SELECT * FROM memories WHERE namespace = ? AND status = 'active' AND source = 'timeline_split' AND tags LIKE ? LIMIT 1"
  ).bind(namespace, `%split_item:${itemKey}%`).first<MemoryRecord>()) ?? null;
}

export function candidateUpdatePatch(payload: Record<string, unknown>): UpdateMemoryInput {
  return {
    content: hasOwn(payload, "content") ? text(payload.content) : undefined,
    type: hasOwn(payload, "type") ? text(payload.type) : undefined,
    factKey: nullableTextPatch(payload, "fact_key"),
    thread: nullableTextPatch(payload, "thread"),
    riskLevel: nullableTextPatch(payload, "risk_level"),
    urgencyLevel: nullableTextPatch(payload, "urgency_level"),
    responsePosture: nullableTextPatch(payload, "response_posture"),
    importance: hasOwn(payload, "importance") ? number(payload.importance) : undefined,
    confidence: hasOwn(payload, "confidence") ? number(payload.confidence) : undefined,
    tensionScore: nullableCoordinatePatch(payload, "tension_score"),
    valence: nullableCoordinatePatch(payload, "valence", -1),
    arousal: nullableCoordinatePatch(payload, "arousal"),
    tags: hasOwn(payload, "tags") ? tags(payload.tags) : undefined
  };
}

export async function rejectCandidate(env: Env, form: FormData): Promise<boolean> {
  const id = readFormText(form, "id");
  return id ? resolveMemoryCandidate(env.DB, "default", id, "rejected") : false;
}

export interface CandidateQualityBatchResult {
  selected: number;
  processed: number;
  skipped: number;
}

const MAX_QUALITY_BATCH_SIZE = 100;

export async function batchRejectLowQualityCandidates(env: Env, form: FormData): Promise<CandidateQualityBatchResult | null> {
  const ids = [...new Set(form.getAll("ids").map(String).map((id) => id.trim()).filter(Boolean))]
    .slice(0, MAX_QUALITY_BATCH_SIZE);
  if (ids.length === 0) return null;

  let processed = 0;
  for (const id of ids) {
    const candidate = await getMemoryCandidate(env.DB, "default", id);
    if (!candidate || !["pending", "needs_subject_review"].includes(candidate.status)) continue;
    if (assessCandidateQuality(candidate).label === "pass") continue;
    if (await resolveMemoryCandidate(env.DB, "default", id, "rejected")) processed += 1;
  }
  return { selected: ids.length, processed, skipped: ids.length - processed };
}

export interface DiaryFactBatchResult {
  decision: "approve" | "reject";
  selected: number;
  processed: number;
  skipped: number;
  targets: MemoryRecord[];
}

const MAX_DIARY_FACT_BATCH_SIZE = 100;

function assertNever(value: never): never {
  throw new Error(`unhandled_candidate_action:${String(value)}`);
}

function combineGuards(...guards: MemoryMutationGuard[]): MemoryMutationGuard {
  return {
    sql: guards.map((guard) => `(${guard.sql})`).join(" AND "),
    binds: guards.flatMap((guard) => guard.binds)
  };
}

function candidateApprovalGuard(candidate: MemoryCandidateRecord): MemoryMutationGuard {
  return {
    sql: `EXISTS (
      SELECT 1 FROM memory_candidates
      WHERE namespace = ? AND id = ? AND status = ?
    )`,
    binds: [candidate.namespace, candidate.id, candidate.status]
  };
}

function memoryExistsGuard(namespace: string, memoryId: string): MemoryMutationGuard {
  return {
    sql: "EXISTS (SELECT 1 FROM memories WHERE namespace = ? AND id = ?)",
    binds: [namespace, memoryId]
  };
}

async function commitApproval(
  env: Env,
  candidate: MemoryCandidateRecord,
  targetId: string,
  businessStatements: D1PreparedStatement[],
  successGuard: MemoryMutationGuard
): Promise<MemoryRecord | null> {
  const committed = await commitMemoryCandidateApproval(env.DB, {
    namespace: candidate.namespace,
    id: candidate.id,
    expectedStatus: candidate.status,
    resultMemoryId: targetId,
    businessStatements,
    successGuard
  });
  return committed
    ? getMemoryById(env.DB, { namespace: candidate.namespace, id: targetId })
    : null;
}

export async function batchReviewDiaryFactCandidates(env: Env, form: FormData): Promise<DiaryFactBatchResult | null> {
  const decision = readFormText(form, "decision");
  if (decision !== "approve" && decision !== "reject") return null;
  const ids = [...new Set(form.getAll("ids").map(String).map((id) => id.trim()).filter(Boolean))]
    .slice(0, MAX_DIARY_FACT_BATCH_SIZE);
  if (ids.length === 0) return null;

  const targets: MemoryRecord[] = [];
  let processed = 0;
  for (const id of ids) {
    const candidate = await getMemoryCandidate(env.DB, "default", id);
    if (!candidate || candidate.status !== "pending" || candidate.action !== "diary_split_fact") continue;
    const itemForm = new FormData();
    itemForm.set("id", id);
    if (decision === "approve") {
      const target = await approveCandidate(env, itemForm);
      if (!target) continue;
      targets.push(target);
    } else if (!(await rejectCandidate(env, itemForm))) {
      continue;
    }
    processed += 1;
  }

  return { decision, selected: ids.length, processed, skipped: ids.length - processed, targets };
}

async function approveCreateCandidate(
  env: Env,
  candidate: MemoryCandidateRecord,
  payload: Record<string, unknown>,
  action: "add" | "excerpt",
  validationOverride: boolean
): Promise<MemoryRecord | null> {
  const content = action === "excerpt"
    ? `【${candidate.dream_date} 重要原文】\n${text(payload.quote) ?? ""}${text(payload.reason) ? `\n保存原因：${text(payload.reason)}` : ""}`
    : text(payload.content) ?? "";
  if (!content.trim()) return null;
  const record = buildMemoryRecord({
    namespace: candidate.namespace,
    type: text(payload.type) ?? (action === "excerpt" ? "excerpt" : "note"),
    content,
    factKey: text(payload.fact_key) ?? null,
    thread: text(payload.thread) ?? null,
    riskLevel: text(payload.risk_level) ?? null,
    urgencyLevel: text(payload.urgency_level) ?? null,
    tensionScore: number(payload.tension_score),
    responsePosture: text(payload.response_posture) ?? null,
    importance: number(payload.importance) ?? 0.7,
    confidence: number(payload.confidence) ?? 0.82,
    status: "active",
    pinned: false,
    tags: tags(payload.tags),
    source: validationOverride ? "vps-dream-candidate-override" : "vps-dream-candidate",
    sourceMessageIds: [],
    expiresAt: null
  });
  return commitApproval(
    env,
    candidate,
    record.id,
    [prepareMemoryInsert(env.DB, record, candidateApprovalGuard(candidate))],
    memoryExistsGuard(candidate.namespace, record.id)
  );
}

async function approveDiarySplitFact(
  env: Env,
  candidate: MemoryCandidateRecord,
  payload: Record<string, unknown>
): Promise<MemoryRecord | null> {
  const diaryId = text(payload.origin_diary_id);
  const evidence = text(payload.evidence);
  const itemKey = text(payload.split_item_key);
  const content = text(payload.content);
  const memoryType = text(payload.type);
  if (!diaryId || !evidence || !itemKey || !content || !memoryType
    || !["rule", "preference", "project_state", "lesson"].includes(memoryType)) return null;
  const diary = await getMemoryById(env.DB, { namespace: candidate.namespace, id: diaryId });
  if (!diary || !isActiveDiarySplitSource(diary) || !diary.content.includes(evidence)) return null;
  const existing = await existingDiarySplitMemory(env, candidate.namespace, itemKey);
  const diaryGuard: MemoryMutationGuard = {
    sql: `EXISTS (
      SELECT 1 FROM memories
      WHERE namespace = ? AND id = ? AND status = 'active' AND type = 'diary'
        AND instr(content, ?) > 0
    )`,
    binds: [candidate.namespace, diaryId, evidence]
  };
  if (existing) {
    return commitApproval(
      env,
      candidate,
      existing.id,
      [],
      combineGuards(memoryExistsGuard(candidate.namespace, existing.id), diaryGuard)
    );
  }
  const record = buildMemoryRecord({
    namespace: candidate.namespace,
    type: memoryType,
    content,
    summary: text(payload.summary) ?? null,
    factKey: text(payload.fact_key) ?? null,
    importance: number(payload.importance) ?? 0.7,
    confidence: number(payload.confidence) ?? 0.82,
    status: "active",
    pinned: false,
    tags: [...new Set([
      ...(tags(payload.tags) ?? []),
      `origin:${diary.id}`,
      `split_item:${itemKey}`,
      "split_version:v2"
    ])],
    source: "timeline_split",
    sourceMessageIds: [diary.id],
    expiresAt: null
  });
  return commitApproval(
    env,
    candidate,
    record.id,
    [prepareMemoryInsert(env.DB, record, combineGuards(candidateApprovalGuard(candidate), diaryGuard))],
    combineGuards(memoryExistsGuard(candidate.namespace, record.id), diaryGuard)
  );
}

async function approveUpdateCandidate(
  env: Env,
  candidate: MemoryCandidateRecord,
  payload: Record<string, unknown>
): Promise<MemoryRecord | null> {
  if (!candidate.target_id
    || !(await getMemoryById(env.DB, { namespace: candidate.namespace, id: candidate.target_id }))) return null;
  const statement = prepareMemoryUpdate(env.DB, {
    namespace: candidate.namespace,
    id: candidate.target_id,
    patch: candidateUpdatePatch(payload),
    guard: candidateApprovalGuard(candidate),
    markVectorUnsynced: true
  });
  return commitApproval(
    env,
    candidate,
    candidate.target_id,
    statement ? [statement] : [],
    memoryExistsGuard(candidate.namespace, candidate.target_id)
  );
}

async function approveDeleteCandidate(
  env: Env,
  candidate: MemoryCandidateRecord
): Promise<MemoryRecord | null> {
  if (!candidate.target_id
    || !(await getMemoryById(env.DB, { namespace: candidate.namespace, id: candidate.target_id }))) return null;
  const statement = prepareMemoryUpdate(env.DB, {
    namespace: candidate.namespace,
    id: candidate.target_id,
    patch: { status: "deleted" },
    guard: candidateApprovalGuard(candidate),
    markVectorUnsynced: true
  });
  return commitApproval(
    env,
    candidate,
    candidate.target_id,
    statement ? [statement] : [],
    memoryExistsGuard(candidate.namespace, candidate.target_id)
  );
}

async function approveFactGroup(
  env: Env,
  candidate: MemoryCandidateRecord,
  payload: Record<string, unknown>
): Promise<MemoryRecord | null> {
  const factKey = text(payload.fact_key);
  const ids = Array.isArray(payload.memory_ids)
    ? [...new Set(payload.memory_ids.map(String))].slice(0, 8)
    : [];
  if (!factKey || ids.length < 2) return null;
  const existing = await fetchMemoriesByIds(env.DB, { namespace: candidate.namespace, ids });
  const existingIds = new Set(existing.map((memory) => memory.id));
  if (existingIds.size !== ids.length || ids.some((id) => !existingIds.has(id))) return null;

  const placeholders = ids.map(() => "?").join(", ");
  const membersExistGuard: MemoryMutationGuard = {
    sql: `(SELECT COUNT(*) FROM memories WHERE namespace = ? AND id IN (${placeholders})) = ?`,
    binds: [candidate.namespace, ...ids, ids.length]
  };
  const transactionGuard = combineGuards(candidateApprovalGuard(candidate), membersExistGuard);
  const statements: D1PreparedStatement[] = ids.map((memoryId) => {
    const statement = prepareMemoryUpdate(env.DB, {
      namespace: candidate.namespace,
      id: memoryId,
      patch: { factKey },
      guard: transactionGuard,
      markVectorUnsynced: true
    });
    if (!statement) throw new Error("fact_group_update_statement_missing");
    return statement;
  });
  for (const memoryId of ids.slice(1)) {
    const statement = prepareMemoryRelationInsert(env.DB, {
      namespace: candidate.namespace,
      sourceMemoryId: ids[0],
      targetMemoryId: memoryId,
      relationType: "same_fact_key",
      strength: 0.92,
      reason: "approved fact group"
    }, transactionGuard);
    if (!statement) throw new Error("fact_group_relation_statement_missing");
    statements.push(statement);
  }
  const appliedGuard: MemoryMutationGuard = {
    sql: `(SELECT COUNT(*) FROM memories
      WHERE namespace = ? AND id IN (${placeholders}) AND fact_key = ?) = ?`,
    binds: [candidate.namespace, ...ids, factKey, ids.length]
  };
  const target = await commitApproval(env, candidate, ids[0], statements, appliedGuard);
  if (!target) return null;
  const updated = await fetchMemoriesByIds(env.DB, { namespace: candidate.namespace, ids });
  await Promise.all(updated.map((memory) => syncMemoryVector(env, memory)));
  return target;
}

async function approveByAction(
  env: Env,
  candidate: MemoryCandidateRecord,
  payload: Record<string, unknown>,
  action: ApprovableCandidateAction,
  validationOverride: boolean
): Promise<MemoryRecord | null> {
  switch (action) {
    case "add":
    case "excerpt":
      return approveCreateCandidate(env, candidate, payload, action, validationOverride);
    case "diary_split_fact":
      return approveDiarySplitFact(env, candidate, payload);
    case "update":
      return approveUpdateCandidate(env, candidate, payload);
    case "delete":
      return approveDeleteCandidate(env, candidate);
    case "fact_group":
      return approveFactGroup(env, candidate, payload);
    default:
      return assertNever(action);
  }
}

export async function approveCandidate(env: Env, form: FormData): Promise<MemoryRecord | null> {
  const id = readFormText(form, "id");
  if (!id) return null;
  const candidate = await getMemoryCandidate(env.DB, "default", id);
  if (!candidate || !isApprovableCandidateAction(candidate.action)) return null;
  const overrideRequested = readFormText(form, "override_validation") === "1";
  const validationOverride = overrideRequested && canOverrideCandidateValidation(candidate);
  if (candidate.status !== "pending" && !validationOverride) return null;
  const payload = payloadOf(candidate.payload_json);
  if (validationOverride) {
    await createMemoryEvent(env.DB, {
      namespace: "default",
      eventType: "memory_candidate_validation_override_requested",
      memoryId: candidate.target_id,
      payload: {
        candidate_id: candidate.id,
        action: candidate.action,
        validation_error: candidate.validation_error,
        policy: "explicit_admin_override"
      }
    });
  }
  const target = await approveByAction(env, candidate, payload, candidate.action, validationOverride);
  if (!target) return null;
  if (validationOverride) {
    await createMemoryEvent(env.DB, {
      namespace: "default",
      eventType: "memory_candidate_validation_override_applied",
      memoryId: target.id,
      payload: {
        candidate_id: candidate.id,
        action: candidate.action,
        validation_error: candidate.validation_error,
        result_memory_id: target.id,
        policy: "explicit_admin_override"
      }
    });
  }
  return target;
}
