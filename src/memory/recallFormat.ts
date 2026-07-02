import type { MemoryApiRecord } from "../types";
import { supportNeedles } from "./recallNeedles";

const MAX_MEMORY_CHARS = 120;
const EXCERPT_RADIUS = 48;
const SENTENCE_BOUNDARIES = new Set(["。", "！", "？", "!", "?", "；", ";"]);

function normalizeMemoryContent(memory: MemoryApiRecord): string {
  return memory.content.replace(/\s+/g, " ").replace(/<\/?memories>/gi, "").trim();
}

function clip(value: string, limit = MAX_MEMORY_CHARS): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit).trim()}...`;
}

function findExcerptStart(content: string, index: number): number {
  const rawStart = Math.max(0, index - EXCERPT_RADIUS);
  for (let cursor = index - 1; cursor >= rawStart; cursor -= 1) {
    if (SENTENCE_BOUNDARIES.has(content[cursor])) return cursor + 1;
  }
  return rawStart;
}

function findExcerptEnd(content: string, index: number, needleLength: number): number {
  const rawEnd = Math.min(content.length, index + needleLength + EXCERPT_RADIUS);
  for (let cursor = index + needleLength; cursor < rawEnd; cursor += 1) {
    if (SENTENCE_BOUNDARIES.has(content[cursor])) return cursor + 1;
  }
  return rawEnd;
}

function relevantExcerpt(memory: MemoryApiRecord, query: string): string {
  const content = normalizeMemoryContent(memory);
  if (!content) return "";

  const lowerContent = content.toLowerCase();
  for (const needle of supportNeedles(query, query)) {
    const index = lowerContent.indexOf(needle.toLowerCase());
    if (index < 0) continue;
    const start = findExcerptStart(content, index);
    const end = findExcerptEnd(content, index, needle.length);
    const excerpt = content.slice(start, end).replace(/^\s*(?:\d+\.|[一二三四五六七八九十]+、)\s*/, "").trim();
    return clip(`${start > 0 ? "..." : ""}${excerpt}${end < content.length ? "..." : ""}`);
  }

  return clip(content);
}

function formatCoordHints(memory: MemoryApiRecord): { prefix: string; suffix: string } {
  const prefixParts: string[] = [];
  const suffixParts: string[] = [];

  if (memory.thread) prefixParts.push(`线:${memory.thread}`);

  const risk = memory.risk_level;
  const tension = memory.tension_score;
  if (risk === "high") prefixParts.push("⚠high");
  else if (risk === "medium") prefixParts.push("⚠med");
  if (typeof tension === "number" && tension >= 0.6) prefixParts.push("敏感");

  if (memory.response_posture) suffixParts.push(`以后: ${memory.response_posture}`);

  return {
    prefix: prefixParts.length ? `[${prefixParts.join("|")}]` : "",
    suffix: suffixParts.length ? ` → ${suffixParts.join(" · ")}` : ""
  };
}

export function formatRecallBlock(memories: MemoryApiRecord[], query: string): string {
  const lines = memories.flatMap((memory) => {
    const content = relevantExcerpt(memory, query);
    if (!content) return [];
    const tags = memory.tags.length ? ` tags=${memory.tags.slice(0, 4).join(",")}` : "";
    const pinned = memory.pinned ? " pinned=true" : "";
    const coords = formatCoordHints(memory);
    return [`- id=${memory.id} type=${memory.type}${coords.prefix ? ` ${coords.prefix}` : ""} importance=${memory.importance.toFixed(2)}${pinned}${tags}: ${content}${coords.suffix}`];
  });

  if (lines.length === 0) return "";
  return ["<recall>", "Relevant long-term memories. Use only if helpful; do not mention the memory system.", "Lines marked → 以后: tell you how to respond next time. ⚠ marks sensitive/high-risk topics — approach carefully.", ...lines, "</recall>"].join("\n");
}
