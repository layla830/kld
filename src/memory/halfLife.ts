import type { MemoryRecord } from "../types";

export const CATEGORY_HALF_LIVES: Record<string, number> = {
  heartbeat: Infinity,
  identity: Infinity,
  relationship_moment: Infinity,
  core: 90,
  rule: 90,
  lesson: 90,
  preference: 90,
  boundary: 90,
  fragment: 90,
  important: 90,
  review: 60,
  diary: 60,
  mailbox: 60,
  knowledge: 30,
  notebook: 30,
  project: 45,
  note: 30,
  daily_summary: 60,
  excerpt: 75,
  conversation_message: 14,
  conversation: 14
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function halfLifeForCategory(category: string): number {
  return CATEGORY_HALF_LIVES[category] ?? CATEGORY_HALF_LIVES.note ?? 30;
}

export function isProtectedCategory(memory: MemoryRecord): boolean {
  return memory.pinned === 1 || isInfinity(halfLifeForCategory(memory.type));
}

function isInfinity(value: number): boolean {
  return !Number.isFinite(value);
}

export function computeDecayedWeight(memory: MemoryRecord, now = Date.now()): number {
  if (memory.pinned === 1) return memory.importance;
  const halfLifeDays = halfLifeForCategory(memory.type);
  if (isInfinity(halfLifeDays)) return memory.importance;

  const updatedAt = Date.parse(memory.updated_at);
  if (!Number.isFinite(updatedAt)) return memory.importance * 0.5;

  const elapsedDays = Math.max(0, (now - updatedAt) / MS_PER_DAY);
  if (elapsedDays === 0) return memory.importance;

  const decayFactor = Math.pow(0.5, elapsedDays / halfLifeDays);
  return memory.importance * decayFactor;
}
