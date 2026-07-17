/**
 * Runtime variables supplied through Wrangler vars, secrets, or the
 * Cloudflare dashboard. Platform bindings are generated separately by
 * `wrangler types` and intentionally do not live in these business groups.
 */

export interface AuthVariables {
  UPSTREAM_API_KEY?: string;
  CHATBOX_API_KEY?: string;
  IM_API_KEY?: string;
  DEBUG_API_KEY?: string;
  MEMORY_MCP_API_KEY?: string;
  ADMIN_PASSWORD?: string;
  GUIDE_DOG_API_KEY?: string;
  CF_AIG_TOKEN?: string;
}

export interface GatewayVariables {
  PUBLIC_MODEL_NAME?: string;
  ENABLE_CHAT_GATEWAY?: string;
  CHAT_MODEL?: string;
  DEFAULT_UPSTREAM_MODEL?: string;
  ALLOW_MODEL_PASSTHROUGH?: string;
  UPSTREAM_BASE_URL?: string;
  AI_GATEWAY_BASE_URL?: string;
  CUSTOM_ANTHROPIC_MESSAGES_PATH?: string;
  FORCE_ANTHROPIC_NATIVE?: string;
}

export interface ModelVariables {
  MEMORY_MODEL?: string;
  MEMORY_EXTRACT_MODEL?: string;
  MEMORY_MERGE_MODEL?: string;
  SUMMARY_MODEL?: string;
  EMBEDDING_MODEL?: string;
  VISION_MODEL?: string;
  GUIDE_DOG_MODEL?: string;
  QUERY_EXPAND_MODEL?: string;
  RERANK_MODEL?: string;
}

export interface MemoryVariables {
  ENABLE_AUTO_MEMORY?: string;
  MEMORY_MODE?: string;
  MEMORY_EXTRACT_EVERY_N_MESSAGES?: string;
  MEMORY_MIN_IMPORTANCE?: string;
  AUTO_DIARY_ENABLED?: string;
  INJECTION_MODE?: string;
  MEMORY_TOP_K?: string;
  MEMORY_RECALL_TOP_K?: string;
  MEMORY_MIN_SCORE?: string;
  ENABLE_DAILY_SUMMARY_MEMORY?: string;
  EMPTY_MEMORY_MIN_CHARS?: string;
}

export interface RecallVariables {
  ENABLE_MEMORY_FILTER?: string;
  MEMORY_FILTER_PROVIDER?: string;
  MEMORY_FILTER_MODEL?: string;
  MEMORY_SEARCH_MAX_OUTPUT?: string;
  MEMORY_FILTER_MAX_CANDIDATES?: string;
  MEMORY_FILTER_MAX_OUTPUT?: string;
  MEMORY_FILTER_MAX_CONTENT_CHARS?: string;
  MEMORY_FILTER_OUTPUT_CHARS?: string;
  MEMORY_FILTER_MIN_SCORE?: string;
  ENABLE_QUERY_EXPANSION?: string;
  ENABLE_RERANK?: string;
}

export interface ChunkingVariables {
  ALLOW_QUEUE_FALLBACK?: string;
  AUTO_CHUNK_MIN_MESSAGES?: string;
  AUTO_CHUNK_MAX_MESSAGES?: string;
  AUTO_CHUNK_SUMMARY_MODEL?: string;
  CC_CONNECT_CHUNK_EXTRACT_MODEL?: string;
}

export interface RetentionVariables {
  CC_CONNECT_MESSAGE_RETENTION_DAYS?: string;
  MEMORY_RETENTION_MESSAGES_DAYS?: string;
  MEMORY_RETENTION_USAGE_LOGS_DAYS?: string;
  MEMORY_RETENTION_EVENTS_DAYS?: string;
  MEMORY_RETENTION_IDEMPOTENCY_DAYS?: string;
  MEMORY_RETENTION_TERMINAL_MEMORY_DAYS?: string;
  MEMORY_RETENTION_THROTTLE_HOURS?: string;
}

export interface CacheVariables {
  ANTHROPIC_CACHE_ENABLED?: string;
  ANTHROPIC_CACHE_TTL?: string;
  ANTHROPIC_CACHE_STABLE_SYSTEM?: string;
  ANTHROPIC_THINKING_ENABLED?: string;
  ANTHROPIC_THINKING_BUDGET?: string;
  ENABLE_CACHE_API?: string;
  CACHE_DEFAULT_TTL_SECONDS?: string;
  CACHE_MAX_VALUE_BYTES?: string;
}

export interface DreamVariables {
  ENABLE_DREAM?: string;
  DREAM_DRY_RUN?: string;
  DREAM_MODEL?: string;
  DREAM_TIME_ZONE?: string;
  DREAM_MAX_MESSAGES?: string;
  DREAM_MAX_RUNS?: string;
  DREAM_MAX_TOKENS?: string;
  DREAM_MEMORY_CONTEXT_LIMIT?: string;
  DREAM_EXCERPT_LIMIT?: string;
  DREAM_NAMESPACE?: string;
}

export interface FiveAxisVariables {
  ENABLE_FIVE_AXIS?: string;
  FIVE_AXIS_DRY_RUN?: string;
  E_AXIS_SHADOW_DAYS?: string;
  E_AXIS_RANKING_ENABLED?: string;
  TIMELINE_THREADS?: string;
  COORDINATE_BACKFILL_ENABLED?: string;
}

export type RuntimeVariables =
  & AuthVariables
  & GatewayVariables
  & ModelVariables
  & MemoryVariables
  & RecallVariables
  & ChunkingVariables
  & RetentionVariables
  & CacheVariables
  & DreamVariables
  & FiveAxisVariables;
