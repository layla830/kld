import type { KeyProfile } from "../types";

export function resolveNamespace(profile: KeyProfile, requested: unknown): string {
  if (profile.debug && typeof requested === "string" && requested.trim()) {
    return requested.trim();
  }

  return profile.namespace;
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

export function readOptionalString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return readString(value);
}

export function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

export async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
