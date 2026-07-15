const EXCLUDED_FIVE_AXIS_MEMORY_TYPES = new Set([
  "diary",
  "layla_diary",
  "auto_diary",
  "dream_review"
]);

export function isFiveAxisMemoryTypeEligible(type: string): boolean {
  return !EXCLUDED_FIVE_AXIS_MEMORY_TYPES.has(type);
}
