import type { Env } from "../../types";
import { constantTimeEqual } from "../../auth/constantTime";

export function unauthorized(): Response {
  return new Response("Authentication required", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="Memory Home"' }
  });
}

export function forbidden(): Response {
  return new Response("Forbidden", { status: 403 });
}

export function adminPassword(env: Env): string | null {
  return env.ADMIN_PASSWORD || null;
}

export function isAuthorized(request: Request, env: Env): boolean {
  const expected = adminPassword(env);
  if (!expected) return false;
  const header = request.headers.get("authorization") || "";
  if (!header.toLowerCase().startsWith("basic ")) return false;
  try {
    const decoded = atob(header.slice(6));
    const password = decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : decoded;
    return constantTimeEqual(password, expected);
  } catch {
    return false;
  }
}

export function isSameOriginAdminPost(request: Request): boolean {
  if (request.method !== "POST") return true;

  const expectedOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin) return origin === expectedOrigin;

  const referer = request.headers.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === expectedOrigin;
  } catch {
    return false;
  }
}
