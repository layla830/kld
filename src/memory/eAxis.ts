interface ShadowState {
  inShadow: boolean;
  daysElapsed: number;
  daysRemaining: number;
}

const DEFAULT_SHADOW_DAYS = 30;

function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : fallback;
  const numeric = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(Math.floor(numeric), 0), 365);
}

export function readShadowState(env: { E_AXIS_STARTED_AT?: string; E_AXIS_SHADOW_DAYS?: string }, now = Date.now()): ShadowState {
  const startedAtRaw = typeof env.E_AXIS_STARTED_AT === "string" ? env.E_AXIS_STARTED_AT.trim() : "";
  const startedAt = startedAtRaw ? Date.parse(startedAtRaw) : NaN;
  const shadowDays = readPositiveInt(env.E_AXIS_SHADOW_DAYS, DEFAULT_SHADOW_DAYS);

  if (!Number.isFinite(startedAt)) {
    return { inShadow: true, daysElapsed: 0, daysRemaining: shadowDays };
  }

  const elapsedMs = Math.max(0, now - startedAt);
  const daysElapsed = Math.floor(elapsedMs / (24 * 60 * 60 * 1000));
  const inShadow = daysElapsed < shadowDays;
  return {
    inShadow,
    daysElapsed,
    daysRemaining: Math.max(0, shadowDays - daysElapsed)
  };
}

export function shouldApplyEAxisToRanking(env: { E_AXIS_STARTED_AT?: string; E_AXIS_SHADOW_DAYS?: string }): boolean {
  return !readShadowState(env).inShadow;
}
