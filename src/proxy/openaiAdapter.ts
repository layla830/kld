import type { Env, OpenAIChatRequest } from "../types";

export function buildOpenAICompatRequest(req: OpenAIChatRequest, targetModel: string): OpenAIChatRequest {
  return {
    ...req,
    model: targetModel,
    stream: Boolean(req.stream)
  };
}

export function getOpenAICompatUrl(env: Env): string {
  const base = env.AI_GATEWAY_BASE_URL;
  if (!base) {
    throw new Error("Missing AI_GATEWAY_BASE_URL");
  }

  return `${base.replace(/\/$/, "")}/compat/chat/completions`;
}

export function buildOpenAICompatHeaders(env: Env): Headers {
  const headers = new Headers({
    "content-type": "application/json"
  });

  if (env.CF_AIG_TOKEN) {
    headers.set("cf-aig-authorization", `Bearer ${env.CF_AIG_TOKEN}`);
  }

  return headers;
}

export async function callOpenAICompat(env: Env, body: OpenAIChatRequest): Promise<Response> {
  return fetch(getOpenAICompatUrl(env), {
    method: "POST",
    headers: buildOpenAICompatHeaders(env),
    body: JSON.stringify(body)
  });
}

export async function callOpenAICompatEmbeddings(
  env: Env,
  body: { model: string; input: string | string[] }
): Promise<Response> {
  if (!env.AI_GATEWAY_BASE_URL) {
    throw new Error("Missing AI_GATEWAY_BASE_URL");
  }

  return fetch(`${env.AI_GATEWAY_BASE_URL.replace(/\/$/, "")}/compat/embeddings`, {
    method: "POST",
    headers: buildOpenAICompatHeaders(env),
    body: JSON.stringify(body)
  });
}
