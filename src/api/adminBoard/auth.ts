import type { Env } from "../../types";

export function unauthorized(): Response {
  return new Response("Authentication required", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="Memory Home"' }
  });
}

export function adminPassword(env: Env): string | null {
  return env.ADMIN_PASSWORD || env.MEMORY_MCP_API_KEY || null;
}

export function isAuthorized(request: Request, env: Env): boolean {
  const expected = adminPassword(env);
  if (!expected) return false;
  const header = request.headers.get("authorization") || "";
  if (!header.toLowerCase().startsWith("basic ")) return false;
  try {
    const decoded = atob(header.slice(6));
    const password = decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : decoded;
    return password === expected;
  } catch {
    return false;
  }
}
