import { deleteProcessedSourceMessagesBefore } from "../db/messages";
import type { Env } from "../types";

const DEFAULT_CC_CONNECT_RETENTION_DAYS = 7;

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export async function pruneProcessedCcConnectMessages(env: Env, namespace: string): Promise<void> {
  const retentionDays = readPositiveInt(env.CC_CONNECT_MESSAGE_RETENTION_DAYS, DEFAULT_CC_CONNECT_RETENTION_DAYS);
  try {
    const deleted = await deleteProcessedSourceMessagesBefore(env.DB, {
      namespace,
      source: "cc-connect",
      before: daysAgoIso(retentionDays)
    });
    if (deleted > 0) {
      console.log("cc-connect processed raw message retention completed", { namespace, deleted, retentionDays });
    }
  } catch (error) {
    console.error("cc-connect processed raw message retention failed", error);
  }
}
