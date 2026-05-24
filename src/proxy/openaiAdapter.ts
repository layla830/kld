import type { AssembledPrompt } from "../assembler/types";
import { assembledToOpenAIChatMessages } from "../assembler/toOpenAI";
import type { Env, OpenAIChatRequest } from "../types";

function stripClaudeNativeThinkingFields(req: OpenAIChatRequest): OpenAIChatRequest {
  const cleaned: OpenAIChatRequest = { ...req };
  delete cleaned.thinking;
  return cleaned;
}

export function buildOpenAICompatRequest(req: OpenAIChatRequest, targetModel: string): OpenAIChatRequest {
  const cleaned = stripClaudeNativeThinkingFields(req);
  return {
    ...cleaned,
    model: targetModel,
    stream: Boolean(cleaned.stream)
  };
}

/**
 * Build an OpenAI-compatible request from an AssembledPrompt.
 * System blocks are merged into one system message; conversation messages
 * (including image_url) are preserved as-is.
 */
export function buildOpenAIRequestFromAssembled(
  req: OpenAIChatRequest,
  targetModel: string,
  assembled: AssembledPrompt
): OpenAIChatRequest {
  const messages = assembledToOpenAIChatMessages(assembled);
  return buildOpenAICompatRequest({ ...req, messages }, targetModel);
}

function hasDirectOpenAIUpstream(env: Env): boolean {
  return Boolean(env.UPSTREAM_BASE_URL && env.UPSTREAM_API_KEY);
}

function isProviderPrefixedModel(model: string): boolean {
  return /^[a-z0-9_.-]+\//i.test(model.trim());
}

function shouldUseDirectOpenAIUpstream(env: Env, model?: string): boolean {
  if (!hasDirectOpenAIUpstream(env)) return false;
  if (!model) return true;
  return !isProviderPrefixedModel(model);
}

function normalizeOpenAICompatBaseUrl(env: Env): string {
  const base = env.UPSTREAM_BASE_URL;
  if (!base) {
    throw new Error("Missing UPSTREAM_BASE_URL");
  }

  return base
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/embeddings$/i, "");
}

function isDirectDeepSeekUpstream(env: Env): boolean {
  if (!hasDirectOpenAIUpstream(env)) return false;
  try {
    return new URL(normalizeOpenAICompatBaseUrl(env)).hostname.toLowerCase().includes("deepseek");
  } catch {
    return normalizeOpenAICompatBaseUrl(env).toLowerCase().includes("deepseek");
  }
}

export function normalizeOpenAICompatModel(env: Env, model: string): string {
  if (isDirectDeepSeekUpstream(env) && model.startsWith("deepseek/")) {
    return model.slice("deepseek/".length);
  }
  return model;
}

function normalizeOpenAICompatChatBody(env: Env, body: OpenAIChatRequest, useDirect: boolean): OpenAIChatRequest {
  return {
    ...body,
    model: useDirect ? normalizeOpenAICompatModel(env, body.model) : body.model
  };
}

export function getOpenAICompatUrl(env: Env, model?: string): string {
  if (shouldUseDirectOpenAIUpstream(env, model)) {
    return `${normalizeOpenAICompatBaseUrl(env)}/chat/completions`;
  }
  return getAiGatewayOpenAICompatUrl(env);
}

export function normalizeAiGatewayBaseUrl(env: Env): string {
  const base = env.AI_GATEWAY_BASE_URL;
  if (!base) {
    throw new Error("Missing AI_GATEWAY_BASE_URL");
  }

  return base
    .replace(/\/+$/, "")
    .replace(/\/compat$/i, "")
    .replace(/\/compat\/chat\/completions$/i, "")
    .replace(/\/compat\/embeddings$/i, "")
    .replace(/\/anthropic\/v1\/messages$/i, "");
}

export function getAiGatewayOpenAICompatUrl(env: Env): string {
  return `${normalizeAiGatewayBaseUrl(env)}/compat/chat/completions`;
}

export function buildAiGatewayOpenAICompatHeaders(env: Env): Headers {
  const headers = new Headers({
    "content-type": "application/json"
  });

  if (env.CF_AIG_TOKEN) {
    headers.set("cf-aig-authorization", `Bearer ${env.CF_AIG_TOKEN}`);
  }

  return headers;
}

export function buildOpenAICompatHeaders(env: Env, useDirect = hasDirectOpenAIUpstream(env)): Headers {
  const headers = new Headers({
    "content-type": "application/json"
  });

  if (useDirect) {
    headers.set("authorization", `Bearer ${env.UPSTREAM_API_KEY}`);
    return headers;
  }

  if (env.CF_AIG_TOKEN) {
    headers.set("cf-aig-authorization", `Bearer ${env.CF_AIG_TOKEN}`);
  }

  return headers;
}

export async function callOpenAICompat(env: Env, body: OpenAIChatRequest): Promise<Response> {
  const useDirect = shouldUseDirectOpenAIUpstream(env, body.model);
  return fetch(getOpenAICompatUrl(env, body.model), {
    method: "POST",
    headers: buildOpenAICompatHeaders(env, useDirect),
    body: JSON.stringify(normalizeOpenAICompatChatBody(env, body, useDirect))
  });
}

export async function callOpenAICompatViaAiGateway(env: Env, body: OpenAIChatRequest): Promise<Response> {
  return fetch(getAiGatewayOpenAICompatUrl(env), {
    method: "POST",
    headers: buildAiGatewayOpenAICompatHeaders(env),
    body: JSON.stringify(body)
  });
}

export async function callOpenAICompatEmbeddings(
  env: Env,
  body: { model: string; input: string | string[] }
): Promise<Response> {
  const useDirect = shouldUseDirectOpenAIUpstream(env, body.model);
  const url = useDirect
    ? `${normalizeOpenAICompatBaseUrl(env)}/embeddings`
    : `${normalizeAiGatewayBaseUrl(env)}/compat/embeddings`;

  return fetch(url, {
    method: "POST",
    headers: buildOpenAICompatHeaders(env, useDirect),
    body: JSON.stringify({ ...body, model: useDirect ? normalizeOpenAICompatModel(env, body.model) : body.model })
  });
}
