export const DIARY_SPLIT_SOURCE_TYPE = "diary";

export function activeDiarySplitSourcePredicate(alias) {
  return {
    sql: `${alias}.status = 'active' AND LOWER(TRIM(${alias}.type)) = ?`,
    binds: [DIARY_SPLIT_SOURCE_TYPE]
  };
}
