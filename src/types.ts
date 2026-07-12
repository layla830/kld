export interface Env {
  DB: D1Database;
  AI?: Ai;
  MEMORY_QUEUE?: Queue<QueueMessage>;
  ALLOW_QUEUE_FALLBACK?: string;
  VECTORIZE?: Vectorize | VectorizeIndex;
  PUBLIC_MODEL_NAME?: string;
  ENABLE_CHAT_GATEWAY?: string;
  CHAT_MODEL?: string;
  DEFAULT_UPSTREAM_MODEL?: string;
  ALLOW_MODEL_PASSTHROUGH?: string;
  UPSTREAM_BASE_URL?: string;
  UPSTREAM_API_KEY?: string;
  AI_GATEWAY_BASE_URL?: string;
  CHATBOX_API_KEY?: string;
  IM_API_KEY?: string;
  DEBUG_API_KEY?: string;
  MEMORY_MCP_API_KEY?: string;
  ADMIN_PASSWORD?: string;
  GUIDE_DOG_API_KEY?: string;
  CF_AIG_TOKEN?: string;
  ENABLE_AUTO_MEMORY?: string;
  MEMORY_MODE?: string;
  MEMORY_MODEL?: string;
  MEMORY_EXTRACT_MODEL?: string;
  MEMORY_MERGE_MODEL?: string;
  ENABLE_MEMORY_FILTER?: string;
  MEMORY_FILTER_PROVIDER?: string;
  MEMORY_FILTER_MODEL?: string;
  MEMORY_SEARCH_MAX_OUTPUT?: string;
  VISION_MODEL?: string;
  GUIDE_DOG_MODEL?: string;
  MEMORY_FILTER_MAX_CANDIDATES?: string;
  MEMORY_FILTER_MAX_OUTPUT?: string;
  MEMORY_FILTER_MAX_CONTENT_CHARS?: string;
  MEMORY_FILTER_OUTPUT_CHARS?: string;
  MEMORY_FILTER_MIN_SCORE?: string;
  MEMORY_EXTRACT_EVERY_N_MESSAGES?: string;
  MEMORY_MIN_IMPORTANCE?: string;
  AUTO_DIARY_ENABLED?: string;
  AUTO_CHUNK_MIN_MESSAGES?: string;
  AUTO_CHUNK_MAX_MESSAGES?: string;
  AUTO_CHUNK_SUMMARY_MODEL?: string;
  CC_CONNECT_CHUNK_EXTRACT_MODEL?: string;
  CC_CONNECT_MESSAGE_RETENTION_DAYS?: string;
  MEMORY_RETENTION_MESSAGES_DAYS?: string;
  MEMORY_RETENTION_USAGE_LOGS_DAYS?: string;
  MEMORY_RETENTION_EVENTS_DAYS?: string;
  MEMORY_RETENTION_IDEMPOTENCY_DAYS?: string;
  MEMORY_RETENTION_TERMINAL_MEMORY_DAYS?: string;
  MEMORY_RETENTION_THROTTLE_HOURS?: string;
  INJECTION_MODE?: string;
  EMBEDDING_MODEL?: string;
  MEMORY_TOP_K?: string;
  MEMORY_RECALL_TOP_K?: string;
  MEMORY_MIN_SCORE?: string;
  ANTHROPIC_CACHE_ENABLED?: string;
  ANTHROPIC_CACHE_TTL?: string;
  ANTHROPIC_CACHE_STABLE_SYSTEM?: string;
  CUSTOM_ANTHROPIC_MESSAGES_PATH?: string;
  ANTHROPIC_THINKING_ENABLED?: string;
  ANTHROPIC_THINKING_BUDGET?: string;
  FORCE_ANTHROPIC_NATIVE?: string;
  ENABLE_CACHE_API?: string;
  CACHE_DEFAULT_TTL_SECONDS?: string;
  CACHE_MAX_VALUE_BYTES?: string;
  SUMMARY_MODEL?: string;
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
  ENABLE_DAILY_SUMMARY_MEMORY?: string;
  EMPTY_MEMORY_MIN_CHARS?: string;
  E_AXIS_STARTED_AT?: string;
  E_AXIS_SHADOW_DAYS?: string;
  ENABLE_QUERY_EXPANSION?: string;
  QUERY_EXPAND_MODEL?: string;
  ENABLE_RERANK?: string;
  RERANK_MODEL?: string;
  TIMELINE_THREADS?: string;
  COORDINATE_BACKFILL_ENABLED?: string;
}

export interface MemoryMaintenanceQueueMessage {
  type: "memory_maintenance";
  namespace: string;
  conversationId: string;
  fromMessageId: string;
  toMessageId: string;
  source: string;
  idempotencyKey: string;
}

export interface ConversationChunkQueueMessage {
  type: "conversation_chunk";
  namespace: string;
  conversationId: string;
  source: string;
  maxMessages?: number;
  idempotencyKey: string;
}

export interface RetentionQueueMessage {
  type: "retention";
  namespace: string;
  idempotencyKey: string;
}

export interface DiaryRescreenQueueMessage {
  type: "diary_rescreen";
  namespace: string;
  diaryIds: string[];
  importer: string;
  apply: boolean;
  jobId: string;
}

export interface MemoryVectorSyncQueueMessage {
  type: "memory_vector_sync";
  namespace: string;
  memoryIds: string[];
  jobId: string;
}

export interface CoordinateBackfillQueueMessage {
  type: "coordinate_backfill";
  namespace: string;
  jobId: string;
}

export interface RelationBackfillQueueMessage {
  type: "relation_backfill";
  namespace: string;
  requiredTag: string;
  jobId: string;
}

export interface MetabolismScanQueueMessage {
  type: "metabolism_scan";
  namespace: string;
  jobId: string;
}

export type QueueMessage =
  | MemoryMaintenanceQueueMessage
  | ConversationChunkQueueMessage
  | RetentionQueueMessage
  | DiaryRescreenQueueMessage
  | MemoryVectorSyncQueueMessage
  | CoordinateBackfillQueueMessage
  | RelationBackfillQueueMessage
  | MetabolismScanQueueMessage;

export type Scope =
  | "chat:proxy"
  | "memory:read"
  | "memory:write"
  | "cache:read"
  | "cache:write"
  | "debug:read"
  | "export:read";

export type InjectionMode = "rag" | "full" | "hybrid" | "none";
export type MemoryMode = "external" | "builtin" | "hybrid" | "none";

export interface KeyProfile {
  source: string;
  namespace: string;
  scopes: Scope[];
  injectionMode: InjectionMode;
  memoryMode: MemoryMode;
  allowModelPassthrough: boolean;
  debug: boolean;
}

export interface AuthResult {
  ok: true;
  profile: KeyProfile;
  keyName: "CHATBOX_API_KEY" | "IM_API_KEY" | "DEBUG_API_KEY" | "MEMORY_MCP_API_KEY" | "GUIDE_DOG_API_KEY";
}

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<unknown> | null;
  created_at?: string;
  name?: string;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: unknown;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

export interface OpenAIChatChoice {
  index?: number;
  message?: OpenAIChatMessage;
  finish_reason?: string | null;
  [key: string]: unknown;
}

export interface OpenAIChatResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: OpenAIChatChoice[];
  usage?: TokenUsage;
  [key: string]: unknown;
}

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [key: string]: unknown;
}

export interface Conversation {
  id: string;
  namespace: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRecord {
  id: string;
  conversation_id: string;
  namespace: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  source: string | null;
  created_at: string;
}

export interface MemoryRecord {
  id: string;
  namespace: string;
  type: string;
  content: string;
  summary: string | null;
  fact_key: string | null;
  active_fact: number;
  thread: string | null;
  risk_level: string | null;
  urgency_level: string | null;
  tension_score: number | null;
  response_posture: string | null;
  audit_state: string | null;
  valence: number | null;
  arousal: number | null;
  importance: number;
  confidence: number;
  status: "active" | "deleted" | "superseded" | "low_confidence" | string;
  pinned: number;
  tags: string | null;
  source: string | null;
  source_message_ids: string | null;
  vector_id: string | null;
  vector_synced: number;
  vector_sync_status?: "synced" | "failed" | "pending" | "deleted" | null;
  last_recalled_at: string | null;
  recall_count: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export interface MemoryApiRecord {
  id: string;
  namespace: string;
  type: string;
  content: string;
  summary: string | null;
  fact_key: string | null;
  active_fact: boolean;
  thread: string | null;
  risk_level: string | null;
  urgency_level: string | null;
  tension_score: number | null;
  response_posture: string | null;
  audit_state: string | null;
  valence: number | null;
  arousal: number | null;
  importance: number;
  confidence: number;
  status: string;
  pinned: boolean;
  tags: string[];
  source: string | null;
  source_message_ids: string[];
  vector_id: string | null;
  last_recalled_at: string | null;
  recall_count: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  score?: number;
}

export interface SummaryRecord {
  id: string;
  namespace: string;
  conversation_id: string | null;
  content: string;
  from_message_id: string | null;
  to_message_id: string | null;
  message_count: number;
  vector_id: string | null;
  created_at: string;
  updated_at: string;
}

