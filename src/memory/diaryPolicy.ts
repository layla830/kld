import type { MemoryRecord } from "../types";

export const DIARY_SPLIT_SOURCE_TYPE = "diary";

export function isActiveDiarySplitSource(
  memory: Pick<MemoryRecord, "status" | "type">
): boolean {
  return memory.status === "active" && memory.type === DIARY_SPLIT_SOURCE_TYPE;
}
