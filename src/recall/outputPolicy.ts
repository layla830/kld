import type { MemoryApiRecord } from "../types";

export const RECALL_EXCLUDED_TYPES = new Set(["diary", "layla_diary", "auto_diary"]);
export const TIMELINE_DAY_CONTENT_TAG = "timeline_day_content:v1";

function hasTag(tags: string[] | string | null | undefined, expected: string): boolean {
  if (Array.isArray(tags)) return tags.includes(expected);
  if (typeof tags !== "string") return false;
  try {
    const parsed = JSON.parse(tags) as unknown;
    return Array.isArray(parsed) && parsed.includes(expected);
  } catch {
    return false;
  }
}

export function isRecallEligible<T extends {
  type: string;
  status?: string;
  active_fact?: number | boolean;
  tags?: string[] | string | null;
}>(record: T): boolean {
  const type = record.type.toLowerCase();
  if (RECALL_EXCLUDED_TYPES.has(type)) return false;
  if (type === "timeline_day" && !hasTag(record.tags, TIMELINE_DAY_CONTENT_TAG)) return false;
  if (record.status !== undefined && record.status !== "active") return false;
  return record.active_fact !== 0 && record.active_fact !== false;
}

export function keepRelatedContext(primary: MemoryApiRecord[], related: MemoryApiRecord[], topK: number): MemoryApiRecord[] {
  const kept = new Set(primary.map((memory) => memory.id));
  const additions = related.filter(isRecallEligible).filter((memory) => !kept.has(memory.id))
    .filter((memory) => typeof memory.score !== "number" || memory.score >= 0.3)
    .sort((a, b) => (b.score ?? 0) + b.importance * 0.05 - ((a.score ?? 0) + a.importance * 0.05))
    .slice(0, Math.min(2, Math.max(0, topK - 1)));
  return additions.length ? [...primary.slice(0, topK - additions.length), ...additions].slice(0, topK) : primary.slice(0, topK);
}

export function keepHintedContext(primary: MemoryApiRecord[], hinted: MemoryApiRecord[], topK: number): MemoryApiRecord[] {
  if (primary.length >= topK) return primary.slice(0, topK);
  const kept = new Set(primary.map((memory) => memory.id));
  const additions = hinted.filter((memory) => !kept.has(memory.id))
    .sort((a, b) => (b.score ?? 0) + b.importance * 0.05 - ((a.score ?? 0) + a.importance * 0.05))
    .slice(0, Math.min(2, topK - primary.length));
  return [...primary, ...additions].slice(0, topK);
}

export function dedupeRecallOutput(memories: MemoryApiRecord[]): MemoryApiRecord[] {
  const seen = new Set<string>();
  return memories.filter((memory) => {
    const key = memory.content.toLowerCase().replace(/\s+/g, "").replace(/[?？！。.,，、:：;；"“”'‘’]/g, "");
    if (key.length < 12) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
