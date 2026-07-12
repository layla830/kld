import { authenticate } from "../auth/apiKey";
import { requireScope } from "../auth/scopes";
import { runDailyMemoryDigest } from "../memory/dailyDigest";
import { listFactKeyConflictsForReview, runXyzemNightlyMaintenance, runZAudit } from "../memory/xyzem";
import { listMemoryCandidatesByAction } from "../db/memoryCandidates";
import { callOpenAICompat } from "../proxy/openaiAdapter";
import { extractJsonObject } from "../utils/jsonHelpers";
import { json, openAiError } from "../utils/json";
import { readBody } from "./common";
import type { Env, MemoryRecord, OpenAIChatRequest, OpenAIChatResponse } from "../types";
import { proposeFactGroups } from "../memory/factGroups";
import { runTimelineBackfill } from "../memory/timelineBackfill";
import { runLegacyRelationBackfill, parseLegacyRelationRequest, isLegacyRelationRequestError } from "../memory/legacyRelations";
import { runCoordinateBackfill } from "../application/coordinateBackfill";
import { scanFactTransitionReviewCandidates } from "../memory/factTransitionReview";
import { approveFactTransitionCandidate } from "./adminBoard/factTransitionActions";

interface CacheHealthRow {
  created_at: string;
  model: string | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  input_tokens: number | null;
  client_system_hash: string | null;
  cache_anchor_block: string | null;
}

interface ModelAgg {
  model: string;
  requests: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  input_tokens: number;
}

interface HashAgg {
  client_system_hash: string;
  requests: number;
  cache_read_tokens: number;
}

interface CacheHealthSummary {
  total_requests: number;
  cache_creation_total_tokens: number;
  cache_read_total_tokens: number;
  input_total_tokens: number;
  cache_read_ratio: number;
  by_model: ModelAgg[];
  by_client_system_hash: HashAgg[];
  recent: CacheHealthRow[];
}

// All queries filter to Anthropic/Claude traffic only.
const ANTHROPIC_FILTER = "(provider = 'anthropic' OR lower(model) LIKE 'anthropic/%' OR lower(model) LIKE '%claude%')";

export async function handleCacheHealth(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const scopeError = requireScope(auth.profile, "debug:read");
  if (scopeError) return scopeError;

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const summary = await env.DB.prepare(
      `SELECT
         COUNT(*) as total_requests,
         COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_total_tokens,
         COALESCE(SUM(cache_read_tokens), 0) as cache_read_total_tokens,
         COALESCE(SUM(input_tokens), 0) as input_total_tokens
       FROM usage_logs
       WHERE created_at >= ? AND ${ANTHROPIC_FILTER}`
    ).bind(since).first<{
      total_requests: number;
      cache_creation_total_tokens: number;
      cache_read_total_tokens: number;
      input_total_tokens: number;
    }>();

    const totalRequests = summary?.total_requests ?? 0;
    const cacheCreationTotal = summary?.cache_creation_total_tokens ?? 0;
    const cacheReadTotal = summary?.cache_read_total_tokens ?? 0;
    const inputTotal = summary?.input_total_tokens ?? 0;

    const byModel = await env.DB.prepare(
      `SELECT
         model,
         COUNT(*) as requests,
         COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
         COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
         COALESCE(SUM(input_tokens), 0) as input_tokens
       FROM usage_logs
       WHERE created_at >= ? AND ${ANTHROPIC_FILTER}
       GROUP BY model
       ORDER BY requests DESC`
    ).bind(since).all<ModelAgg>();

    const byHash = await env.DB.prepare(
      `SELECT
         client_system_hash,
         COUNT(*) as requests,
         COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens
       FROM usage_logs
       WHERE created_at >= ? AND client_system_hash IS NOT NULL AND ${ANTHROPIC_FILTER}
       GROUP BY client_system_hash
       ORDER BY requests DESC`
    ).bind(since).all<HashAgg>();

    const recent = await env.DB.prepare(
      `SELECT
         created_at, model, cache_read_tokens, cache_creation_tokens,
         input_tokens, client_system_hash, cache_anchor_block
       FROM usage_logs
       WHERE created_at >= ? AND ${ANTHROPIC_FILTER}
       ORDER BY created_at DESC
       LIMIT 10`
    ).bind(since).all<CacheHealthRow>();

    const result: CacheHealthSummary = {
      total_requests: totalRequests,
      cache_creation_total_tokens: cacheCreationTotal,
      cache_read_total_tokens: cacheReadTotal,
      input_total_tokens: inputTotal,
      cache_read_ratio: inputTotal > 0 ? cacheReadTotal / inputTotal : 0,
      by_model: byModel.results ?? [],
      by_client_system_hash: byHash.results ?? [],
      recent: recent.results ?? []
    };

    return json(result);
  } catch (error) {
    console.error("cache_health query failed", error);
    return json({ error: "cache_health_query_failed" }, { status: 500 });
  }
}

export async function handleDreamDryRun(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;

  const body = request.method === "POST" ? await readBody(request) : null;
  const dateLabel = typeof body?.dateLabel === "string" ? String(body.dateLabel) : undefined;
  const force = Boolean(body?.force);
  const namespace = typeof body?.namespace === "string" ? String(body.namespace) : "default";

  const dreamEnv: Env = {
    ...env,
    ENABLE_DREAM: "true",
    DREAM_DRY_RUN: "true"
  };

  try {
    const result = await runDailyMemoryDigest(dreamEnv, namespace, { dateLabel, force });
    return json({ ok: true, result });
  } catch (error) {
    console.error("dream_dry_run failed", error);
    return json({ error: "dream_dry_run_failed", detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function handleZAuditScan(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;

  const body = request.method === "POST" ? await readBody(request) : null;
  const namespace = typeof body?.namespace === "string" ? String(body.namespace) : "default";
  const dryRun = body?.apply !== true;

  try {
    if (dryRun) {
      const { listFactKeyConflicts } = await import("../db/memories");
      const conflicts = await listFactKeyConflicts(env.DB, { namespace, limit: 200 });
      const detail = conflicts.map((c) => ({
        fact_key: c.fact_key,
        count: c.count,
        memory_ids: c.ids.split(",").map((id) => id.trim()).filter(Boolean)
      }));
      return json({ ok: true, mode: "dry_run", conflicts: detail.length, detail });
    }
    const result = await runZAudit(env, namespace);
    return json({ ok: true, mode: "queued", result });
  } catch (error) {
    console.error("z_audit_scan failed", error);
    return json({ error: "z_audit_scan_failed", detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function handleXyzemMaintenance(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;

  const body = request.method === "POST" ? await readBody(request) : null;
  const namespace = typeof body?.namespace === "string" ? String(body.namespace) : "default";
  const dryRun = body?.apply !== true;
  const sinceIso = typeof body?.sinceIso === "string" ? String(body.sinceIso) : undefined;

  try {
    const result = await runXyzemNightlyMaintenance(env, namespace, { dryRun, sinceIso });
    return json({ ok: true, mode: dryRun ? "dry_run" : "apply", result });
  } catch (error) {
    console.error("xyzem_maintenance failed", error);
    return json({ error: "xyzem_maintenance_failed", detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function handleZAuditPending(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;

  const body = request.method === "POST" ? await readBody(request) : null;
  const namespace = typeof body?.namespace === "string" ? String(body.namespace) : "default";

  try {
    const reviews = await listFactKeyConflictsForReview(env, namespace, 200);
    const pending = reviews
      .filter((review) => review.reason === "pending_supersede_review" && review.best)
      .map((review) => ({
        fact_key: review.fact_key,
        count: review.count,
        best_id: review.best?.id ?? null,
        weaker_ids: review.weaker.map((memory) => memory.id),
        memory_ids: review.memory_ids
      }));
    return json({ ok: true, pending: pending.length, detail: pending });
  } catch (error) {
    console.error("z_pending failed", error);
    return json({ error: "z_pending_failed", detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function handleZAuditApprove(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;

  const body = request.method === "POST" ? await readBody(request) : null;
  const namespace = typeof body?.namespace === "string" ? String(body.namespace) : "default";
  const factKey = typeof body?.fact_key === "string" ? String(body.fact_key).trim() : null;
  if (!factKey) return json({ error: "fact_key_required" }, { status: 400 });

  try {
    await scanFactTransitionReviewCandidates(env, namespace);
    const candidates = (await listMemoryCandidatesByAction(env.DB, namespace, "z_supersede", 200))
      .filter((candidate) => {
        try { return (JSON.parse(candidate.payload_json) as { fact_key?: unknown }).fact_key === factKey; }
        catch { return false; }
      });
    if (candidates.length === 0) {
      return json({ ok: false, error: "no_pending_conflict", fact_key: factKey }, { status: 404 });
    }

    const superseded: string[] = [];
    for (const candidate of candidates) {
      const form = new FormData();
      form.set("id", candidate.id);
      form.set("namespace", namespace);
      const result = await approveFactTransitionCandidate(env, form);
      if (result) superseded.push(...result.memories.map((memory) => memory.id));
    }

    return json({ ok: true, fact_key: factKey, superseded });
  } catch (error) {
    console.error("z_approve failed", error);
    return json({ error: "z_approve_failed", detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

const BACKFILL_BATCH_SIZE = 5;
const BACKFILL_MODEL_BATCH_SIZE = 5;

type BackfillUpdate = Record<string, unknown> & { id: string };
function readAssistantText(response: OpenAIChatResponse): string {
  const content = (response.choices?.[0]?.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
      ? String((part as { text: string }).text)
      : "")
    .join("")
    .trim();
}

async function labelBackfillBatch(env: Env, model: string, memories: MemoryRecord[]): Promise<BackfillUpdate[]> {
  const basePrompt = buildBackfillPrompt(memories);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const llmRequest: OpenAIChatRequest = {
      model,
      messages: [
        { role: "system", content: "你是严格的 JSON 生成器。只输出一个完整 JSON 对象，不要 markdown。" },
        { role: "user", content: attempt === 0 ? basePrompt : `${basePrompt}\n\n上次输出无法解析。请缩短字段内容，并确保 JSON 完整闭合。` }
      ],
      temperature: 0,
      max_tokens: 3000,
      response_format: { type: "json_object" },
      stream: false
    };

    const response = await callOpenAICompat(env, llmRequest);
    if (!response.ok) {
      if (attempt === 0 && response.status >= 500) continue;
      throw new Error(`model_status_${response.status}`);
    }

    const parsed = (await response.json()) as OpenAIChatResponse;
    const jsonResult = extractJsonObject(readAssistantText(parsed));
    const updates = jsonResult && typeof jsonResult === "object"
      ? (jsonResult as { updates?: unknown }).updates
      : null;
    if (!Array.isArray(updates)) continue;

    return updates.filter((item): item is BackfillUpdate => Boolean(
      item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
    ));
  }

  throw new Error("invalid_model_json_after_retry");
}

function buildBackfillPrompt(memories: MemoryRecord[]): string {
  const items = memories.map((m) => ({ id: m.id, type: m.type, content: m.content.slice(0, 300), tags: m.tags }));
  return [
    "你是记忆坐标标注器。给每条记忆补上 LMC-5 坐标。",
    "只输出 JSON，不要 markdown，不要解释。",
    "",
    "坐标说明：",
    "- fact_key: 始终输出 null；旧记忆事实槽由独立的 Z 轴归并任务处理。",
    "- thread: 主题线，如 kld、relationship.boundaries、safety。不确定就 null。",
    "- risk_level: low/normal/medium/high",
    "- urgency_level: low/normal/medium/high",
    "- tension_score: 0-1，有过张力/冲突 >0.5",
    "- valence: -1 到 1，正=愉悦，负=难受",
    "- arousal: 0-1，越高越激动",
    "- response_posture: 未来回应姿态，简短一句",
    "",
    "输出格式：",
    JSON.stringify({
      updates: [
        { id: "mem_x", fact_key: "project:kld", thread: "kld", risk_level: "normal", urgency_level: "normal", tension_score: null, valence: null, arousal: null, response_posture: null }
      ]
    }),
    "",
    "记忆列表：",
    JSON.stringify(items)
  ].join("\n");
}

export async function handleBackfillCoordinates(
  request: Request,
  env: Env,
  options: { trustedInternal?: boolean } = {}
): Promise<Response> {
  if (!options.trustedInternal) {
    const auth = await authenticate(request, env);
    if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");
    const scopeError = requireScope(auth.profile, "memory:write");
    if (scopeError) return scopeError;
  }

  const body = request.method === "POST" ? await readBody(request) : null;
  try {
    return json(await runCoordinateBackfill(env, {
      namespace: typeof body?.namespace === "string" ? body.namespace : "default",
      apply: body?.apply === true,
      limit: typeof body?.limit === "number" ? body.limit : BACKFILL_BATCH_SIZE,
      offset: typeof body?.offset === "number" ? body.offset : 0
    }, labelBackfillBatch));
  } catch (error) {
    console.error("backfill_coordinates failed", error);
    const detail = error instanceof Error ? error.message : String(error);
    if (detail === "missing_model") return json({ error: detail }, { status: 400 });
    const isModelError = detail.startsWith("model_status_") || detail === "invalid_model_json_after_retry";
    return json({ error: isModelError ? "model_output_error" : "backfill_failed", detail }, { status: isModelError ? 502 : 500 });
  }
}

export async function runScheduledCoordinateBackfill(env: Env, namespace: string): Promise<unknown> {
  return runCoordinateBackfill(env, {
    namespace,
    apply: true,
    limit: BACKFILL_BATCH_SIZE,
    offset: 0
  }, labelBackfillBatch);
}

export async function handleFactGroupProposals(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");
  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;
  const body = await readBody(request);
  try {
    return json({ ok:true, mode:body?.apply === true ? "queued_for_group_review" : "dry_run", result:await proposeFactGroups(env, typeof body?.namespace === "string" ? body.namespace : "default", body?.apply === true, typeof body?.threadOffset === "number" ? body.threadOffset : 0) });
  } catch (error) {
    return json({ error:"fact_group_proposal_failed", detail:error instanceof Error ? error.message : String(error) }, { status:500 });
  }
}

export async function handleTimelineBackfill(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");
  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;
  const body = await readBody(request);
  if (body?.apply === true) {
    return json({ error: "timeline_backfill_apply_not_enabled" }, { status: 400 });
  }
  try {
    const namespace = typeof body?.namespace === "string" ? body.namespace : "default";
    return json({ ok: true, mode: "dry_run", result: await runTimelineBackfill(env, namespace) });
  } catch (error) {
    return json({ error: "timeline_backfill_failed", detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function handleLegacyRelationBackfill(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");
  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;
  const body = await readBody(request);
  try {
    const parsed = parseLegacyRelationRequest(body);
    if (isLegacyRelationRequestError(parsed)) {
      return json({ error: parsed.code, detail: parsed.detail, allowed: parsed.allowed }, { status: parsed.status });
    }
    const result = await runLegacyRelationBackfill(env, parsed.namespace, parsed.apply, parsed.selectedTypes);
    return json({ ok: true, mode: parsed.apply ? "apply_safe_edges" : "dry_run", result });
  } catch (error) {
    return json({ error: "legacy_relation_backfill_failed", detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
