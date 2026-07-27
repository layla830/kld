import type { MemoryRecord } from "../types";
import { DIARY_SPLIT_SOURCE_TYPE } from "./diaryPolicyContract.js";

export { DIARY_SPLIT_SOURCE_TYPE };

export function isActiveDiarySplitSource(
  memory: Pick<MemoryRecord, "status" | "type">
): boolean {
  return memory.status === "active" && memory.type === DIARY_SPLIT_SOURCE_TYPE;
}
