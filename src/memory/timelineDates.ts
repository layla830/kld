export interface TimelineDateTagAnalysis {
  dateTags: string[];
  validDates: string[];
  invalidTags: string[];
  isCanonical: boolean;
}

function normalizedDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseTimelineDate(value: string): string | null {
  const match = /^(20\d{2})-(\d{2})-(\d{2})$/.exec(value.trim());
  return match ? normalizedDate(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

export function extractExplicitDates(text: string): string[] {
  const dates = new Set<string>();
  for (const match of text.matchAll(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) {
    const date = normalizedDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (date) dates.add(date);
  }
  for (const match of text.matchAll(/(20\d{2})\u5e74(\d{1,2})\u6708(\d{1,2})\u65e5/g)) {
    const date = normalizedDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (date) dates.add(date);
  }
  return [...dates].sort();
}

export function analyzeTimelineDateTags(tags: string[]): TimelineDateTagAnalysis {
  const dateTags = tags.filter((tag) => tag.startsWith("date:"));
  const validDates: string[] = [];
  const invalidTags: string[] = [];
  for (const tag of dateTags) {
    const date = parseTimelineDate(tag.slice(5));
    if (date) validDates.push(date);
    else invalidTags.push(tag);
  }
  const uniqueDates = [...new Set(validDates)].sort();
  return {
    dateTags,
    validDates: uniqueDates,
    invalidTags,
    isCanonical: dateTags.length === 1 && invalidTags.length === 0 && uniqueDates.length === 1
  };
}
