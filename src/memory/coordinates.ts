const LEVELS = new Set(["low", "normal", "medium", "high"]);

function cleanString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

export function normalizeThread(value: unknown): string | null {
  return cleanString(value, 80);
}

export function normalizeRiskLevel(value: unknown): string | null {
  const text = cleanString(value, 20)?.toLowerCase();
  return text && LEVELS.has(text) ? text : null;
}

export function normalizeUrgencyLevel(value: unknown): string | null {
  const text = cleanString(value, 20)?.toLowerCase();
  return text && LEVELS.has(text) ? text : null;
}

export function normalizeTensionScore(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numberValue)) return null;
  return Math.min(Math.max(numberValue, 0), 1);
}

export function normalizeResponsePosture(value: unknown): string | null {
  return cleanString(value, 120);
}

export function normalizeAuditState(value: unknown): string | null {
  return cleanString(value, 80);
}
