export const EXCLUDED_FIVE_AXIS_MEMORY_TYPES = Object.freeze([
  "diary",
  "layla_diary",
  "auto_diary",
  "dream_review"
]);

export function fiveAxisMemoryEligibilityPredicate(alias) {
  const placeholders = EXCLUDED_FIVE_AXIS_MEMORY_TYPES.map(() => "?").join(", ");
  return {
    sql: `${alias}.status = 'active'
      AND ${alias}.active_fact != 0
      AND LOWER(TRIM(${alias}.type)) NOT IN (${placeholders})`,
    binds: [...EXCLUDED_FIVE_AXIS_MEMORY_TYPES]
  };
}
