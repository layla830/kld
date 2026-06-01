import { json } from "../utils/json";
import type { Env } from "../types";

const memoryTextVars = ["MEMORY_FILTER_PROVIDER", "MEMORY_FILTER_MODEL", "MEMORY_MODEL"] as const;
const chatGatewayTextVars = ["CHATBOX_API_KEY", "CHAT_MODEL"] as const;

type FeatureStatus = "enabled" | "disabled_by_config" | "disabled_missing_config" | "bound" | "missing_binding";

function directUpstreamReady(env: Env): boolean {
  return Boolean(env.UPSTREAM_BASE_URL && env.UPSTREAM_API_KEY);
}

function aiGatewayReady(env: Env): boolean {
  return Boolean(env.AI_GATEWAY_BASE_URL && env.CF_AIG_TOKEN);
}

function enabledOrMissing(value: boolean): FeatureStatus {
  return value ? "enabled" : "disabled_missing_config";
}

function boundOrMissing(value: boolean): FeatureStatus {
  return value ? "bound" : "missing_binding";
}

export function handleHealth(env: Env): Response {
  const chatGatewayEnabled = env.ENABLE_CHAT_GATEWAY === "true";
  const memoryMcpEnabled = Boolean(env.MEMORY_MCP_API_KEY);
  const adminEnabled = Boolean(env.ADMIN_PASSWORD);
  const autoMemoryEnabled = env.ENABLE_AUTO_MEMORY !== "false" && (env.MEMORY_MODE || "external") !== "none";
  const autoDiaryEnabled = env.AUTO_DIARY_ENABLED === "true";
  const upstream_ready = directUpstreamReady(env);
  const ai_gateway_ready = aiGatewayReady(env);
  const upstreamAvailable = upstream_ready || ai_gateway_ready;

  const missing_text_vars = [
    ...(!memoryMcpEnabled ? ["MEMORY_MCP_API_KEY"] : []),
    ...(!adminEnabled ? ["ADMIN_PASSWORD"] : []),
    ...memoryTextVars.filter((name) => !env[name]),
    ...(chatGatewayEnabled ? chatGatewayTextVars.filter((name) => !env[name]) : [])
  ];
  const missing_upstream_vars = chatGatewayEnabled && !upstreamAvailable
    ? ["UPSTREAM_BASE_URL + UPSTREAM_API_KEY or AI_GATEWAY_BASE_URL + CF_AIG_TOKEN"]
    : [];
  const warnings = [
    ...(autoMemoryEnabled && !env.MEMORY_QUEUE
      ? ["MEMORY_QUEUE binding missing; automatic memory maintenance will not run"]
      : []),
    ...(!autoDiaryEnabled
      ? ["AUTO_DIARY_ENABLED=false; conversation_chunk will only mark messages processed and will not generate diary/chunk memories"]
      : [])
  ];

  return json({
    ok: missing_text_vars.length === 0 && missing_upstream_vars.length === 0,
    service: "kld",
    mode: {
      chat_gateway: chatGatewayEnabled,
      memory_mcp: memoryMcpEnabled,
      admin: adminEnabled,
      auto_memory: autoMemoryEnabled,
      auto_diary: autoDiaryEnabled
    },
    features: {
      chat_gateway: chatGatewayEnabled ? "enabled" : "disabled_by_config",
      memory_mcp: enabledOrMissing(memoryMcpEnabled),
      admin: enabledOrMissing(adminEnabled),
      queue: boundOrMissing(Boolean(env.MEMORY_QUEUE)),
      auto_memory: autoMemoryEnabled ? "enabled" : "disabled_by_config",
      auto_diary: autoDiaryEnabled ? "enabled" : "disabled_by_config",
      chunk_generation: autoDiaryEnabled ? "enabled" : "disabled_by_config"
    },
    missing_text_vars,
    missing_upstream_vars,
    warnings,
    upstream: {
      direct_openai_compatible: upstream_ready,
      cloudflare_ai_gateway: ai_gateway_ready
    },
    bindings: {
      ai: Boolean(env.AI),
      d1: Boolean(env.DB),
      vectorize: Boolean(env.VECTORIZE),
      queue: Boolean(env.MEMORY_QUEUE)
    }
  });
}
