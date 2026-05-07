import { handleAdminMemories } from "./adminMemories";
import type { Env } from "../types";

export async function handleAdminMemoryHome(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const response = await handleAdminMemories(request, env, ctx);
  if (response.status !== 401) return response;

  const headers = new Headers(response.headers);
  headers.set("www-authenticate", 'Basic realm="Memory Home"');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
