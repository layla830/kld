import { queryHintAliasGroups } from "./queryHints";
import { chineseNgrams, normalizeQueryForMemorySearch, normalizeText } from "./query";
import { parseTimeIntent, type TimeIntent } from "./recallTemporal";

const ALIAS_GROUPS = [
  ["sm", "s/m", "bdsm", "dom", "sub", "brat", "switch", "支配", "臣服", "主导", "被主导"],
  ["cc", "claude code", "claude-code", "cc-connect", "telegram", "tg"],
  ["cf", "cloudflare", "worker", "workers", "d1", "vectorize"],
  ["memory", "memories", "记忆", "记忆库", "memory home", "小家"],
  ["book", "books", "reading", "reader", "共读", "读书", "书架"],
  ["handoff", "交接"], ["startup", "startup context", "启动", "启动上下文"],
  ...queryHintAliasGroups(), ["vps", "server", "服务器"]
];

export interface RecallQueryPlan {
  rawQuery: string;
  searchQuery: string;
  expandedQuery: string;
  timeIntent: TimeIntent;
  literalTerms: string[];
}

function aliasMatches(query: string, alias: string): boolean {
  const value = normalizeText(alias);
  if (!/[a-z0-9]/i.test(value)) return query.includes(value);
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(query);
}

function expandAliases(query: string): string {
  const normalized = normalizeText(query);
  const terms = new Set([query.trim()]);
  for (const group of ALIAS_GROUPS) if (group.some((alias) => aliasMatches(normalized, alias))) group.forEach((alias) => terms.add(alias));
  return [...terms].filter(Boolean).join(" ");
}

export function literalQueryTerms(rawQuery: string): string[] {
  const normalized = normalizeText(rawQuery);
  if (!normalized || normalized.length > 80) return [];
  const quoted = rawQuery.match(/["“「『]([^"”」』]+)["”」』]/);
  if (quoted?.[1]) return [normalizeText(quoted[1])];
  const compact = normalized.replace(/\s+/g, "");
  if (/^[\u4e00-\u9fff]{2,8}$/.test(compact)) return [compact];
  const words = normalized.match(/[a-z][a-z0-9_+-]{1,}/gi) ?? [];
  if (words.length === 1 && words[0].length <= 20) return [normalizeText(words[0])];
  return [];
}

export function buildRecallQueryPlan(query: string, rawQuery = query): RecallQueryPlan {
  const searchQuery = normalizeQueryForMemorySearch(query);
  const timeIntent = parseTimeIntent(rawQuery);
  return {
    rawQuery,
    searchQuery,
    timeIntent,
    expandedQuery: expandAliases([searchQuery, ...timeIntent.terms].filter(Boolean).join(" ")),
    literalTerms: literalQueryTerms(rawQuery)
  };
}

export function recordHaystack(record: { content: string; summary?: string | null; fact_key?: string | null; tags: string | null; type: string }): string {
  return normalizeText(`${record.content} ${record.summary || ""} ${record.fact_key || ""} ${record.tags || ""} ${record.type}`);
}

export function lexicalTerms(query: string, expandedQuery: string): string[] {
  const terms = new Set<string>();
  for (const source of [query, expandedQuery]) for (const item of source.match(/[a-z][a-z0-9_+-]{1,}|[\u4e00-\u9fff]{2,}/gi) ?? []) {
    const term = normalizeText(item);
    if (term.length < 2) continue;
    terms.add(term);
    if (/^[\u4e00-\u9fff]+$/.test(term) && term.length > 2) chineseNgrams(term).forEach((gram) => terms.add(gram));
  }
  return [...terms].slice(0, 30);
}

export function strongNeedles(query: string, expandedQuery: string): string[] {
  const needles = new Set(lexicalTerms(query, expandedQuery));
  for (const match of expandedQuery.match(/\b\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}\b/g) ?? []) {
    const [year, month, day] = match.split(/[.\-/]/).map(Number);
    needles.add(`${year}.${month}.${day}`); needles.add(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`); needles.add(`${month}月${day}日`);
  }
  return [...needles].filter((item) => item.length >= 2).slice(0, 30);
}
