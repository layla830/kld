import type { MemoryRecord } from "../../types";

export const EXCLUDED_FIVE_AXIS_MEMORY_TYPES = [
  "diary",
  "layla_diary",
  "auto_diary",
  "dream_review"
] as const;

const EXCLUDED_FIVE_AXIS_MEMORY_TYPE_SET = new Set<string>(EXCLUDED_FIVE_AXIS_MEMORY_TYPES);

type EligibilitySqlAlias = "memory" | "source_memory" | "target_memory";

export function isFiveAxisMemoryTypeEligible(type: string): boolean {
  return !EXCLUDED_FIVE_AXIS_MEMORY_TYPE_SET.has(type.trim().toLowerCase());
}

export function isFiveAxisMemoryEligible(
  memory: Pick<MemoryRecord, "type" | "status" | "active_fact">
): boolean {
  return memory.status === "active"
    && memory.active_fact !== 0
    && isFiveAxisMemoryTypeEligible(memory.type);
}

export function fiveAxisMemoryEligibilityPredicate(
  alias: EligibilitySqlAlias
): { sql: string; binds: unknown[] } {
  const placeholders = EXCLUDED_FIVE_AXIS_MEMORY_TYPES.map(() => "?").join(", ");
  return {
    sql: `${alias}.status = 'active'
      AND ${alias}.active_fact != 0
      AND LOWER(TRIM(${alias}.type)) NOT IN (${placeholders})`,
    binds: [...EXCLUDED_FIVE_AXIS_MEMORY_TYPES]
  };
}
