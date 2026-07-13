import { deleteProcessedSourceMessagesBefore } from "../db/messages";
import type { Env } from "../types";
import { loadRetentionConfig, systemClock, type AppClock } from "../config/runtime";

function daysAgoIso(clock: AppClock, days: number): string {
  return new Date(clock.nowMs() - days * 86_400_000).toISOString();
}

export async function pruneProcessedCcConnectMessages(
  env: Env,
  namespace: string,
  clock: AppClock = systemClock
): Promise<number> {
  const retentionDays = loadRetentionConfig(env).ccConnectProcessedMessagesDays;
  try {
    const deleted = await deleteProcessedSourceMessagesBefore(env.DB, {
      namespace,
      source: "cc-connect",
      before: daysAgoIso(clock, retentionDays)
    });
    if (deleted > 0) {
      console.log("cc-connect processed raw message retention completed", { namespace, deleted, retentionDays });
    }
    return deleted;
  } catch (error) {
    console.error("cc-connect processed raw message retention failed", error);
    return 0;
  }
}
