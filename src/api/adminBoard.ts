import { deleteMemoryEmbedding, upsertMemoryEmbedding } from "../memory/embedding";
import type { Env } from "../types";
import { createBoardMemory, deleteBoardMemory, editBoardMemory } from "./adminBoard/actions";
import { isAuthorized, unauthorized } from "./adminBoard/auth";
import { fetchHeatmap, fetchMemories, fetchQuoteCategories, fetchStats, fetchTypes } from "./adminBoard/data";
import { inputFromUrl, noticeUrl, qs, readFormText } from "./adminBoard/utils";
import { renderPage } from "./adminBoard/view";

export async function handleAdminBoard(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!isAuthorized(request, env)) return unauthorized();
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/admin/memories/create") {
    const form = await request.formData();
    const created = await createBoardMemory(env, form);
    const kind = readFormText(form, "kind");
    const tab = kind === "diary" ? "diary" : kind === "quote" ? "quote" : kind === "memory" ? "browse" : "message";
    if (created) ctx.waitUntil(upsertMemoryEmbedding(env, created));
    return Response.redirect(`${url.origin}/admin/memories${qs(inputFromUrl(new URL(`${url.origin}/admin/memories?tab=${tab}`)), { tab, notice: created ? "created" : "empty" })}`, 303);
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/edit") {
    const ref = request.headers.get("referer") || `${url.origin}/admin/memories`;
    try {
      const updated = await editBoardMemory(env, await request.formData());
      if (updated) ctx.waitUntil(upsertMemoryEmbedding(env, updated));
      return Response.redirect(`${url.origin}${noticeUrl(ref, updated ? "edited" : "empty")}`, 303);
    } catch (error) {
      console.error("admin memory edit failed", error);
      return Response.redirect(`${url.origin}${noticeUrl(ref, "error")}`, 303);
    }
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/delete") {
    const ref = request.headers.get("referer") || `${url.origin}/admin/memories`;
    const deleted = await deleteBoardMemory(env, await request.formData());
    if (deleted) ctx.waitUntil(deleteMemoryEmbedding(env, deleted));
    return Response.redirect(`${url.origin}${noticeUrl(ref, "deleted")}`, 303);
  }

  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const input = inputFromUrl(url);
  const needsDashboard = input.tab === "browse";
  const [types, quoteCategories, memories, stats, heatmap] = await Promise.all([
    fetchTypes(env),
    input.tab === "quote" ? fetchQuoteCategories(env) : Promise.resolve([]),
    fetchMemories(env, input),
    needsDashboard ? fetchStats(env) : Promise.resolve({ active: 0, deleted: 0, total: 0, vectorized: 0 }),
    needsDashboard ? fetchHeatmap(env) : Promise.resolve([])
  ]);

  return new Response(renderPage(input, { stats, types, quoteCategories, total: memories.total, records: memories.records, heatmap }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
  });
}
