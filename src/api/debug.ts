import { authenticate } from "../auth/apiKey";
import { requireScope } from "../auth/scopes";
import { runDailyMemoryDigest } from "../memory/dailyDigest";
import { listFactKeyConflictsForReview, runXyzemNightlyMaintenance, runZAudit } from "../memory/xyzem";
import { markMemorySupersededSynced } from "../memory/state";
import { listMemories, updateMemory } from "../db/memories";
import { callOpenAICompat } from "../proxy/openaiAdapter";
import { extractJsonObject } from "../utils/jsonHelpers";
import {
  normalizeFactKey,
  normalizeThread,
  normalizeRiskLevel,
  normalizeUrgencyLevel,
  normalizeTensionScore,
  normalizeResponsePosture,
  normalizeValence,
  normalizeArousal
} from "../memory/coordinates";
import { json, openAiError } from "../utils/json";
import { readBody } from "./common";
import type { Env, MemoryRecord, OpenAIChatRequest, OpenAIChatResponse } from "../types";

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
    const reviews = await listFactKeyConflictsForReview(env, namespace, 200);
    const target = reviews.find(
      (review) => review.fact_key === factKey && review.reason === "pending_supersede_review" && review.best
    );
    if (!target || !target.best) {
      return json({ ok: false, error: "no_pending_conflict", fact_key: factKey }, { status: 404 });
    }

    const superseded: string[] = [];
    for (const weaker of target.weaker) {
      const result = await markMemorySupersededSynced(env, namespace, weaker.id, {
        fact_key: target.fact_key,
        best_id: target.best.id,
        superseded_id: weaker.id,
        action: "z_approve",
        reason: "manual approve via z_approve endpoint"
      });
      if (result) superseded.push(weaker.id);
    }

    return json({ ok: true, fact_key: factKey, best_id: target.best.id, superseded });
  } catch (error) {
    console.error("z_approve failed", error);
    return json({ error: "z_approve_failed", detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

const BACKFILL_BATCH_SIZE = 20;

function buildBackfillPrompt(memories: MemoryRecord[]): string {
  const items = memories.map((m) => ({ id: m.id, type: m.type, content: m.content.slice(0, 300), tags: m.tags }));
  return [
    "你是记忆坐标标注器。给每条记忆补上 LMC-5 坐标。",
    "只输出 JSON，不要 markdown，不要解释。",
    "",
    "坐标说明：",
    "- fact_key: 稳定事实槽，格式如 project:kld 或 relationship.status。不确定就 null。",
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

export async function handleBackfillCoordinates(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;

  const body = request.method === "POST" ? await readBody(request) : null;
  const namespace = typeof body?.namespace === "string" ? String(body.namespace) : "default";
  const apply = body?.apply !== true;
  const limit = typeof body?.limit === "number" ? Math.min(Math.max(Math.floor(body.limit), 1), 100) : BACKFILL_BATCH_SIZE;

  const model = env.MEMORY_MODEL || env.DREAM_MODEL || env.MEMORY_EXTRACT_MODEL;
  if (!model) return json({ error: "missing_model" }, { status: 400 });

  try {
    const allMemories = await listMemories(env.DB, { namespace, status: "active", limit: 1000 });
    const needBackfill = allMemories.filter(
      (m) => !m.fact_key && !m.thread && m.risk_level === null && m.valence === null
    );
    const batch = needBackfill.slice(0, limit);

    if (batch.length === 0) {
      return json({ ok: true, mode: apply ? "apply" : "dry_run", scanned: allMemories.length, needBackfill: 0, processed: 0, message: "No memories need coordinate backfill" });
    }

    const prompt = buildBackfillPrompt(batch);
    const llmRequest: OpenAIChatRequest = {
      model,
      messages: [
        { role: "system", content: "你是严格的 JSON 生成器。只输出 JSON。" },
        { role: "user", content: prompt }
      ],
      temperature: 0,
      max_tokens: 2000,
      response_format: { type: "json_object" },
      stream: false
    };

    const response = await callOpenAICompat(env, llmRequest);
    if (!response.ok) return json({ error: "model_error", status: response.status }, { status: 502 });

    const parsed = (await response.json()) as OpenAIChatResponse;
    const content = (parsed.choices?.[0]?.message as { content?: unknown })?.content;
    const jsonResult = extractJsonObject(typeof content === "string" ? content : "");

    if (!jsonResult || typeof jsonResult !== "object") {
      return json({ error: "invalid_json" }, { status: 502 });
    }

    const updates = (jsonResult as { updates?: unknown }).updates;
    if (!Array.isArray(updates)) return json({ error: "no_updates_array" }, { status: 502 });

    const results: Array<{ id: string; updated: boolean; fields: string[] }> = [];
    let applied = 0;

    for (const item of updates) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : null;
      if (!id) continue;

      const patch: Parameters<typeof updateMemory>[1]["patch"] = {};
      if (record.fact_key !== undefined) patch.factKey = normalizeFactKey(record.fact_key);
      if (record.thread !== undefined) patch.thread = normalizeThread(record.thread);
      if (record.risk_level !== undefined) patch.riskLevel = normalizeRiskLevel(record.risk_level);
      if (record.urgency_level !== undefined) patch.urgencyLevel = normalizeUrgencyLevel(record.urgency_level);
      if (record.tension_score !== undefined) patch.tensionScore = normalizeTensionScore(record.tension_score);
      if (record.response_posture !== undefined) patch.responsePosture = normalizeResponsePosture(record.response_posture);
      if (record.valence !== undefined) patch.valence = normalizeValence(record.valence);
      if (record.arousal !== undefined) patch.arousal = normalizeArousal(record.arousal);

      const fields = Object.keys(patch);
      if (fields.length === 0) continue;

      if (apply) {
        const updated = await updateMemory(env.DB, { namespace, id, patch });
        if (updated) applied += 1;
      }

      results.push({ id, updated: apply, fields });
    }

    return json({
      ok: true,
      mode: apply ? "apply" : "dry_run",
      scanned: allMemories.length,
      needBackfill: needBackfill.length,
      processed: batch.length,
      applied,
      results
    });
  } catch (error) {
    console.error("backfill_coordinates failed", error);
    return json({ error: "backfill_failed", detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
