import type { Env } from "../types";
import { enqueueDiarySplitIfNeeded, enqueueMemoryVectorSync } from "../queue/producer";
import { approveDreamReview, createBoardMemory, deleteBoardMemory, editBoardMemory, rejectDreamReview } from "./adminBoard/actions";
import { forbidden, isAuthorized, isSameOriginAdminPost, unauthorized } from "./adminBoard/auth";
import { fetchHeatmap, fetchLmc5Dashboard, fetchMemories, fetchQuoteCategories, fetchStats, fetchTimelineDates, fetchTypes } from "./adminBoard/data";
import { fetchDreamReviewMemories } from "./adminBoard/reviewData";
import { inputFromUrl, noticeUrl, PAGE_SIZE, qs, readFormText } from "./adminBoard/utils";
import { renderPage } from "./adminBoard/view";
import { countMemoryCandidatesByAction, countPendingOperationalReviewCandidates, listMemoryCandidates, listMemoryCandidatesByAction, listOperationalReviewCandidates, listRecentApprovedOperationalReviewCandidates } from "../db/memoryCandidates";
import { approveCandidate, batchRejectLowQualityCandidates, batchReviewDiaryFactCandidates, rejectCandidate, repairCandidateEvidence } from "./adminBoard/candidateActions";
import { getCoordinateBackfillStatus, setCoordinateBackfillEnabled } from "../memory/coordinateBackfillControl";
import { approveTimelineCandidate, rejectTimelineCandidate, timelineCandidateNotice } from "./adminBoard/timelineActions";
import { getTimelineBackfillStatus, scanTimelineBackfillPage } from "../memory/timelineBackfill";
import { scanOperationalReviewCandidates } from "../memory/operationalReview";
import { batchReviewMetabolismCandidates } from "./adminBoard/metabolismActions";
import { approveOperationalReviewCandidate, rejectOperationalReviewCandidate, rollbackOperationalReviewCandidate } from "./adminBoard/operationalReviewActions";
import type { MemoryCandidateRecord } from "../db/memoryCandidates";
import { loadDreamConfig } from "../config/runtime";
import { retryFiveAxisDeadLetter } from "../db/memoryFiveAxisOutbox";

export async function handleAdminBoard(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!isAuthorized(request, env)) return unauthorized();
  if (!isSameOriginAdminPost(request)) return forbidden();
  const url = new URL(request.url);
  const namespace = loadDreamConfig(env).namespace;
  const scheduleVectorSync = (...memories: Parameters<typeof enqueueMemoryVectorSync>[1]) => {
    if (memories.length > 0) ctx.waitUntil(enqueueMemoryVectorSync(env, memories));
  };

  if (request.method === "POST" && url.pathname === "/admin/memories/create") {
    const form = await request.formData();
    const created = await createBoardMemory(env, form);
    const kind = readFormText(form, "kind");
    const tab = kind === "diary" ? "diary" : kind === "quote" ? "quote" : kind === "memory" ? "browse" : "message";
    if (created) {
      scheduleVectorSync(created);
      ctx.waitUntil(enqueueDiarySplitIfNeeded(env, created));
    }
    return Response.redirect(`${url.origin}/admin/memories${qs(inputFromUrl(new URL(`${url.origin}/admin/memories?tab=${tab}`)), { tab, notice: created ? "created" : "empty" })}`, 303);
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/edit") {
    const ref = request.headers.get("referer") || `${url.origin}/admin/memories`;
    try {
      const updated = await editBoardMemory(env, await request.formData());
      if (updated) scheduleVectorSync(updated);
      return Response.redirect(`${url.origin}${noticeUrl(ref, updated ? "edited" : "empty")}`, 303);
    } catch (error) {
      console.error("admin memory edit failed", error);
      return Response.redirect(`${url.origin}${noticeUrl(ref, "error")}`, 303);
    }
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/delete") {
    const ref = request.headers.get("referer") || `${url.origin}/admin/memories`;
    const deleted = await deleteBoardMemory(env, await request.formData());
    if (deleted) scheduleVectorSync(deleted);
    return Response.redirect(`${url.origin}${noticeUrl(ref, "deleted")}`, 303);
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/review/approve") {
    const ref = request.headers.get("referer") || `${url.origin}/admin/memories?tab=review`;
    try {
      const result = await approveDreamReview(env, await request.formData());
      if (result?.target) scheduleVectorSync(result.target);
      if (result?.previousTarget) scheduleVectorSync(result.previousTarget);
      if (result?.proposal) scheduleVectorSync(result.proposal);
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
      if (result?.proposal) scheduleVectorSync(result.proposal);
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
      if (target) scheduleVectorSync(target);
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
    await setCoordinateBackfillEnabled(env, namespace, enabled);
    return Response.redirect(`${url.origin}/admin/memories?tab=lmc5&notice=${enabled ? "backfill-resumed" : "backfill-paused"}`, 303);
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/x-timeline/scan") {
    try {
      const form = await request.formData();
      const result = await scanTimelineBackfillPage(env, namespace, readFormText(form, "reset") === "true");
      return Response.redirect(`${url.origin}/admin/memories?tab=x-review&notice=${result.complete ? "x-complete" : "x-scanned"}`, 303);
    } catch (error) {
      console.error("admin timeline scan failed", error);
      return Response.redirect(`${url.origin}/admin/memories?tab=x-review&notice=error`, 303);
    }
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/x-timeline/approve") {
    const ref = request.headers.get("referer") || `${url.origin}/admin/memories?tab=x-review`;
    try {
      const updated = await approveTimelineCandidate(env, await request.formData());
      if (updated) scheduleVectorSync(updated);
      return Response.redirect(`${url.origin}${noticeUrl(ref, updated ? "x-approved" : "empty")}`, 303);
    } catch (error) {
      console.error("admin timeline approve failed", error);
      return Response.redirect(`${url.origin}${noticeUrl(ref, timelineCandidateNotice(error))}`, 303);
    }
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/x-timeline/reject") {
    const ref = request.headers.get("referer") || `${url.origin}/admin/memories?tab=x-review`;
    try {
      const rejected = await rejectTimelineCandidate(env, await request.formData());
      return Response.redirect(`${url.origin}${noticeUrl(ref, rejected ? "x-rejected" : "empty")}`, 303);
    } catch (error) {
      console.error("admin timeline reject failed", error);
      return Response.redirect(`${url.origin}${noticeUrl(ref, "error")}`, 303);
    }
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/lmc5/retry-dead-letter") {
    const form = await request.formData();
    const id = Number(readFormText(form, "id"));
    const retried = Number.isSafeInteger(id) && id > 0
      ? await retryFiveAxisDeadLetter(env.DB, namespace, id)
      : false;
    return Response.redirect(`${url.origin}/admin/memories?tab=lmc5&notice=${retried ? "five-axis-retried" : "empty"}`, 303);
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/candidates/repair-evidence") {
    const ref = request.headers.get("referer") || `${url.origin}/admin/memories?tab=review`;
    try {
      const result = await repairCandidateEvidence(env, await request.formData());
      return Response.redirect(`${url.origin}${noticeUrl(ref, `evidence-${result}`)}`, 303);
    } catch (error) {
      console.error("admin candidate evidence repair failed", error);
      return Response.redirect(`${url.origin}${noticeUrl(ref, "error")}`, 303);
    }
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/candidates/batch-quality-reject") {
    const ref = request.headers.get("referer") || `${url.origin}/admin/memories?tab=review`;
    try {
      const result = await batchRejectLowQualityCandidates(env, await request.formData());
      const notice = !result || result.processed === 0 ? "empty" : result.skipped > 0 ? "quality-batch-partial" : "quality-batch-rejected";
      return Response.redirect(`${url.origin}${noticeUrl(ref, notice)}`, 303);
    } catch (error) {
      console.error("admin candidate quality batch reject failed", error);
      return Response.redirect(`${url.origin}${noticeUrl(ref, "error")}`, 303);
    }
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/candidates/batch-facts") {
    const ref = request.headers.get("referer") || `${url.origin}/admin/memories?tab=review`;
    try {
      const result = await batchReviewDiaryFactCandidates(env, await request.formData());
      if (result?.targets.length) {
        scheduleVectorSync(...result.targets);
      }
      const notice = !result || result.processed === 0
        ? "empty"
        : result.decision === "approve" ? "approved" : "rejected";
      return Response.redirect(`${url.origin}${noticeUrl(ref, notice)}`, 303);
    } catch (error) {
      console.error("admin diary fact batch review failed", error);
      return Response.redirect(`${url.origin}${noticeUrl(ref, "error")}`, 303);
    }
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/m-review/scan") {
    try {
      await scanOperationalReviewCandidates(env, namespace);
      return Response.redirect(`${url.origin}/admin/memories?tab=m-review&notice=m-scanned`, 303);
    } catch (error) {
      console.error("admin metabolism scan failed", error);
      return Response.redirect(`${url.origin}/admin/memories?tab=m-review&notice=error`, 303);
    }
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/m-review/approve") {
    const ref = request.headers.get("referer") || `${url.origin}/admin/memories?tab=m-review`;
    try {
      const result = await approveOperationalReviewCandidate(env, await request.formData());
      if (result?.memories.length) scheduleVectorSync(...result.memories);
      return Response.redirect(`${url.origin}${noticeUrl(ref, result ? "approved" : "empty")}`, 303);
    } catch (error) {
      console.error("admin metabolism approve failed", error);
      const notice = error instanceof Error && error.message === "relation_review_candidate_is_stale"
        ? "y-relation-stale"
        : "error";
      return Response.redirect(`${url.origin}${noticeUrl(ref, notice)}`, 303);
    }
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/m-review/reject") {
    const ref = request.headers.get("referer") || `${url.origin}/admin/memories?tab=m-review`;
    try {
      const rejected = await rejectOperationalReviewCandidate(env, await request.formData());
      return Response.redirect(`${url.origin}${noticeUrl(ref, rejected ? "rejected" : "empty")}`, 303);
    } catch (error) {
      console.error("admin metabolism reject failed", error);
      return Response.redirect(`${url.origin}${noticeUrl(ref, "error")}`, 303);
    }
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/m-review/batch") {
    const ref = request.headers.get("referer") || `${url.origin}/admin/memories?tab=m-review`;
    try {
      const result = await batchReviewMetabolismCandidates(env, await request.formData());
      const notice = !result || result.processed === 0
        ? "empty"
        : result.skipped > 0
          ? "m-batch-partial"
          : result.decision === "approve" ? "m-batch-approved" : "m-batch-rejected";
      return Response.redirect(`${url.origin}${noticeUrl(ref, notice)}`, 303);
    } catch (error) {
      console.error("admin metabolism batch review failed", error);
      return Response.redirect(`${url.origin}${noticeUrl(ref, "error")}`, 303);
    }
  }

  if (request.method === "POST" && url.pathname === "/admin/memories/m-review/rollback") {
    const ref = request.headers.get("referer") || `${url.origin}/admin/memories?tab=m-review`;
    try {
      const result = await rollbackOperationalReviewCandidate(env, await request.formData());
      if (result?.memories.length) scheduleVectorSync(...result.memories);
      return Response.redirect(`${url.origin}${noticeUrl(ref, result ? "m-rolled-back" : "empty")}`, 303);
    } catch (error) {
      console.error("admin metabolism rollback failed", error);
      return Response.redirect(`${url.origin}${noticeUrl(ref, "error")}`, 303);
    }
  }

  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const input = inputFromUrl(url);
  const needsDashboard = input.tab === "browse";
  const [types, quoteCategories, memories, stats, heatmap, timelineDates, lmc5] = await Promise.all([
    fetchTypes(env),
    input.tab === "quote" ? fetchQuoteCategories(env) : Promise.resolve([]),
    input.tab === "lmc5" || input.tab === "x-review" || input.tab === "m-review" ? Promise.resolve({ total: 0, records: [] }) : input.tab === "review" ? fetchDreamReviewMemories(env, input) : fetchMemories(env, input),
    needsDashboard ? fetchStats(env) : Promise.resolve({ active: 0, deleted: 0, total: 0, vectorized: 0 }),
    needsDashboard ? fetchHeatmap(env) : Promise.resolve([]),
    input.tab === "timeline" ? fetchTimelineDates(env) : Promise.resolve(new Set<string>()),
    input.tab === "lmc5" ? fetchLmc5Dashboard(env) : Promise.resolve(null)
  ]);

  let candidateTotal = 0;
  let operationalPending = 0;
  let resolvedCandidates: MemoryCandidateRecord[] = [];
  let candidates = input.tab === "review" ? await listMemoryCandidates(env.DB, namespace, 100) : [];
  if (input.tab === "x-review") {
    [candidateTotal, candidates] = await Promise.all([
      countMemoryCandidatesByAction(env.DB, namespace, "timeline_date"),
      listMemoryCandidatesByAction(env.DB, namespace, "timeline_date", PAGE_SIZE, (input.page - 1) * PAGE_SIZE)
    ]);
  }
  if (input.tab === "m-review") {
    [operationalPending, candidates, resolvedCandidates] = await Promise.all([
      countPendingOperationalReviewCandidates(env.DB, namespace),
      listOperationalReviewCandidates(env.DB, namespace, 30),
      listRecentApprovedOperationalReviewCandidates(env.DB, namespace, 12)
    ]);
    candidateTotal = candidates.length;
  }
  const coordinateBackfill = input.tab === "lmc5" ? await getCoordinateBackfillStatus(env, namespace) : null;
  const timelineBackfill = input.tab === "x-review" ? await getTimelineBackfillStatus(env, namespace) : null;
  return new Response(renderPage(input, { stats, types, quoteCategories, total: input.tab === "x-review" || input.tab === "m-review" ? candidateTotal : memories.total, records: memories.records, candidates, resolvedCandidates, heatmap, timelineDates, lmc5, coordinateBackfill, timelineBackfill, operationalPending }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
  });
}
