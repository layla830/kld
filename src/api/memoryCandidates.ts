import { authenticate } from "../auth/apiKey";
import { requireScope } from "../auth/scopes";
import { upsertMemoryCandidate, type CandidateInput } from "../db/memoryCandidates";
import type { Env } from "../types";
import { json, openAiError } from "../utils/json";
import { readBody, resolveNamespace } from "./common";

const ACTIONS = new Set(["add", "update", "delete", "excerpt", "relation"]);
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
  if (!externalKey || !dreamDate || !ACTIONS.has(action) || !STATUSES.has(status) || !payload) return null;
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
  for (const candidate of candidates as CandidateInput[]) await upsertMemoryCandidate(env.DB, namespace, candidate);
  return json({ data: { accepted: candidates.length, namespace } }, { status: 202 });
}
