import type { Env } from "../types";

function clean(raw: string | undefined): string | undefined {
  return raw?.trim() || undefined;
}

function finiteNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function integer(raw: string | undefined, fallback: number, min: number, max: number): number {
  return Math.min(Math.max(Math.floor(finiteNumber(raw, fallback)), min), max);
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = finiteNumber(raw, fallback);
  return value > 0 ? Math.floor(value) : fallback;
}

function decimal(raw: string | undefined, fallback: number, min: number, max: number): number {
  return Math.min(Math.max(finiteNumber(raw, fallback), min), max);
}

function strictFlag(raw: string | undefined, fallback = false): boolean {
  const value = clean(raw);
  return value ? value === "true" : fallback;
}

function enabledUnlessFalse(raw: string | undefined, fallback: boolean): boolean {
  const value = clean(raw);
  return value ? value !== "false" : fallback;
}

function first(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = clean(value);
    if (normalized) return normalized;
  }
  return undefined;
}

export interface GatewayConfig {
  enabled: boolean;
  publicModelName: string;
  chatModel?: string;
  defaultUpstreamModel?: string;
  allowModelPassthrough: boolean;
}

export function loadGatewayConfig(env: Env): GatewayConfig {
  return {
    enabled: strictFlag(env.ENABLE_CHAT_GATEWAY),
    publicModelName: clean(env.PUBLIC_MODEL_NAME) ?? "companion",
    chatModel: clean(env.CHAT_MODEL),
    defaultUpstreamModel: clean(env.DEFAULT_UPSTREAM_MODEL),
    allowModelPassthrough: strictFlag(env.ALLOW_MODEL_PASSTHROUGH)
  };
}

export interface MemoryConfig {
  autoMemoryEnabled: boolean;
  mode: string;
  minImportance: number;
}

export function loadMemoryConfig(env: Env): MemoryConfig {
  return {
    autoMemoryEnabled: env.ENABLE_AUTO_MEMORY !== "false",
    mode: clean(env.MEMORY_MODE) ?? "external",
    minImportance: decimal(env.MEMORY_MIN_IMPORTANCE, 0.55, 0, 1)
  };
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
  merge?: string;
  summary?: string;
  dream?: string;
  embedding?: string;
  rerank?: string;
  queryExpansion?: string;
  coordinate?: string;
}

export function loadModelConfig(env: Env): ModelConfig {
  return {
    memory: clean(env.MEMORY_MODEL),
    extraction: clean(env.MEMORY_EXTRACT_MODEL),
    merge: clean(env.MEMORY_MERGE_MODEL),
    summary: clean(env.SUMMARY_MODEL),
    dream: first(env.DREAM_MODEL, env.MEMORY_MODEL, env.SUMMARY_MODEL),
    embedding: clean(env.EMBEDDING_MODEL),
    rerank: clean(env.RERANK_MODEL),
    queryExpansion: clean(env.QUERY_EXPAND_MODEL),
    coordinate: first(env.MEMORY_MODEL, env.DREAM_MODEL, env.MEMORY_EXTRACT_MODEL)
  };
}

export interface ChunkingConfig {
  queueFallbackEnabled: boolean;
  minMessages: number;
  maxMessages: number;
  summaryModel?: string;
  extractModel?: string;
}

export function loadChunkingConfig(env: Env): ChunkingConfig {
  const minMessages = positiveInteger(env.AUTO_CHUNK_MIN_MESSAGES, 10);
  return {
    queueFallbackEnabled: strictFlag(env.ALLOW_QUEUE_FALLBACK),
    minMessages,
    maxMessages: Math.max(minMessages, positiveInteger(env.AUTO_CHUNK_MAX_MESSAGES, 80)),
    summaryModel: clean(env.AUTO_CHUNK_SUMMARY_MODEL),
    extractModel: clean(env.CC_CONNECT_CHUNK_EXTRACT_MODEL)
  };
}

export interface DreamConfig {
  enabled: boolean;
  dryRun: boolean;
  namespace: string;
  timeZone: string;
  maxMessages: number;
  maxRuns: number;
  maxTokens: number;
  memoryContextLimit: number;
  excerptLimit: number;
  emptyMemoryMinChars: number;
  saveDailySummaryMemory: boolean;
  model?: string;
}

export function loadDreamConfig(env: Env): DreamConfig {
  return {
    enabled: enabledUnlessFalse(env.ENABLE_DREAM, false),
    dryRun: enabledUnlessFalse(env.DREAM_DRY_RUN, true),
    namespace: clean(env.DREAM_NAMESPACE) ?? "default",
    timeZone: clean(env.DREAM_TIME_ZONE) ?? "Asia/Shanghai",
    maxMessages: integer(env.DREAM_MAX_MESSAGES, 40, 1, 1_000),
    maxRuns: integer(env.DREAM_MAX_RUNS, 10, 1, 10),
    maxTokens: integer(env.DREAM_MAX_TOKENS, 3_000, 1, 8_000),
    memoryContextLimit: integer(env.DREAM_MEMORY_CONTEXT_LIMIT, 40, 1, 1_000),
    excerptLimit: integer(env.DREAM_EXCERPT_LIMIT, 8, 1, 20),
    emptyMemoryMinChars: integer(env.EMPTY_MEMORY_MIN_CHARS, 4, 1, 20),
    saveDailySummaryMemory: strictFlag(env.ENABLE_DAILY_SUMMARY_MEMORY),
    model: first(env.DREAM_MODEL, env.MEMORY_MODEL, env.SUMMARY_MODEL)
  };
}

export interface FiveAxisConfig {
  enabled: boolean;
  dryRun: boolean;
  coordinateBackfillEnabled: boolean;
  timelineThreads: string[];
}

export function loadFiveAxisConfig(env: Env): FiveAxisConfig {
  return {
    enabled: enabledUnlessFalse(env.ENABLE_FIVE_AXIS, true),
    dryRun: strictFlag(env.FIVE_AXIS_DRY_RUN),
    coordinateBackfillEnabled: strictFlag(env.COORDINATE_BACKFILL_ENABLED),
    timelineThreads: (env.TIMELINE_THREADS ?? "").split(",").map((value) => value.trim()).filter(Boolean)
  };
}

export interface RetentionConfig {
  activeMemoryAutoExpiry: false;
  messagesDays: number;
  ccConnectProcessedMessagesDays: number;
  usageLogsDays: number;
  memoryEventsDays: number;
  idempotencyKeysDays: number;
  terminalMemoryHardDeleteDays: number;
  throttleHours: number;
}

export function loadRetentionConfig(env: Env): RetentionConfig {
  return {
    activeMemoryAutoExpiry: false,
    messagesDays: positiveInteger(env.MEMORY_RETENTION_MESSAGES_DAYS, 14),
    ccConnectProcessedMessagesDays: positiveInteger(env.CC_CONNECT_MESSAGE_RETENTION_DAYS, 7),
    usageLogsDays: positiveInteger(env.MEMORY_RETENTION_USAGE_LOGS_DAYS, 30),
    memoryEventsDays: positiveInteger(env.MEMORY_RETENTION_EVENTS_DAYS, 30),
    idempotencyKeysDays: positiveInteger(env.MEMORY_RETENTION_IDEMPOTENCY_DAYS, 7),
    terminalMemoryHardDeleteDays: positiveInteger(env.MEMORY_RETENTION_TERMINAL_MEMORY_DAYS, 30),
    throttleHours: positiveInteger(env.MEMORY_RETENTION_THROTTLE_HOURS, 24)
  };
}

export interface EAxisConfig {
  startedAt: string | null;
  shadowDays: number;
  rankingEnabled: boolean;
}

export function loadEAxisConfig(env: Pick<Env, "E_AXIS_STARTED_AT" | "E_AXIS_SHADOW_DAYS" | "E_AXIS_RANKING_ENABLED">): EAxisConfig {
  return {
    startedAt: clean(env.E_AXIS_STARTED_AT) ?? null,
    shadowDays: integer(env.E_AXIS_SHADOW_DAYS, 30, 0, 365),
    rankingEnabled: strictFlag(env.E_AXIS_RANKING_ENABLED)
  };
}

export interface AppConfig {
  gateway: GatewayConfig;
  memory: MemoryConfig;
  recall: RecallConfig;
  models: ModelConfig;
  chunking: ChunkingConfig;
  dream: DreamConfig;
  fiveAxis: FiveAxisConfig;
  retention: RetentionConfig;
  eAxis: EAxisConfig;
}

export function loadAppConfig(env: Env): AppConfig {
  return {
    gateway: loadGatewayConfig(env),
    memory: loadMemoryConfig(env),
    recall: loadRecallConfig(env),
    models: loadModelConfig(env),
    chunking: loadChunkingConfig(env),
    dream: loadDreamConfig(env),
    fiveAxis: loadFiveAxisConfig(env),
    retention: loadRetentionConfig(env),
    eAxis: loadEAxisConfig(env)
  };
}

export interface AppClock {
  now(): Date;
  nowMs(): number;
  iso(): string;
  today(timeZone?: string): string;
}

export function createClock(readNow: () => Date = () => new Date()): AppClock {
  return {
    now: () => readNow(),
    nowMs: () => readNow().getTime(),
    iso: () => readNow().toISOString(),
    today: (timeZone = "Asia/Shanghai") => new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(readNow())
  };
}

export const systemClock = createClock();
