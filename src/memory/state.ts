import {
  createMemory,
  getMemoryById,
  listPendingVectorReconciliations,
  markMemoryVectorResult,
  updateMemory,
  type CreateMemoryInput,
  type UpdateMemoryInput,
} from "../db/memories";
import { deleteMemoryEmbedding, upsertMemoryEmbedding } from "./embedding";
import {
  deprojectMemoryFromFiveAxes,
  type MemoryDeprojectionSource,
} from "./deprojection";
import {
  applyMemoryEligibilityPatch,
  classifyMemoryEligibilityTransition,
  isFiveAxisMemoryEligible,
  type MemoryEligibilityTransition,
} from "./fiveAxis/eligibility";
import { isActiveDiarySplitSource } from "./diaryPolicy";
import { clearDiaryTimelineGroupsForOrigin } from "./diaryTimeline";
import type { Env, MemoryRecord } from "../types";

export type VectorDesiredAction = "upsert" | "delete";
export type VectorReconciliationErrorCode =
  | "vector_upsert_failed"
  | "vector_delete_failed"
  | "vector_binding_missing"
  | "vector_id_missing";

export type VectorReconciliationResult =
  | {
      outcome: "synced";
      action: VectorDesiredAction;
      memory: MemoryRecord;
    }
  | {
      outcome: "failed";
      action: VectorDesiredAction;
      memory: MemoryRecord;
      errorCode: VectorReconciliationErrorCode;
    }
  | {
      outcome: "stale";
      attemptedAction: VectorDesiredAction;
      latestMemory: MemoryRecord | null;
    }
  | {
      outcome: "missing";
    };

export interface VectorRetrySummary {
  selected: number;
  synced: number;
  deleted: number;
  failed: number;
  stale: number;
  missing: number;
}

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

async function applyVectorAction(
  env: Env,
  memory: MemoryRecord,
  action: VectorDesiredAction
): Promise<{ ok: true } | { ok: false; errorCode: VectorReconciliationErrorCode }> {
  if (!env.VECTORIZE) return { ok: false, errorCode: "vector_binding_missing" };
  if (!memory.vector_id) return { ok: false, errorCode: "vector_id_missing" };

  try {
    const ok = action === "upsert"
      ? await upsertMemoryEmbedding(env, memory)
      : await deleteMemoryEmbedding(env, memory);
    return ok
      ? { ok: true }
      : {
          ok: false,
          errorCode: action === "upsert" ? "vector_upsert_failed" : "vector_delete_failed"
        };
  } catch (error) {
    console.error("memory vector action failed", {
      namespace: memory.namespace,
      id: memory.id,
      revision: memory.five_axis_revision ?? 1,
      action,
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      ok: false,
      errorCode: action === "upsert" ? "vector_upsert_failed" : "vector_delete_failed"
    };
  }
}

async function syncLifecycleMutation(
  env: Env,
  result: MemoryLifecycleMutationResult
): Promise<MemoryRecord> {
  await reconcileMemoryVector(env, {
    namespace: result.memory.namespace,
    memoryId: result.memory.id
  });
  return (
    await getMemoryById(env.DB, {
      namespace: result.memory.namespace,
      id: result.memory.id
    })
  ) ?? result.memory;
}

export async function createSyncedMemory(
  env: Env,
  input: CreateMemoryInput
): Promise<MemoryRecord> {
  const record = await createMemory(env.DB, input);
  await reconcileMemoryVector(env, {
    namespace: record.namespace,
    memoryId: record.id
  });
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

  const after = applyMemoryEligibilityPatch(existing, patch);
  const transition = classifyMemoryEligibilityTransition(existing, after);
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
    return {
      transition,
      memory: result.memory
    };
  }

  const updated = await updateMemory(env.DB, {
    namespace,
    id,
    patch,
    expectedStatus: options.expectedStatus ?? existing.status,
    expectedRevision: options.expectedRevision ?? existing.five_axis_revision ?? 1,
    requireUnpinned: options.requireUnpinned
  });
  if (!updated) return null;

  if (isActiveDiarySplitSource(existing) && !isActiveDiarySplitSource(updated)) {
    await clearDiaryTimelineGroupsForOrigin(env.DB, {
      namespace,
      originDiaryId: id
    });
  }

  return {
    transition,
    memory: updated
  };
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
  return mutation ? syncLifecycleMutation(env, mutation) : null;
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
  return syncLifecycleMutation(env, mutation);
}

export async function reconcileMemoryVector(
  env: Env,
  input: { namespace: string; memoryId: string }
): Promise<VectorReconciliationResult> {
  const snapshot = await getMemoryById(env.DB, {
    namespace: input.namespace,
    id: input.memoryId
  });
  if (!snapshot) return { outcome: "missing" };

  const expectedRevision = snapshot.five_axis_revision ?? 1;
  const expectedEligibility = isFiveAxisMemoryEligible(snapshot) ? "eligible" : "ineligible";
  const action: VectorDesiredAction = expectedEligibility === "eligible" ? "upsert" : "delete";
  const external = await applyVectorAction(env, snapshot, action);
  const status = external.ok
    ? action === "upsert" ? "synced" : "deleted"
    : "failed";
  const written = await markMemoryVectorResult(env.DB, {
    namespace: snapshot.namespace,
    id: snapshot.id,
    expectedRevision,
    expectedEligibility,
    status
  });
  if (!written) {
    let latestMemory = await getMemoryById(env.DB, {
      namespace: snapshot.namespace,
      id: snapshot.id
    });
    if (latestMemory) {
      const latestEligibility = isFiveAxisMemoryEligible(latestMemory) ? "eligible" : "ineligible";
      await markMemoryVectorResult(env.DB, {
        namespace: latestMemory.namespace,
        id: latestMemory.id,
        expectedRevision: latestMemory.five_axis_revision ?? 1,
        expectedEligibility: latestEligibility,
        status: "pending"
      });
      latestMemory = await getMemoryById(env.DB, {
        namespace: snapshot.namespace,
        id: snapshot.id
      });
    }
    return {
      outcome: "stale",
      attemptedAction: action,
      latestMemory
    };
  }

  const memory = await getMemoryById(env.DB, {
    namespace: snapshot.namespace,
    id: snapshot.id
  }) ?? snapshot;
  return external.ok
    ? { outcome: "synced", action, memory }
    : { outcome: "failed", action, memory, errorCode: external.errorCode };
}

export async function retryPendingMemoryVectors(
  env: Env,
  namespace: string,
  limit = 50
): Promise<VectorRetrySummary> {
  const pending = await listPendingVectorReconciliations(env.DB, { namespace, limit });
  const summary: VectorRetrySummary = {
    selected: pending.length,
    synced: 0,
    deleted: 0,
    failed: 0,
    stale: 0,
    missing: 0
  };

  for (const memory of pending) {
    const result = await reconcileMemoryVector(env, {
      namespace: memory.namespace,
      memoryId: memory.id
    });
    if (result.outcome === "synced") {
      summary[result.action === "upsert" ? "synced" : "deleted"] += 1;
    } else {
      summary[result.outcome] += 1;
    }
  }
  return summary;
}
