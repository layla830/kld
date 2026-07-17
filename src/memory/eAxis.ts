import { loadEAxisConfig, systemClock } from "../config/runtime";
import { getCacheEntry, parseCacheEntryValue } from "../db/cacheEntries";
import type { Env } from "../types";

export const E_AXIS_STATE_KEY = "lmc5:e-axis:runtime-state";

export interface ShadowState {
  configured: boolean;
  startedAt: string | null;
  shadowDays: number;
  rankingEnabled: boolean;
  readyForPromotion: boolean;
  inShadow: boolean;
  daysElapsed: number;
  daysRemaining: number;
}

export function evaluateShadowState(
  input: { startedAt: string | null; shadowDays: number; rankingEnabled: boolean },
  now = systemClock.nowMs()
): ShadowState {
  const startedAt = input.startedAt ? Date.parse(input.startedAt) : NaN;
  const { shadowDays } = input;

  if (!Number.isFinite(startedAt)) {
    return {
      configured: false,
      startedAt: null,
      shadowDays,
      rankingEnabled: input.rankingEnabled,
      readyForPromotion: false,
      inShadow: true,
      daysElapsed: 0,
      daysRemaining: shadowDays
    };
  }

  const elapsedMs = Math.max(0, now - startedAt);
  const daysElapsed = Math.floor(elapsedMs / (24 * 60 * 60 * 1000));
  const inShadow = daysElapsed < shadowDays;
  return {
    configured: true,
    startedAt: new Date(startedAt).toISOString(),
    shadowDays,
    rankingEnabled: input.rankingEnabled,
    readyForPromotion: !inShadow,
    inShadow,
    daysElapsed,
    daysRemaining: Math.max(0, shadowDays - daysElapsed)
  };
}

async function readStartedAt(db: D1Database, namespace: string): Promise<string | null> {
  const record = await getCacheEntry(db, { namespace, key: E_AXIS_STATE_KEY });
  const value = record ? parseCacheEntryValue(record) : null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const startedAt = (value as Record<string, unknown>).started_at;
  return typeof startedAt === "string" && Number.isFinite(Date.parse(startedAt)) ? startedAt : null;
}

export async function readShadowState(
  env: Pick<Env, "DB" | "E_AXIS_SHADOW_DAYS" | "E_AXIS_RANKING_ENABLED">,
  namespace = "default",
  now = systemClock.nowMs()
): Promise<ShadowState> {
  const config = loadEAxisConfig(env);
  return evaluateShadowState({
    startedAt: await readStartedAt(env.DB, namespace),
    shadowDays: config.shadowDays,
    rankingEnabled: config.rankingEnabled
  }, now);
}

export async function shouldApplyEAxisToRanking(
  env: Pick<Env, "DB" | "E_AXIS_SHADOW_DAYS" | "E_AXIS_RANKING_ENABLED">,
  namespace = "default"
): Promise<boolean> {
  const state = await readShadowState(env, namespace);
  return state.rankingEnabled && state.readyForPromotion;
}
