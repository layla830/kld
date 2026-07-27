export const DIARY_SPLIT_SOURCE_TYPE: "diary";

export function activeDiarySplitSourcePredicate(alias: string): {
  sql: string;
  binds: unknown[];
};
