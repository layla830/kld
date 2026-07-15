import { handleHealth } from "./api/health";
import { handleCache } from "./api/cache";
import { handleCacheHealth, handleDreamDryRun, handleZAuditApprove, handleZAuditPending, handleZAuditScan, handleFiveAxisMaintenance, handleBackfillCoordinates, handleFactGroupProposals, handleTimelineBackfill, handleLegacyRelationBackfill } from "./api/debug";
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
import { runFiveAxisNightlyMaintenance } from "./memory/fiveAxis/nightly";
import { runNarrativeTimeline, runTimelineSweep } from "./memory/narrativeTimeline";
import { retryStaleVectorSyncs } from "./memory/state";
import { getCoordinateBackfillControl, recordCoordinateBackfillRun } from "./memory/coordinateBackfillControl";
import { handleQueueMessage } from "./queue/consumer";
import { enqueueMissedDiarySplits, enqueuePendingFiveAxisProjections } from "./queue/producer";
import type { Env, QueueMessage } from "./types";
import { openAiError } from "./utils/json";
import { loadAppConfig, loadGatewayConfig, type DreamConfig } from "./config/runtime";
import { runScheduledCoordinateBackfill } from "./memory/coordinateBackfill";
import { labelCoordinateBatch } from "./adapters/llm/coordinateLabeler";

async function runDreamBatches(env: Env, namespace: string, config: DreamConfig): Promise<unknown[]> {
  const results: unknown[] = [];
  for (let i = 0; i < config.maxRuns; i += 1) {
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
        "/admin/memories/candidates/repair-evidence",
        "/admin/memories/candidates/batch-quality-reject",
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
      if (!loadGatewayConfig(env).enabled) {
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
      return handleRecall(request, env, ctx);
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
      return handleFiveAxisMaintenance(request, env);
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
    const config = loadAppConfig(env);
    const namespace = config.dream.namespace;
    if (controller.cron === "*/5 * * * *") {
      ctx.waitUntil(
        Promise.all([
          config.fiveAxis.coordinateBackfillEnabled
            ? getCoordinateBackfillControl(env, namespace).then(async (control) => {
                if (!control.enabled) return { skipped: "paused" as const };
                const result = await runScheduledCoordinateBackfill(env, namespace, labelCoordinateBatch, control.cursor);
                await recordCoordinateBackfillRun(env, namespace, result, result.cursor ?? null);
                return result;
              })
            : Promise.resolve({ skipped: "disabled" as const }),
          retryStaleVectorSyncs(env, namespace, 12),
          enqueueMissedDiarySplits(env, namespace, 2),
          enqueuePendingFiveAxisProjections(env, 5)
        ])
          .then(([coordinate, vectorSync, diarySplits, fiveAxisProjections]) => console.log("scheduled five-minute maintenance", {
            namespace, coordinate, vectorSync, diarySplits, fiveAxisProjections
          }))
          .catch((error) => {
            console.error("scheduled five-minute maintenance failed", { namespace, error: error instanceof Error ? error.message : String(error) });
            throw error;
          })
      );
      return;
    }
    ctx.waitUntil(
      Promise.all([
        runDreamBatches(env, namespace, config.dream).then(async (digest) => ({
          digest,
          xyzem: config.fiveAxis.enabled
            ? await runFiveAxisNightlyMaintenance(env, namespace, { dryRun: config.fiveAxis.dryRun })
            : { skipped: "five_axis_disabled" as const },
          narrative: config.dream.enabled
            ? await runNarrativeTimeline(env, namespace)
            : { skipped: "dream_disabled" as const },
          timelineSweep: config.dream.enabled
            ? await runTimelineSweep(env, namespace, { threads: config.fiveAxis.timelineThreads })
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
