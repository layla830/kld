import { authenticate } from "../auth/apiKey";
import type { Env, KeyProfile } from "../types";
import { json, openAiError } from "../utils/json";

interface DateRepairItem {
  id?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

function canRepairDates(profile: KeyProfile): boolean {
  return profile.scopes.includes("memory:write") && profile.scopes.includes("memory:read");
}

function readIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export async function handleAdminDateRepair(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return openAiError("Method not allowed", 405);

  const auth = await authenticate(request, env);
  if (!auth.ok || !canRepairDates(auth.profile)) return openAiError("Unauthorized", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return openAiError("Invalid JSON", 400);
  }

  const input = body as { dry_run?: unknown; namespace?: unknown; items?: unknown };
  const dryRun = input.dry_run !== false;
  const namespace = auth.profile.debug && typeof input.namespace === "string" && input.namespace.trim() ? input.namespace.trim() : auth.profile.namespace;
  const items = Array.isArray(input.items) ? (input.items as DateRepairItem[]) : [];

  if (items.length === 0) return openAiError("items is required", 400);
  if (items.length > 500) return openAiError("items is too large", 400);

  const normalized = items
    .map((item) => ({
      id: typeof item.id === "string" ? item.id.trim() : "",
      createdAt: readIsoDate(item.created_at),
      updatedAt: readIsoDate(item.updated_at)
    }))
    .filter((item) => item.id && item.createdAt);

  if (normalized.length === 0) return openAiError("No valid id/created_at items", 400);

  const results: Array<Record<string, unknown>> = [];
  let updated = 0;
  let missing = 0;

  for (const item of normalized) {
    const current = await env.DB.prepare("SELECT id, created_at, updated_at FROM memories WHERE namespace = ? AND id = ?")
      .bind(namespace, item.id)
      .first<{ id: string; created_at: string | null; updated_at: string | null }>();

    if (!current) {
      missing += 1;
      results.push({ id: item.id, status: "missing" });
      continue;
    }

    results.push({
      id: item.id,
      status: dryRun ? "dry_run" : "updated",
      from_created_at: current.created_at,
      to_created_at: item.createdAt,
      from_updated_at: current.updated_at,
      to_updated_at: item.updatedAt || current.updated_at
    });

    if (!dryRun) {
      await env.DB.prepare("UPDATE memories SET created_at = ?, updated_at = ? WHERE namespace = ? AND id = ?")
        .bind(item.createdAt, item.updatedAt || current.updated_at || item.createdAt, namespace, item.id)
        .run();
      updated += 1;
    }
  }

  return json({ ok: true, dry_run: dryRun, namespace, matched: normalized.length - missing, missing, updated, results });
}
