import {
  createMemory,
  getMemoryById,
  updateMemory,
  type CreateMemoryInput,
  type UpdateMemoryInput,
} from "../db/memories";
import { deleteMemoryEmbedding, upsertMemoryEmbedding } from "./embedding";
import {
  applyMemoryEligibilityPatch,
  classifyMemoryEligibilityTransition,
  deprojectMemoryFromFiveAxes,
  type MemoryDeprojectionSource,
  type MemoryEligibilityTransition,
} from "./deprojection";
import type { Env, MemoryRecord } from "../types";

export type VectorSyncStatus = "synced" | "failed" | "pending" | "deleted";

export interface MemoryLifecycleMutationOptions {
  source: MemoryDeprojectionSource;
  reason: string;
  expectedStatus?: string;
  expectedRevision?: number;
  requireUnpinned?: boolean;
  operationId?: string;
}

export interface MemoryLifecycleMutationResult {
  transition: MemoryEligibilityTransition;
  memory: MemoryRecord;
}

async function syncVector(env: Env, memory: MemoryRecord): Promise<VectorSyncStatus> {
  if (memory.status !== "active") return "deleted";
  try {
    const ok = await upsertMemoryEmbedding(env, memory);
    return ok ? "synced" : "failed";
  } catch (error) {
    console.error("syncVector failed", { id: memory.id, error: error instanceof Error ? error.message : String(error) });
    return "failed";
  }
}

async function removeVector(env: Env, memory: MemoryRecord): Promise<VectorSyncStatus> {
  try {
    await deleteMemoryEmbedding(env, memory);
    return "deleted";
  } catch (error) {
    console.error("removeVector failed", { id: memory.id, error: error instanceof Error ? error.message : String(error) });
    return "failed";
  }
}

async function updateSyncStatus(
  env: Env,
  namespace: string,
  id: string,
  status: VectorSyncStatus
): Promise<void> {
  try {
    await env.DB.prepare(
      "UPDATE memories SET vector_sync_status = ?, vector_synced = ?, updated_at = ? WHERE namespace = ? AND id = ?"
    ).bind(status, status === "synced" ? 1 : 0, new Date().toISOString(), namespace, id).run();
  } catch (error) {
    console.error("updateSyncStatus failed", { id, status, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function createSyncedMemory(
  env: Env,
  input: CreateMemoryInput
): Promise<MemoryRecord> {
  const record = await createMemory(env.DB, input);
  const syncStatus = await syncVector(env, record);
  await updateSyncStatus(env, record.namespace, record.id, syncStatus);
  return (await getMemoryById(env.DB, { namespace: record.namespace, id: record.id })) ?? record;
}

export async function mutateMemoryLifecycle(
  env: Env,
  namespace: string,
  id: string,
  patch: UpdateMemoryInput,
  options: MemoryLifecycleMutationOptions
): Promise<MemoryLifecycleMutationResult | null> {
  const existing = await getMemoryById(env.DB, { namespace, id });
  if (!existing) return null;
  if (options.expectedStatus && existing.status !== options.expectedStatus) return null;
  if (options.expectedRevision !== undefined
    && (existing.five_axis_revision ?? 1) !== options.expectedRevision) return null;
  if (options.requireUnpinned && existing.pinned) return null;

  const transition = classifyMemoryEligibilityTransition(
    existing,
    applyMemoryEligibilityPatch(existing, patch)
  );
  if (transition === "eligible_to_ineligible") {
    const result = await deprojectMemoryFromFiveAxes(env, {
      namespace,
      memoryId: id,
      patch,
      expectedStatus: options.expectedStatus ?? existing.status,
      expectedRevision: options.expectedRevision ?? existing.five_axis_revision ?? 1,
      requireUnpinned: options.requireUnpinned,
      source: options.source,
      reason: options.reason,
      operationId: options.operationId
    });
    return { transition, memory: result.memory };
  }

  const updated = await updateMemory(env.DB, {
    namespace,
    id,
    patch,
    expectedStatus: options.expectedStatus ?? existing.status,
    expectedRevision: options.expectedRevision ?? existing.five_axis_revision ?? 1,
    requireUnpinned: options.requireUnpinned
  });
  return updated ? { transition, memory: updated } : null;
}

export async function patchSyncedMemory(
  env: Env,
  namespace: string,
  id: string,
  patch: UpdateMemoryInput,
  options: MemoryLifecycleMutationOptions = {
    source: "system",
    reason: "patch_synced_memory"
  }
): Promise<MemoryRecord | null> {
  const mutation = await mutateMemoryLifecycle(env, namespace, id, patch, options);
  if (!mutation) return null;
  const updated = mutation.memory;

  if (updated.status === "active") {
    const syncStatus = await syncVector(env, updated);
    await updateSyncStatus(env, namespace, id, syncStatus);
  } else {
    const syncStatus = await removeVector(env, updated);
    await updateSyncStatus(env, namespace, id, syncStatus);
  }

  return getMemoryById(env.DB, { namespace, id });
}

export async function deleteSyncedMemory(
  env: Env,
  namespace: string,
  id: string,
  options: Omit<MemoryLifecycleMutationOptions, "requireUnpinned"> = {
    source: "system",
    reason: "delete_synced_memory"
  }
): Promise<MemoryRecord | null> {
  const existing = await getMemoryById(env.DB, { namespace, id });
  if (!existing) return null;
  if (existing.pinned) return existing;

  const mutation = await mutateMemoryLifecycle(env, namespace, id, { status: "deleted" }, {
    ...options,
    expectedStatus: options.expectedStatus ?? existing.status,
    expectedRevision: options.expectedRevision ?? existing.five_axis_revision ?? 1,
    requireUnpinned: true
  });
  if (!mutation) return null;
  const deleted = mutation.memory;

  const syncStatus = await removeVector(env, deleted);
  await updateSyncStatus(env, namespace, id, syncStatus);

  return getMemoryById(env.DB, { namespace, id });
}

export async function syncMemoryVector(
  env: Env,
  memory: MemoryRecord
): Promise<VectorSyncStatus> {
  if (memory.status !== "active") {
    const status = await removeVector(env, memory);
    await updateSyncStatus(env, memory.namespace, memory.id, status);
    return status;
  }
  const status = await syncVector(env, memory);
  await updateSyncStatus(env, memory.namespace, memory.id, status);
  return status;
}

export async function removeMemoryVector(
  env: Env,
  memory: MemoryRecord
): Promise<VectorSyncStatus> {
  const status = await removeVector(env, memory);
  await updateSyncStatus(env, memory.namespace, memory.id, status);
  return status;
}

export async function retryStaleVectorSyncs(
  env: Env,
  namespace: string,
  limit = 50
): Promise<{ scanned: number; retried: number; fixed: number }> {
  const rows = await env.DB
    .prepare(
      `SELECT * FROM memories
       WHERE namespace = ?
         AND status = 'active'
         AND type NOT IN ('diary','layla_diary','auto_diary')
         AND (vector_sync_status = 'failed' OR vector_sync_status = 'pending' OR vector_sync_status IS NULL)
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .bind(namespace, Math.min(Math.max(limit, 1), 200))
    .all<MemoryRecord>();

  const memories = rows.results ?? [];
  let fixed = 0;

  for (const memory of memories) {
    const status = await syncVector(env, memory);
    await updateSyncStatus(env, namespace, memory.id, status);
    if (status === "synced") fixed += 1;
  }

  return { scanned: memories.length, retried: memories.length, fixed };
}
