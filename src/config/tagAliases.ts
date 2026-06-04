const TAG_ALIASES: Record<string, string> = {
  diary: "日记",
  Diary: "日记",
  "auto-diary": "自动日记",
  auto_diary: "自动日记",
  handoff: "交接",
  Handoff: "交接",
  "cc端": "CC端",
  "CC端": "CC端",
  "cc-connect": "CC端",
  "cc_connect": "CC端",
  cc: "CC端",
  quote: "语录",
  Quote: "语录",
  quotes: "语录",
  message: "留言",
  unread: "unread"
};

function normalizeDateTag(tag: string): string | null {
  const match = tag.match(/^(?:(20\d{2})[-/.年])?(\d{1,2})[-/.月](\d{1,2})日?$/);
  if (!match) return null;
  const year = match[1] ?? String(new Date().getFullYear());
  const month = match[2].padStart(2, "0");
  const day = match[3].padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function normalizeTag(tag: string): string {
  const trimmed = tag.trim().replace(/^#/, "");
  if (!trimmed) return "";
  const dateTag = normalizeDateTag(trimmed);
  if (dateTag) return dateTag;
  return TAG_ALIASES[trimmed] ?? trimmed;
}

export function normalizeTags(tags: string[] = []): string[] {
  return [...new Set(tags.map(normalizeTag).filter(Boolean))];
}
