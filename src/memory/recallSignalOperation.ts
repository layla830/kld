import { newId } from "../utils/ids";

const REQUEST_ID_HEADERS = ["idempotency-key", "x-request-id", "mcp-session-id", "cf-ray"] as const;

function clean(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 180) : null;
}

export function recallOperationIdForRequest(request: Request, prefix: string): string {
  for (const header of REQUEST_ID_HEADERS) {
    const value = clean(request.headers.get(header));
    if (value) return `${prefix}:${header}:${value}`;
  }
  return newId(prefix);
}

export function recallOperationIdForRpc(requestScope: string, rpcId: string | number | null | undefined): string {
  const id = rpcId === null || rpcId === undefined ? newId("notification") : String(rpcId).slice(0, 120);
  return `${requestScope}:rpc:${id}`;
}
