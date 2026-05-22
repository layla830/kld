import type { Env, MessageRecord } from "../types";
import type { ConversationChunk } from "./chunkTypes";

export const DEFAULT_MAX_MESSAGES = 80;
export const MIN_CHUNK_MESSAGES = 10;

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function toMs(timestamp: string | null | undefined): number {
  if (!timestamp) return 0;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : 0;
}

export function messageTime(message: MessageRecord): string {
  return message.created_at;
}

function shanghaiDate(ms: number): Date {
  return new Date((ms || Date.now()) + SHANGHAI_OFFSET_MS);
}

function formatShanghaiDate(ms: number): string {
  const date = shanghaiDate(ms);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function formatShanghaiDateTime(value: string | null | undefined): string {
  const ms = toMs(value);
  if (!ms) return value || "unknown";
  const date = shanghaiDate(ms);
  const day = formatShanghaiDate(ms);
  const h = String(date.getUTCHours()).padStart(2, "0");
  const m = String(date.getUTCMinutes()).padStart(2, "0");
  return `${day} ${h}:${m}`;
}

function periodSlot(ms: number): { key: string; label: string } {
  const date = shanghaiDate(ms);
  const hour = date.getUTCHours();
  const day = formatShanghaiDate(ms);
  if (hour < 6) return { key: `${day}:night`, label: `${day} 凌晨` };
  if (hour < 12) return { key: `${day}:morning`, label: `${day} 上午` };
  if (hour < 18) return { key: `${day}:afternoon`, label: `${day} 下午` };
  return { key: `${day}:evening`, label: `${day} 晚上` };
}

function maxMessages(env: Env): number {
  return Math.max(Number(env.AUTO_CHUNK_MAX_MESSAGES || DEFAULT_MAX_MESSAGES), MIN_CHUNK_MESSAGES);
}

export function splitIntoPeriodChunks(env: Env, messages: MessageRecord[]): ConversationChunk[] {
  if (messages.length === 0) return [];

  const maxChunkMessages = maxMessages(env);
  const ordered = messages.slice().sort((a, b) => {
    const byTime = toMs(messageTime(a)) - toMs(messageTime(b));
    if (byTime !== 0) return byTime;
    return a.id.localeCompare(b.id);
  });

  const chunks: ConversationChunk[] = [];
  let current: MessageRecord[] = [];
  let currentKey = "";
  let currentLabel = "";

  const flush = () => {
    if (current.length === 0) return;
    chunks.push({ messages: current, periodKey: currentKey, periodLabel: currentLabel });
    current = [];
  };

  for (const message of ordered) {
    const slot = periodSlot(toMs(messageTime(message)));
    if (current.length > 0 && (slot.key !== currentKey || current.length >= maxChunkMessages)) {
      flush();
    }
    if (current.length === 0) {
      currentKey = slot.key;
      currentLabel = slot.label;
    }
    current.push(message);
  }
  flush();
  return chunks;
}
