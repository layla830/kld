import { authenticate } from "../auth/apiKey";
import { requireScope } from "../auth/scopes";
import { upsertMemoryCandidate, type CandidateInput } from "../db/memoryCandidates";
import { createMemoryEvent } from "../db/memoryEvents";
import { fetchMemoriesByIds } from "../db/memories";
import {
  applyDreamCandidatePolicy,
  applyDreamDeleteTargetPolicy,
  type DreamCandidatePolicyDecision
} from "../memory/dreamCandidatePolicy";
import { isDreamIngressCandidateAction } from "../memory/candidateActionContract";
import type { Env } from "../types";
import { json, openAiError } from "../utils/json";
import { readBody, resolveNamespace } from "./common";

const STATUSES = new Set(["pending", "needs_subject_review"]);

function candidateInput(value: unknown): CandidateInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const externalKey = typeof row.external_key === "string" ? row.external_key.trim() : "";
  const dreamDate = typeof row.dream_date === "string" ? row.dream_date.trim() : "";
  const action = typeof row.action === "string" ? row.action.trim() : "";
  const status = typeof row.status === "string" ? row.status.trim() : "";
  const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
    ? row.payload as Record<string, unknown> : null;
  if (!externalKey || !dreamDate || !isDreamIngressCandidateAction(action) || !STATUSES.has(status) || !payload) return null;
  return {
    externalKey,
    dreamDate,
    action,
    subject: typeof row.subject === "string" ? row.subject.trim() || null : null,
    targetId: typeof row.target_id === "string" ? row.target_id.trim() || null : null,
    payload,
    sourceChunkIds: Array.isArray(row.source_chunk_ids)
      ? row.source_chunk_ids.map(Number).filter((item) => Number.isInteger(item) && item > 0)
      : [],
    sourceChunks: Array.isArray(row.source_chunks)
      ? row.source_chunks.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      : [],
    status: (action === "relation" ? "deferred_relation" : status) as CandidateInput["status"],
    validationError: typeof row.validation_error === "string" ? row.validation_error.trim() || null : null
  };
}

export async function handleMemoryCandidates(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401);
  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;
  if (request.method !== "POST") return openAiError("Method not allowed", 405);
  const body = await readBody(request);
  const raw = body?.candidates;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100) return openAiError("candidates must contain 1-100 items", 400);
  const candidates = raw.map(candidateInput);
  if (candidates.some((item) => !item)) return openAiError("invalid candidate payload", 400);
  const namespace = resolveNamespace(auth.profile, body?.namespace);
  const decisions = (candidates as CandidateInput[]).map(applyDreamCandidatePolicy);
  const deleteTargetIds = [...new Set(decisions.flatMap((decision) =>
    decision.outcome === "accept" && decision.candidate.action === "delete" && decision.candidate.targetId
      ? [decision.candidate.targetId]
      : []
  ))];
  const deleteTargets = await fetchMemoriesByIds(env.DB, { namespace, ids: deleteTargetIds });
  const deleteTargetsById = new Map(deleteTargets.map((memory) => [memory.id, memory]));
  const targetChecked = decisions.map((decision): DreamCandidatePolicyDecision =>
    decision.outcome === "accept"
      ? applyDreamDeleteTargetPolicy(
        decision.candidate,
        decision.candidate.targetId ? deleteTargetsById.get(decision.candidate.targetId) : null
      )
      : decision
  );
  const accepted = targetChecked.filter((decision) => decision.outcome === "accept");
  const suppressed = targetChecked.filter((decision) => decision.outcome === "suppress");

  for (const decision of accepted) await upsertMemoryCandidate(env.DB, namespace, decision.candidate);
  if (suppressed.length > 0) {
    await createMemoryEvent(env.DB, {
      namespace,
      eventType: "dream_candidates_suppressed",
      payload: {
        policy: "dream_candidate_policy",
        count: suppressed.length,
        candidates: suppressed.slice(0, 100).map((decision) => ({
          external_key: decision.candidate.externalKey,
          dream_date: decision.candidate.dreamDate,
          action: decision.candidate.action,
          target_id: decision.candidate.targetId ?? null,
          reason: decision.reason,
          source_chunk_ids: decision.candidate.sourceChunkIds
        }))
      }
    });
  }

  return json({
    data: {
      received: candidates.length,
      accepted: candidates.length,
      stored: accepted.length,
      suppressed: suppressed.length,
      namespace
    }
  }, { status: 202 });
}
