export interface DiaryOriginRepairQuery {
  name: string;
  sql: string;
}

export const MAX_DIARY_ORIGIN_REPAIR_LIMIT: number;
export function buildDiaryOriginRepairDryRunQuery(input: {
  namespace: string;
  limit: number;
}): DiaryOriginRepairQuery;
export function buildDiaryOriginRepairApplyQueries(input: {
  namespace: string;
  limit: number;
}): DiaryOriginRepairQuery[];
export function assertReadOnlyDiaryOriginRepairQuery(query: DiaryOriginRepairQuery): void;
