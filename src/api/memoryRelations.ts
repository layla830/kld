import { authenticate } from "../auth/apiKey";
import { requireScope } from "../auth/scopes";
import { createMemoryRelation, SAFE_RELATION_TYPES } from "../db/memoryRelations";
import { fetchMemoriesByIds } from "../db/memories";
import type { Env, KeyProfile } from "../types";
import { json, openAiError } from "../utils/json";
import { readBody, readNumber, readString, resolveNamespace } from "./common";

interface RelationCandidate {
  source_memory_id: string;
  target_memory_id: string;
  relation_type: string;
  strength: number;
  reason: string | null;
}

function readRelationCandidate(value: unknown): RelationCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const source = readString(item.source_memory_id) || readString(item.source_id) || readString(item.source);
  const target = readString(item.target_memory_id) || readString(item.target_id) || readString(item.target);
  const relationType = readString(item.relation_type) || readString(item.type) || readString(item.relation);
  if (!source || !target || !relationType) return null;
  return {
    source_memory_id: source,
    target_memory_id: target,
    relation_type: relationType,
    strength: readNumber(item.strength ?? item.confidence, 1),
    reason: readString(item.reason) || readString(item.note) || readString(item.rationale) || null
  };
}

function readRelations(body: Record<string, unknown>): RelationCandidate[] {
  const raw = Array.isArray(body.relations) ? body.relations : [body];
  return raw.flatMap((item) => {
    const relation = readRelationCandidate(item);
    return relation ? [relation] : [];
  });
}

async function createRelations(env: Env, profile: KeyProfile, body: Record<string, unknown>): Promise<Response> {
  const scopeError = requireScope(profile, "memory:write");
  if (scopeError) return scopeError;

  const namespace = resolveNamespace(profile, body.namespace);
  const relations = readRelations(body).slice(0, 50);
  if (relations.length === 0) return openAiError("relations must contain at least one valid relation", 400);

  const ids = [...new Set(relations.flatMap((item) => [item.source_memory_id, item.target_memory_id]))];
  const memories = new Map((await fetchMemoriesByIds(env.DB, { namespace, ids })).map((record) => [record.id, record]));
  const results = [];

  for (const relation of relations) {
    const source = memories.get(relation.source_memory_id);
    const target = memories.get(relation.target_memory_id);
    if (!SAFE_RELATION_TYPES.has(relation.relation_type)) {
      results.push({ ...relation, ok: false, reason: "unsafe_relation_type" });
      continue;
    }
    if (!source || !target) {
      results.push({ ...relation, ok: false, reason: !source ? "source_not_found" : "target_not_found" });
      continue;
    }
    if (source.status !== "active" || target.status !== "active") {
      results.push({ ...relation, ok: false, reason: "inactive_memory" });
      continue;
    }

    const created = await createMemoryRelation(env.DB, {
      namespace,
      sourceMemoryId: relation.source_memory_id,
      targetMemoryId: relation.target_memory_id,
      relationType: relation.relation_type,
      strength: relation.strength,
      reason: relation.reason
    });
    results.push({ ...relation, ok: created, reason: created ? "created" : "already_exists_or_ignored" });
  }

  return json({
    data: {
      namespace,
      requested: relations.length,
      created: results.filter((item) => item.ok).length,
      skipped: results.filter((item) => !item.ok).length,
      results
    }
  });
}

export async function handleMemoryRelations(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = await readBody(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  return createRelations(env, auth.profile, body);
}
