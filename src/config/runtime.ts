import type { Env } from "../types";

function finiteNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function integer(raw: string | undefined, fallback: number, min: number, max: number): number {
  return Math.min(Math.max(Math.floor(finiteNumber(raw, fallback)), min), max);
}

function decimal(raw: string | undefined, fallback: number, min: number, max: number): number {
  return Math.min(Math.max(finiteNumber(raw, fallback), min), max);
}

export interface RecallConfig {
  searchTopK: number;
  contextTopK: number;
  searchMaxOutput: number;
  filterMaxCandidates: number;
  filterMaxOutput: number;
  filterMaxContentChars: number;
  filterOutputChars: number;
  filterMinScore: number;
}

export function loadRecallConfig(env: Env): RecallConfig {
  return {
    searchTopK: integer(env.MEMORY_TOP_K, 8, 1, 50),
    contextTopK: integer(env.MEMORY_RECALL_TOP_K, 3, 1, 5),
    searchMaxOutput: integer(env.MEMORY_SEARCH_MAX_OUTPUT, 8, 1, 20),
    filterMaxCandidates: integer(env.MEMORY_FILTER_MAX_CANDIDATES, 12, 1, 50),
    filterMaxOutput: integer(env.MEMORY_FILTER_MAX_OUTPUT, 6, 1, 20),
    filterMaxContentChars: integer(env.MEMORY_FILTER_MAX_CONTENT_CHARS, 700, 120, 3_000),
    filterOutputChars: integer(env.MEMORY_FILTER_OUTPUT_CHARS, 300, 60, 1_000),
    filterMinScore: decimal(env.MEMORY_FILTER_MIN_SCORE ?? env.MEMORY_MIN_SCORE, 0.35, 0, 1)
  };
}

export interface ModelConfig {
  memory?: string;
  extraction?: string;
  dream?: string;
}

export function loadModelConfig(env: Env): ModelConfig {
  const clean = (value: string | undefined) => value?.trim() || undefined;
  return { memory: clean(env.MEMORY_MODEL), extraction: clean(env.MEMORY_EXTRACT_MODEL), dream: clean(env.DREAM_MODEL) };
}

export interface AppClock {
  now(): Date;
  today(timeZone?: string): string;
}

export const systemClock: AppClock = {
  now: () => new Date(),
  today: (timeZone = "Asia/Shanghai") => new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date())
};
