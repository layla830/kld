export type SearchMode = "keyword" | "semantic";

export interface PageInput {
  q: string;
  type: string;
  status: string;
  page: number;
  tab: string;
  tag: string;
  date: string;
  category: string;
  mood: string;
  notice: string;
  searchMode: SearchMode;
}

export const PAGE_SIZE = 8;
export const TABS = [
  { id: "message", label: "留言板" },
  { id: "diary", label: "交换日记" },
  { id: "quote", label: "语录" },
  { id: "browse", label: "记忆浏览" }
] as const;
export const MOODS = ["", "开心", "平静", "兴奋", "委屈", "低落", "生气", "焦虑", "疲惫", "感动"];

const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

export function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function attr(value: unknown): string {
  return htmlEscape(value).replaceAll("`", "&#96;");
}

export function parseTags(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
  }
}

export function parseTagInput(value: string): string[] {
  const normalized = value.trim();
  if (!normalized) return [];
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    try {
      const parsed = JSON.parse(normalized) as unknown;
      if (Array.isArray(parsed)) return [...new Set(parsed.map((item) => String(item).trim()).filter(Boolean))];
    } catch {
      // Use loose parsing below for hand-edited input.
    }
  }
  return [...new Set(normalized.split(/[,，\n]/).map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean))];
}

export function moodOf(tagsValue: string | null): string {
  const tag = parseTags(tagsValue).find((item) => item.startsWith("mood:"));
  return tag ? tag.slice(5) : "";
}

export function moodClass(mood: string): string {
  const map: Record<string, string> = {
    开心: "mood-happy",
    平静: "mood-calm",
    兴奋: "mood-bright",
    委屈: "mood-soft",
    低落: "mood-low",
    生气: "mood-angry",
    焦虑: "mood-worry",
    疲惫: "mood-tired",
    感动: "mood-moved"
  };
  return map[mood] || "";
}

export function clampNumber(value: string, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function parseStoredDate(value: string | null): Date | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const dateOnly = new Date(`${normalized}T00:00:00Z`);
    return Number.isNaN(dateOnly.getTime()) ? null : dateOnly;
  }

  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?$/.test(normalized)) {
    const utcDate = new Date(`${normalized.replace(" ", "T")}Z`);
    return Number.isNaN(utcDate.getTime()) ? null : utcDate;
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatShanghaiDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function shanghaiDayIndex(date: Date): number {
  const [year, month, day] = formatShanghaiDateKey(date).split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

export function storedDateToShanghaiDay(value: string | null): string {
  const date = parseStoredDate(value);
  return date ? formatShanghaiDateKey(date) : "";
}

export function shanghaiDayUtcRange(day: string): { start: string; end: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const start = new Date(`${day}T00:00:00+08:00`);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + 86400000);
  const toSql = (date: Date) => date.toISOString().slice(0, 19).replace("T", " ");
  return { start: toSql(start), end: toSql(end) };
}

export function formatTime(value: string | null): string {
  if (!value) return "";
  const date = parseStoredDate(value);
  if (!date) return value;
  const now = new Date();
  const days = shanghaiDayIndex(now) - shanghaiDayIndex(date);
  const time = date.toLocaleTimeString("zh-CN", { timeZone: SHANGHAI_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false });
  if (days <= 0) return time;
  if (days === 1) return `昨天 ${time}`;
  if (days > 1 && days < 7) return `${days}天前 ${time}`;
  return `${date.toLocaleDateString("zh-CN", { timeZone: SHANGHAI_TIME_ZONE, month: "2-digit", day: "2-digit" })} ${time}`;
}

export function inputFromUrl(url: URL): PageInput {
  const page = Math.max(1, Math.floor(Number(url.searchParams.get("page") || "1") || 1));
  const status = url.searchParams.get("status") || "active";
  const tab = url.searchParams.get("tab") || "message";
  const mode = url.searchParams.get("mode") || "keyword";
  return {
    q: (url.searchParams.get("q") || "").trim().slice(0, 200),
    type: (url.searchParams.get("type") || "").trim().slice(0, 80),
    tag: (url.searchParams.get("tag") || "").trim().slice(0, 80),
    date: (url.searchParams.get("date") || "").trim().slice(0, 10),
    category: (url.searchParams.get("category") || "").trim().slice(0, 80),
    mood: (url.searchParams.get("mood") || "").trim().slice(0, 30),
    notice: (url.searchParams.get("notice") || "").trim().slice(0, 30),
    status: ["active", "deleted", "superseded", "all"].includes(status) ? status : "active",
    tab: TABS.some((item) => item.id === tab) ? tab : "message",
    page,
    searchMode: mode === "semantic" ? "semantic" : "keyword"
  };
}

export function like(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

export function readFormText(form: FormData, name: string): string {
  return String(form.get(name) || "").trim();
}

export function noticeUrl(url: string, notice: string): string {
  const parsed = new URL(url, "https://placeholder.local");
  parsed.searchParams.set("notice", notice);
  return `${parsed.pathname}${parsed.search}`;
}

export function qs(input: PageInput, patch: Partial<PageInput>): string {
  const next = { ...input, ...patch };
  const params = new URLSearchParams();
  if (next.tab !== "message") params.set("tab", next.tab);
  if (next.q) params.set("q", next.q);
  if (next.searchMode === "semantic" && next.tab === "browse") params.set("mode", "semantic");
  if (next.type && next.tab === "browse") params.set("type", next.type);
  if (next.tag && next.tab === "browse") params.set("tag", next.tag);
  if (next.date && next.tab === "browse") params.set("date", next.date);
  if (next.mood && next.tab === "browse") params.set("mood", next.mood);
  if (next.category && next.tab === "quote") params.set("category", next.category);
  if (next.status !== "active") params.set("status", next.status);
  if (next.notice) params.set("notice", next.notice);
  if (next.page > 1) params.set("page", String(next.page));
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function adminPath(input: PageInput, patch: Partial<PageInput>): string {
  return `/admin/memories${qs(input, patch)}`;
}
