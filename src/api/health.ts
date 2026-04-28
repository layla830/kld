import { json } from "../utils/json";

export function handleHealth(): Response {
  return json({
    ok: true,
    service: "companion-memory-proxy"
  });
}
