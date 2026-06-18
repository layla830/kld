import type { MemoryApiRecord } from "../types";
import { chineseNgrams, normalizeQueryForMemorySearch } from "./query";

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

const STOP_TERMS = new Set([
  "你", "我", "她", "他", "我们", "你们", "他们", "这个", "那个", "什么", "哪个", "哪里", "怎么", "为啥",
  "之前", "上次", "以前", "过去", "刚才", "昨天", "前天", "今天", "今晚", "昨晚", "那次", "那天", "当时",
  "记得", "忘了", "想起来", "回忆", "印象", "说过", "聊过", "提过", "说了", "聊了", "发生", "发生了",
  "是什么", "怎么来的", "由来", "怎么聊", "怎么聊的", "问题", "事情", "东西", "正常", "聊天", "召回", "记忆",
  "the", "and", "that", "what", "when", "where", "how", "before", "previous", "remember", "recall", "forgot", "last", "time"
]);

function shanghaiYear(): number {
  return new Date(Date.now() + SHANGHAI_OFFSET_MS).getUTCFullYear();
}

function addDateNeedleSet(needles: Set<string>, year: string | number, month: string | number, day: string | number): void {
  const yyyy = String(year);
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const iso = `${yyyy}-${mm}-${dd}`;
  needles.add(`${Number(month)}月${Number(day)}日`);
  needles.add(iso);
  needles.add(`date:${iso}`);
}

export function dateNeedles(query: string): string[] {
  const needles = new Set<string>();

  for (const match of query.matchAll(/\b(20\d{2})[.\-/年](\d{1,2})[.\-/月](\d{1,2})日?/g)) {
    const [, year, month, day] = match;
    addDateNeedleSet(needles, year, month, day);
  }

  for (const match of query.matchAll(/(?:^|[^\d])(\d{1,2})月(\d{1,2})日/g)) {
    const [, month, day] = match;
    addDateNeedleSet(needles, shanghaiYear(), month, day);
  }

  for (const match of query.matchAll(/(?:^|[^\d])(\d{1,2})[.\-/](\d{1,2})(?:$|[^\d])/g)) {
    const [, month, day] = match;
    addDateNeedleSet(needles, shanghaiYear(), month, day);
  }

  return [...needles];
}

export function topicNeedles(query: string): string[] {
  const needles = new Set<string>();
  const normalized = normalizeQueryForMemorySearch(query);
  for (const match of normalized.match(/[a-z][a-z0-9_+-]{2,}|[\u4e00-\u9fff]{2,}/gi) ?? []) {
    const term = match.toLowerCase();
    if (STOP_TERMS.has(term)) continue;
    needles.add(term);
    if (/^[\u4e00-\u9fff]+$/.test(term) && term.length > 2) {
      for (const gram of chineseNgrams(term)) {
        if (!STOP_TERMS.has(gram)) needles.add(gram);
      }
    }
  }
  return [...needles];
}

export function supportNeedles(rawQuery: string, searchQuery: string): string[] {
  return [...new Set([...dateNeedles(rawQuery), ...topicNeedles(`${rawQuery} ${searchQuery}`)])]
    .sort((a, b) => b.length - a.length)
    .slice(0, 16);
}

export function supportHaystack(memory: MemoryApiRecord): string {
  return `${memory.content} ${memory.summary || ""} ${memory.fact_key || ""} ${memory.tags.join(" ")} ${memory.type} ${memory.source || ""} ${memory.created_at} ${memory.updated_at}`.toLowerCase();
}

export function matchesAnyNeedle(memory: MemoryApiRecord, needles: string[]): boolean {
  if (needles.length === 0) return true;
  const haystack = supportHaystack(memory);
  return needles.some((needle) => haystack.includes(needle.toLowerCase()));
}

export function likeNeedle(needle: string): string {
  return `%${needle.replace(/([%_\\])/g, "\\$1")}%`;
}
