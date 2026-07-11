import { handleHealth } from "./api/health";
import { handleCache } from "./api/cache";
import { handleCacheHealth, handleDreamDryRun, handleZAuditApprove, handleZAuditPending, handleZAuditScan, handleXyzemMaintenance, handleBackfillCoordinates, handleFactGroupProposals, handleTimelineBackfill, handleLegacyRelationBackfill, runScheduledCoordinateBackfill } from "./api/debug";
import { handleChatCompletions } from "./api/chatCompletions";
import { handleGuideDogChatCompletions } from "./api/guideDog";
import { handleAdminBoard } from "./api/adminBoard";
import { handleAdminStartupContext, handleAdminStartupContextLite } from "./api/adminStartup";
import { handleBooks } from "./api/books";
import { handleBooksReaderPage } from "./api/booksReader";
import { handleBooksUpload } from "./api/booksUpload";
import { handleMemories } from "./api/memories";
import { handleMemoryRelations } from "./api/memoryRelations";
import { handleMemoryCandidates } from "./api/memoryCandidates";
import { handleMcp } from "./api/mcp";
import { handleMigration } from "./api/migration";
import { handleModels } from "./api/models";
import { handleRecall } from "./api/recall";
import { runDailyMemoryDigest } from "./memory/dailyDigest";
import { runMemoryRetention } from "./memory/retention";
import { runXyzemNightlyMaintenance } from "./memory/xyzem";
import { runNarrativeTimeline, runTimelineSweep } from "./memory/narrativeTimeline";
import { retryStaleVectorSyncs } from "./memory/state";
import { getCoordinateBackfillControl, recordCoordinateBackfillRun } from "./memory/coordinateBackfillControl";
import { handleQueueMessage } from "./queue/consumer";
import type { Env, QueueMessage } from "./types";
import { openAiError } from "./utils/json";

function getDreamNamespace(env: Env): string {
  const value = env.DREAM_NAMESPACE?.trim();
  return value || "default";
}

function getDreamMaxRuns(env: Env): number {
  const parsed = Number(env.DREAM_MAX_RUNS || 10);
  if (!Number.isFinite(parsed)) return 10;
  return Math.min(Math.max(Math.floor(parsed), 1), 10);
}

function isDreamEnabled(env: Env): boolean {
  const flag = env.ENABLE_DREAM?.trim();
  return flag ? flag !== "false" : false;
}

function isDreamDryRun(env: Env): boolean {
  const flag = env.DREAM_DRY_RUN?.trim();
  return flag ? flag !== "false" : true;
}

async function runDreamBatches(env: Env, namespace: string): Promise<unknown[]> {
  const results: unknown[] = [];
  const maxRuns = getDreamMaxRuns(env);
  for (let i = 0; i < maxRuns; i += 1) {
    const result = await runDailyMemoryDigest(env, namespace);
    results.push(result);
    if (!result.ran || !result.stats?.hasMore) break;
  }
  return results;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return handleHealth(env);
    }

    if (
      [
        "/admin/memories",
        "/admin/memories/create",
        "/admin/memories/edit",
        "/admin/memories/delete",
        "/admin/memories/review/approve",
        "/admin/memories/review/reject",
        "/admin/memories/candidates/approve",
        "/admin/memories/candidates/reject",
        "/admin/memories/candidates/batch-facts",
        "/admin/memories/x-timeline/scan",
        "/admin/memories/x-timeline/approve",
        "/admin/memories/x-timeline/reject",
        "/admin/memories/m-review/scan",
        "/admin/memories/m-review/approve",
        "/admin/memories/m-review/reject",
        "/admin/memories/m-review/batch",
        "/admin/memories/m-review/rollback"
      ].includes(url.pathname)
    ) {
      return handleAdminBoard(request, env, ctx);
    }

    if (url.pathname === "/admin/startup-context") {
      return handleAdminStartupContext(request, env);
    }

    if (url.pathname === "/admin/startup-context-lite") {
      return handleAdminStartupContextLite(request, env);
    }

    if (url.pathname === "/books") {
      return handleBooksReaderPage(request, env);
    }

    if (url.pathname === "/books/upload" || url.pathname === "/books/api/upload") {
      return handleBooksUpload(request, env);
    }

    if (url.pathname.startsWith("/books/api/") || url.pathname === "/admin/books/import") {
      return handleBooks(request, env);
    }

    if (request.method === "GET" && url.pathname === "/v1/models") {
      return handleModels(request, env);
    }

    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      if (env.ENABLE_CHAT_GATEWAY !== "true") {
        return openAiError("Chat gateway is disabled", 404);
      }

      return handleChatCompletions(request, env, ctx);
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/v1/guide-dog/chat/completions" || url.pathname === "/guide-dog/v1/chat/completions")
    ) {
      return handleGuideDogChatCompletions(request, env);
    }

    if (url.pathname === "/mcp" || url.pathname === "/memory-mcp") {
      return handleMcp(request, env, ctx);
    }

    if (url.pathname === "/v1/migration/memories") {
      return handleMigration(request, env, ctx);
    }

    if (request.method === "POST" && url.pathname === "/v1/memories/recall") {
      return handleRecall(request, env);
    }

    if (url.pathname === "/v1/memory-relations") {
      return handleMemoryRelations(request, env);
    }

    if (url.pathname === "/v1/memory-candidates") {
      return handleMemoryCandidates(request, env);
    }

    if (url.pathname.startsWith("/v1/memories")) {
      return handleMemories(request, env, ctx);
    }

    if (url.pathname.startsWith("/v1/cache/")) {
      return handleCache(request, env);
    }

    if (request.method === "GET" && url.pathname === "/v1/debug/cache_health") {
      return handleCacheHealth(request, env);
    }

    if (request.method === "POST" && url.pathname === "/v1/debug/dream_dry_run") {
      return handleDreamDryRun(request, env);
    }

    if (request.method === "POST" && url.pathname === "/v1/debug/z_audit_scan") {
      return handleZAuditScan(request, env);
    }

    if (request.method === "POST" && url.pathname === "/v1/debug/z_pending") {
      return handleZAuditPending(request, env);
    }

    if (request.method === "POST" && url.pathname === "/v1/debug/z_approve") {
      return handleZAuditApprove(request, env);
    }

    if (request.method === "POST" && url.pathname === "/v1/debug/xyzem_maintenance") {
      return handleXyzemMaintenance(request, env);
    }

    if (request.method === "POST" && url.pathname === "/v1/debug/backfill_coordinates") {
      return handleBackfillCoordinates(request, env);
    }

    if (request.method === "POST" && url.pathname === "/v1/debug/z_fact_groups") {
      return handleFactGroupProposals(request, env);
    }

    if (request.method === "POST" && url.pathname === "/v1/debug/x_timeline_backfill") {
      return handleTimelineBackfill(request, env);
    }

    if (request.method === "POST" && url.pathname === "/v1/debug/legacy_relation_backfill") {
      return handleLegacyRelationBackfill(request, env);
    }

    return openAiError("Not found", 404);
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await handleQueueMessage(message.body, env);
        message.ack();
      } catch (error) {
        console.error("queue message failed", error);
        message.retry();
      }
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const namespace = getDreamNamespace(env);
    if (controller.cron === "*/5 * * * *") {
      if (env.COORDINATE_BACKFILL_ENABLED !== "true") return;
      ctx.waitUntil(
        getCoordinateBackfillControl(env, namespace)
          .then(async (control) => {
            if (!control.enabled) return { skipped: "paused" as const };
            const result = await runScheduledCoordinateBackfill(env, namespace);
            await recordCoordinateBackfillRun(env, namespace, result);
            return result;
          })
          .then((result) => console.log("scheduled coordinate backfill", { namespace, result }))
          .catch((error) => {
            console.error("scheduled coordinate backfill failed", { namespace, error: error instanceof Error ? error.message : String(error) });
            throw error;
          })
      );
      return;
    }
    ctx.waitUntil(
      Promise.all([
        runDreamBatches(env, namespace).then(async (digest) => ({
          digest,
          xyzem: isDreamEnabled(env)
            ? await runXyzemNightlyMaintenance(env, namespace, { dryRun: isDreamDryRun(env) })
            : { skipped: "dream_disabled" as const },
          narrative: isDreamEnabled(env)
            ? await runNarrativeTimeline(env, namespace)
            : { skipped: "dream_disabled" as const },
          timelineSweep: isDreamEnabled(env)
            ? await runTimelineSweep(env, namespace, { threads: env.TIMELINE_THREADS?.split(",").map((t) => t.trim()).filter(Boolean) ?? [] })
            : { skipped: "dream_disabled" as const }
        })),
        runMemoryRetention(env, namespace),
        retryStaleVectorSyncs(env, namespace, 50)
      ]).then(([dream, retention, syncRetry]) => {
        console.log("scheduled daily memory maintenance", { namespace, dream, retention, syncRetry });
      })
    );
  }
};
