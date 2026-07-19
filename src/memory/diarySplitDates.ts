import type { MemoryRecord } from "../types";
import { parseJsonStringArray } from "../utils/jsonHelpers";

export function normalizeDate(value: string): string | null {
  const match = value.trim().match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export function dateFromDiary(record: MemoryRecord): string | null {
  const rangeMatch = record.content.match(/(?:^|\n)\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[-–—至到]\s*(\d{1,2})\s*日/)
    || parseJsonStringArray(record.tags).join(" ").match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[-–—至到]\s*(\d{1,2})\s*日/);
  const contentMatch = record.content.match(/(?:^|\n)\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:日记)?/);
  const tagMatch = parseJsonStringArray(record.tags).join(" ").match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  const match = rangeMatch || contentMatch || tagMatch;
  if (!match) return null;
  const year = new Date(record.created_at || Date.now()).getUTCFullYear();
  return `${year}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

export function datesFromDiary(record: MemoryRecord, fallback: string): string[] {
  const year = new Date(record.created_at || Date.now()).getUTCFullYear();
  const text = `${record.content.slice(0, 300)} ${parseJsonStringArray(record.tags).join(" ")}`;
  const dates = new Set<string>();
  for (const match of text.matchAll(/(\d{1,2})\s*月\s*(\d{1,2})(?:\s*[-–—至到]\s*(\d{1,2}))?\s*日/g)) {
    const month = match[1].padStart(2, "0");
    dates.add(`${year}-${month}-${match[2].padStart(2, "0")}`);
    if (match[3]) dates.add(`${year}-${month}-${match[3].padStart(2, "0")}`);
  }
  if (dates.size === 0) dates.add(fallback);
  return [...dates];
}

export function sourceLabel(date: string): string {
  return `diary_${date}`;
}

export function splitBatchTag(date: string): string {
  return `split_batch:${date.replaceAll("-", "")}_diary`;
}
