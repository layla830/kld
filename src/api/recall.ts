import { authenticate } from "../auth/apiKey";
import { requireScope } from "../auth/scopes";
import { markMemoriesRecalled } from "../db/memories";
import { createMemoryEvent } from "../db/memoryEvents";
import { buildRecallContext } from "../recall/service";
import { hashRecallQuery } from "../memory/eAxisObservability";
import type { Env, KeyProfile } from "../types";
import { json, openAiError } from "../utils/json";

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function resolveNamespace(profile: KeyProfile, requested: unknown): string {
  return profile.debug && typeof requested === "string" && requested.trim() ? requested.trim() : profile.namespace;
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function handleRecall(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const scopeError = requireScope(auth.profile, "memory:read");
  if (scopeError) return scopeError;

  const body = await readBody(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const prompt = readString(body.prompt) || readString(body.query);
  if (!prompt) return openAiError("prompt is required", 400);

  const namespace = resolveNamespace(auth.profile, body.namespace);
  const started = Date.now();
  const result = await buildRecallContext(env, {
    namespace,
    prompt,
    topK: readNumber(body.top_k, Number(env.MEMORY_RECALL_TOP_K || 5)),
    force: readBoolean(body.force)
  });

  if (result.should_recall) {
    const memoryIds = result.memories.map((memory) => memory.id).filter((id) => !id.startsWith("msg_"));
    ctx.waitUntil((async () => {
      const queryHash = await hashRecallQuery(prompt);
      await Promise.all([
        markMemoriesRecalled(env.DB, { namespace, ids: memoryIds }),
        createMemoryEvent(env.DB, {
          namespace,
          eventType: "recall_context_injected",
          payload: {
            query_hash: queryHash,
            query_length: prompt.length,
            memory_ids: memoryIds,
            result_count: result.memories.length,
            elapsed_ms: Date.now() - started,
            reasons: result.reasons,
            trace: result.trace
          }
        })
      ]);
    })().catch((error) => console.error("recall feedback write failed", error)));
  }

  return json(result);
}
