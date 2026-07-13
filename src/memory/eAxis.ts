import { loadEAxisConfig, systemClock } from "../config/runtime";

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

export function readShadowState(
  env: { E_AXIS_STARTED_AT?: string; E_AXIS_SHADOW_DAYS?: string; E_AXIS_RANKING_ENABLED?: string },
  now = systemClock.nowMs()
): ShadowState {
  const config = loadEAxisConfig(env);
  const startedAt = config.startedAt ? Date.parse(config.startedAt) : NaN;
  const { shadowDays } = config;

  if (!Number.isFinite(startedAt)) {
    return {
      configured: false,
      startedAt: null,
      shadowDays,
      rankingEnabled: config.rankingEnabled,
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
    rankingEnabled: config.rankingEnabled,
    readyForPromotion: !inShadow,
    inShadow,
    daysElapsed,
    daysRemaining: Math.max(0, shadowDays - daysElapsed)
  };
}

export function shouldApplyEAxisToRanking(
  env: { E_AXIS_STARTED_AT?: string; E_AXIS_SHADOW_DAYS?: string; E_AXIS_RANKING_ENABLED?: string }
): boolean {
  const state = readShadowState(env);
  return state.rankingEnabled && state.readyForPromotion;
}
