import type { MemoryRecord } from "../../types";

export const EXCLUDED_FIVE_AXIS_MEMORY_TYPES = [
  "diary",
  "layla_diary",
  "auto_diary",
  "dream_review"
] as const;

const EXCLUDED_FIVE_AXIS_MEMORY_TYPE_SET = new Set<string>(EXCLUDED_FIVE_AXIS_MEMORY_TYPES);

type EligibilitySqlAlias = "memory" | "source_memory" | "target_memory";

export type MemoryEligibilityTransition =
  | "eligible_to_eligible"
  | "eligible_to_ineligible"
  | "ineligible_to_eligible"
  | "ineligible_to_ineligible";

export interface MemoryEligibilityState {
  type: string;
  status: string;
  active_fact: number;
}

export function isFiveAxisMemoryTypeEligible(type: string): boolean {
  return !EXCLUDED_FIVE_AXIS_MEMORY_TYPE_SET.has(type.trim().toLowerCase());
}

export function applyMemoryEligibilityPatch(
  memory: MemoryEligibilityState,
  patch: { type?: string; status?: string; activeFact?: boolean }
): MemoryEligibilityState {
  const status = patch.status ?? memory.status;
  const activeFact = patch.activeFact === undefined
    ? patch.status === undefined
      ? memory.active_fact
      : status === "active" ? 1 : 0
    : patch.activeFact ? 1 : 0;
  return {
    type: patch.type ?? memory.type,
    status,
    active_fact: activeFact
  };
}

export function classifyMemoryEligibilityTransition(
  before: MemoryEligibilityState,
  after: MemoryEligibilityState
): MemoryEligibilityTransition {
  const wasEligible = isFiveAxisMemoryEligible(before);
  const isEligible = isFiveAxisMemoryEligible(after);
  if (wasEligible) return isEligible ? "eligible_to_eligible" : "eligible_to_ineligible";
  return isEligible ? "ineligible_to_eligible" : "ineligible_to_ineligible";
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
