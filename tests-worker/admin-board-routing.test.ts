import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { ADMIN_BOARD_POST_ROUTES, ADMIN_BOARD_ROUTES } from "../src/api/adminBoard/routes";
import { getCoordinateBackfillControl } from "../src/memory/coordinateBackfillControl";
import type { Env } from "../src/types";

const origin = "https://admin-routing.test";
const password = "admin-routing-password";
const authorization = `Basic ${btoa(`admin:${password}`)}`;
const runtimeEnv = {
  DB: env.DB,
  ADMIN_PASSWORD: password,
  DREAM_NAMESPACE: "default",
  ENABLE_FIVE_AXIS: "true"
} as Env;

function adminRequest(path: string, method = "POST", fields: Record<string, string> = {}): Request {
  const body = new URLSearchParams(fields);
  if (path === ADMIN_BOARD_ROUTES.toggleCoordinateBackfill.path && !body.has("enabled")) body.set("enabled", "false");
  return new Request(`${origin}${path}`, {
    method,
    headers: {
      authorization,
      origin,
      "content-type": "application/x-www-form-urlencoded"
    },
    ...(method === "POST" ? { body } : {})
  });
}

describe("admin board route contract", () => {
  it("declares every route exactly once", () => {
    const routes = Object.values(ADMIN_BOARD_ROUTES).map((route) => `${route.method} ${route.path}`);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it.each(ADMIN_BOARD_POST_ROUTES)("dispatches $path through the Worker entrypoint", async (route) => {
    const response = await worker.fetch(adminRequest(route.path), runtimeEnv, createExecutionContext());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain(ADMIN_BOARD_ROUTES.home.path);
  });

  it("keeps unknown admin actions outside the board handler", async () => {
    const response = await worker.fetch(
      adminRequest("/admin/memories/not-a-real-action"),
      runtimeEnv,
      createExecutionContext()
    );
    expect(response.status).toBe(404);
  });

  it("persists coordinate backfill pause and resume through the rendered action route", async () => {
    const pause = await worker.fetch(
      adminRequest(ADMIN_BOARD_ROUTES.toggleCoordinateBackfill.path),
      runtimeEnv,
      createExecutionContext()
    );
    expect(pause.status).toBe(303);
    await expect(getCoordinateBackfillControl(runtimeEnv, "default")).resolves.toMatchObject({ enabled: false });

    const resume = await worker.fetch(
      adminRequest(ADMIN_BOARD_ROUTES.toggleCoordinateBackfill.path, "POST", { enabled: "true" }),
      runtimeEnv,
      createExecutionContext()
    );
    expect(resume.status).toBe(303);
    await expect(getCoordinateBackfillControl(runtimeEnv, "default")).resolves.toMatchObject({ enabled: true });
  });

  it("moves a dead letter back to pending through the admin recovery route", async () => {
    const memoryId = `route-dead-letter-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO memory_five_axis_outbox (
         namespace, memory_id, memory_updated_at, memory_revision, status,
         attempts, last_error, created_at, updated_at
       ) VALUES ('default', ?, ?, 1, 'dead_letter', 5, 'route contract failure', ?, ?)`
    ).bind(memoryId, now, now, now).run();
    const outbox = await env.DB.prepare(
      "SELECT id FROM memory_five_axis_outbox WHERE namespace = 'default' AND memory_id = ?"
    ).bind(memoryId).first<{ id: number }>();

    const response = await worker.fetch(
      adminRequest(ADMIN_BOARD_ROUTES.retryFiveAxisDeadLetter.path, "POST", { id: String(outbox!.id) }),
      runtimeEnv,
      createExecutionContext()
    );
    expect(response.status).toBe(303);
    await expect(env.DB.prepare(
      "SELECT status, attempts, last_error FROM memory_five_axis_outbox WHERE id = ?"
    ).bind(outbox!.id).first()).resolves.toMatchObject({ status: "pending", attempts: 0, last_error: null });
    await expect(env.DB.prepare(
      "SELECT event_type FROM memory_events WHERE namespace = 'default' AND memory_id = ? ORDER BY created_at DESC LIMIT 1"
    ).bind(memoryId).first()).resolves.toMatchObject({ event_type: "five_axis_dead_letter_retried" });
  });
});
