import type { MemoryApiRecord } from "../types";

export const RECALL_EXCLUDED_TYPES = new Set(["diary", "layla_diary", "auto_diary"]);
export function isRecallEligible<T extends { type: string }>(record: T): boolean { return !RECALL_EXCLUDED_TYPES.has(record.type.toLowerCase()); }

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
