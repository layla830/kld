import { authenticate } from "../auth/apiKey";
import { requireScope } from "../auth/scopes";
import { importLegacyMemory, ensureMemorySchema } from "../db/importMemories";
import { upsertMemoryEmbedding } from "../memory/embedding";
import { buildStartupContext } from "../memory/startupContext";
import type { Env, KeyProfile } from "../types";
import { json, openAiError } from "../utils/json";

interface ImportRequestBody {
  namespace?: unknown;
  records?: unknown;
  rebuild_embeddings?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveNamespace(profile: KeyProfile, requested: unknown): string {
  if (profile.debug && typeof requested === "string" && requested.trim()) return requested.trim();
  return profile.namespace;
}

async function readBody(request: Request): Promise<ImportRequestBody | null> {
  try {
    const body = (await request.json()) as unknown;
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

async function handleMigrationStatus(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const scopeError = requireScope(auth.profile, "memory:read");
  if (scopeError) return scopeError;

  await ensureMemorySchema(env.DB);
  const namespace = auth.profile.namespace;
  const total = await env.DB
    .prepare("SELECT COUNT(*) AS count FROM memories WHERE namespace = ? AND status = 'active'")
    .bind(namespace)
    .first<{ count: number }>();
  const legacy = await env.DB
    .prepare("SELECT COUNT(*) AS count FROM memories WHERE namespace = ? AND status = 'active' AND source = 'vps-mcp-memory'")
    .bind(namespace)
    .first<{ count: number }>();
  const types = await env.DB
    .prepare("SELECT type, COUNT(*) AS count FROM memories WHERE namespace = ? AND status = 'active' GROUP BY type ORDER BY type")
    .bind(namespace)
    .all<{ type: string; count: number }>();
  const startup = await buildStartupContext(env.DB, namespace);

  return json({
    data: {
      namespace,
      active_count: total?.count ?? 0,
      legacy_vps_count: legacy?.count ?? 0,
      types: types.results ?? [],
      required_warmth: startup.required_warmth
    }
  });
}

export async function handleMigration(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method === "GET") return handleMigrationStatus(request, env);
  if (request.method !== "POST") return openAiError("Method not allowed", 405);

  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;

  const body = await readBody(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);
  if (!Array.isArray(body.records)) return openAiError("records must be an array", 400);
  if (body.records.length > 50) return openAiError("Import at most 50 records per request", 400);

  await ensureMemorySchema(env.DB);

  const namespace = resolveNamespace(auth.profile, body.namespace);
  const imported = [];
  const embeddingRecords = [];

  for (const item of body.records) {
    if (!isRecord(item)) continue;
    const { record, result } = await importLegacyMemory(env.DB, item, namespace);
    imported.push(result);
    embeddingRecords.push(record);
  }

  if (body.rebuild_embeddings !== false && embeddingRecords.length > 0) {
    ctx.waitUntil(
      Promise.allSettled(embeddingRecords.map((record) => upsertMemoryEmbedding(env, record))).then((results) => {
        const failed = results.filter((result) => result.status === "rejected").length;
        if (failed > 0) console.error("legacy memory embedding failures", failed);
      })
    );
  }

  return json({
    data: {
      namespace,
      received: body.records.length,
      imported: imported.length,
      ids: imported
    }
  });
}
