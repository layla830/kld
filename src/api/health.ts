import { json } from "../utils/json";
import type { Env } from "../types";

const requiredTextVars = [
  "CHATBOX_API_KEY",
  "CHAT_MODEL",
  "MEMORY_FILTER_PROVIDER",
  "MEMORY_FILTER_MODEL",
  "MEMORY_MODEL",
  "VISION_MODEL"
] as const;

function directUpstreamReady(env: Env): boolean {
  return Boolean(env.UPSTREAM_BASE_URL && env.UPSTREAM_API_KEY);
}

function aiGatewayReady(env: Env): boolean {
  return Boolean(env.AI_GATEWAY_BASE_URL && env.CF_AIG_TOKEN);
}

export function handleHealth(env: Env): Response {
  const missing_text_vars = requiredTextVars.filter((name) => !env[name]);
  const upstream_ready = directUpstreamReady(env);
  const ai_gateway_ready = aiGatewayReady(env);
  const missing_upstream_vars = upstream_ready || ai_gateway_ready
    ? []
    : ["UPSTREAM_BASE_URL + UPSTREAM_API_KEY or AI_GATEWAY_BASE_URL + CF_AIG_TOKEN"];

  return json({
    ok: missing_text_vars.length === 0 && missing_upstream_vars.length === 0,
    service: "companion-memory-proxy",
    missing_text_vars,
    missing_upstream_vars,
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
