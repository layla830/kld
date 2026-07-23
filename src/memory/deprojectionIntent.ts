import type { UpdateMemoryInput } from "../db/memories";
import { sha256Hex } from "../utils/hash";

export interface MemoryDeprojectionIntent {
  namespace: string;
  memoryId: string;
  patch: UpdateMemoryInput;
  expectedStatus?: string;
  expectedRevision?: number;
  requireUnpinned?: boolean;
  source: string;
  reason: string;
  candidateId?: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, canonicalize(entry)])
  );
}

export async function memoryDeprojectionIntentFingerprint(
  input: MemoryDeprojectionIntent
): Promise<string> {
  return sha256Hex(JSON.stringify(canonicalize({
    namespace: input.namespace,
    memoryId: input.memoryId,
    patch: input.patch,
    expectedStatus: input.expectedStatus ?? null,
    expectedRevision: input.expectedRevision ?? null,
    requireUnpinned: input.requireUnpinned ?? false,
    source: input.source,
    reason: input.reason.trim().slice(0, 500),
    candidateId: input.candidateId ?? null
  })));
}
