export const EXCLUDED_FIVE_AXIS_MEMORY_TYPES: readonly [
  "diary",
  "layla_diary",
  "auto_diary",
  "dream_review"
];

export type FiveAxisEligibilitySqlAlias = "memory" | "source_memory" | "target_memory";

export function fiveAxisMemoryEligibilityPredicate(
  alias: FiveAxisEligibilitySqlAlias
): { sql: string; binds: unknown[] };
