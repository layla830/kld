import { KEY_PROFILES } from "../config/keyProfiles";
import type { AuthResult, Env } from "../types";

interface AuthenticateOptions {
  allowUrlToken?: boolean;
}

function getBearerToken(request: Request, options: AuthenticateOptions = {}): string | null {
  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }

  const apiKey = request.headers.get("x-api-key");
  if (apiKey) return apiKey;

  if (!options.allowUrlToken) return null;
  const token = new URL(request.url).searchParams.get("token");
  return token?.trim() || null;
}

export async function authenticate(
  request: Request,
  env: Env,
  options: AuthenticateOptions = {}
): Promise<AuthResult | { ok: false }> {
  const token = getBearerToken(request, options);
  if (!token) return { ok: false };

  if (env.CHATBOX_API_KEY && token === env.CHATBOX_API_KEY) {
    return { ok: true, profile: KEY_PROFILES.chatbox, keyName: "CHATBOX_API_KEY" };
  }

  if (env.IM_API_KEY && token === env.IM_API_KEY) {
    return { ok: true, profile: KEY_PROFILES.im, keyName: "IM_API_KEY" };
  }

  if (env.DEBUG_API_KEY && token === env.DEBUG_API_KEY) {
    return { ok: true, profile: KEY_PROFILES.debug, keyName: "DEBUG_API_KEY" };
  }

  if (env.MEMORY_MCP_API_KEY && token === env.MEMORY_MCP_API_KEY) {
    return { ok: true, profile: KEY_PROFILES.mcp, keyName: "MEMORY_MCP_API_KEY" };
  }

  if (env.GUIDE_DOG_API_KEY && token === env.GUIDE_DOG_API_KEY) {
    return { ok: true, profile: KEY_PROFILES.guideDog, keyName: "GUIDE_DOG_API_KEY" };
  }

  return { ok: false };
}
