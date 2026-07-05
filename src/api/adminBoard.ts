import { deleteMemoryEmbedding, upsertMemoryEmbedding } from "../memory/embedding";
import type { Env } from "../types";
import { approveDreamReview, createBoardMemory, deleteBoardMemory, editBoardMemory, rejectDreamReview } from "./adminBoard/actions";
import { forbidden, isAuthorized, isSameOriginAdminPost, unauthorized } from "./adminBoard/auth";
import { fetchHeatmap, fetchLmc5Dashboard, fetchMemories, fetchQuoteCategories, fetchStats, fetchTimelineDates, fetchTypes } from "./adminBoard/data";
import { fetchDreamReviewMemories } from "./adminBoard/reviewData";
import { inputFromUrl, noticeUrl, qs, readFormText } from "./adminBoard/utils";
import { renderPage } from "./adminBoard/view";
import { listMemoryCandidates } from "../db/memoryCandidates";
import { approveCandidate, rejectCandidate } from "./adminBoard/candidateActions";
import { getCoordinateBackfillStatus, setCoordinateBackfillEnabled } from "../memory/coordinateBackfillControl";

export async function handleAdminBoard(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!isAuthorized(request, env)) return unauthorized();
  if (!isSameOriginAdminPost(request)) return forbidden();
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

  if (request.method === "POST" && url.pathname === "/admin/memories/review/approve") {
    const ref = request.headers.get("referer") || `${url.origin}/admin/memories?tab=review`;
    try {
      const result = await approveDreamReview(env, await request.formData());
      if (result?.target) {
        ctx.waitUntil(result.action === "delete" ? deleteMemoryEmbedding(env, result.target) : upsertMemoryEmbedding(env, result.target));
      }
      if (result?.proposal) ctx.waitUntil(deleteMemoryEmbedding(env, result.proposal));
      return Response.redirect(`${url.origin}${noticeUrl(ref, result ? "approved" : "empty")}`, 303);
    } catch (error) {
      console.error("admin dream review approve failed", error);
      return Response.redirect(`${url.origin}${noticeUrl(ref, "error")}`, 303);
    }
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/review/reject") {
    const ref = request.headers.get("referer") || `${url.origin}/admin/memories?tab=review`;
    try {
      const result = await rejectDreamReview(env, await request.formData());
      if (result?.proposal) ctx.waitUntil(deleteMemoryEmbedding(env, result.proposal));
      return Response.redirect(`${url.origin}${noticeUrl(ref, result ? "rejected" : "empty")}`, 303);
    } catch (error) {
      console.error("admin dream review reject failed", error);
      return Response.redirect(`${url.origin}${noticeUrl(ref, "error")}`, 303);
    }
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/candidates/approve") {
    const ref = request.headers.get("referer") || `${url.origin}/admin/memories?tab=review`;
    try {
      const target = await approveCandidate(env, await request.formData());
      if (target) ctx.waitUntil(target.status === "deleted" ? deleteMemoryEmbedding(env, target) : upsertMemoryEmbedding(env, target));
      return Response.redirect(`${url.origin}${noticeUrl(ref, target ? "approved" : "empty")}`, 303);
    } catch (error) {
      console.error("admin candidate approve failed", error);
      return Response.redirect(`${url.origin}${noticeUrl(ref, "error")}`, 303);
    }
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/candidates/reject") {
    const ref = request.headers.get("referer") || `${url.origin}/admin/memories?tab=review`;
    try {
      const rejected = await rejectCandidate(env, await request.formData());
      return Response.redirect(`${url.origin}${noticeUrl(ref, rejected ? "rejected" : "empty")}`, 303);
    } catch (error) {
      console.error("admin candidate reject failed", error);
      return Response.redirect(`${url.origin}${noticeUrl(ref, "error")}`, 303);
    }
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/coordinate-backfill/toggle") {
    const form = await request.formData();
    const enabled = readFormText(form, "enabled") === "true";
    await setCoordinateBackfillEnabled(env, "default", enabled);
    return Response.redirect(`${url.origin}/admin/memories?tab=lmc5&notice=${enabled ? "backfill-resumed" : "backfill-paused"}`, 303);
  }

  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const input = inputFromUrl(url);
  const needsDashboard = input.tab === "browse";
  const [types, quoteCategories, memories, stats, heatmap, timelineDates, lmc5] = await Promise.all([
    fetchTypes(env),
    input.tab === "quote" ? fetchQuoteCategories(env) : Promise.resolve([]),
    input.tab === "lmc5" ? Promise.resolve({ total: 0, records: [] }) : input.tab === "review" ? fetchDreamReviewMemories(env, input) : fetchMemories(env, input),
    needsDashboard ? fetchStats(env) : Promise.resolve({ active: 0, deleted: 0, total: 0, vectorized: 0 }),
    needsDashboard ? fetchHeatmap(env) : Promise.resolve([]),
    input.tab === "timeline" ? fetchTimelineDates(env) : Promise.resolve(new Set<string>()),
    input.tab === "lmc5" ? fetchLmc5Dashboard(env) : Promise.resolve(null)
  ]);

  const candidates = input.tab === "review" ? await listMemoryCandidates(env.DB, "default", 100) : [];
  const coordinateBackfill = input.tab === "lmc5" ? await getCoordinateBackfillStatus(env, "default") : null;
  return new Response(renderPage(input, { stats, types, quoteCategories, total: memories.total, records: memories.records, candidates, heatmap, timelineDates, lmc5, coordinateBackfill }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
  });
}
