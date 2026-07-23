import {
  findCompletedMemoryDeprojection,
  getMemoryDeprojectionByOperationId,
  prepareMemoryDeprojection,
  type MemoryDeprojectionRecord
} from "../db/memoryDeprojection";
import {
  getMemoryById,
  type MemoryMutationGuard,
  type UpdateMemoryInput
} from "../db/memories";
import type { Env, MemoryRecord } from "../types";
import {
  applyMemoryEligibilityPatch,
  classifyMemoryEligibilityTransition,
  isFiveAxisMemoryEligible,
} from "./fiveAxis/eligibility";

export type { MemoryEligibilityState, MemoryEligibilityTransition } from "./fiveAxis/eligibility";
export {
  applyMemoryEligibilityPatch,
  classifyMemoryEligibilityTransition
} from "./fiveAxis/eligibility";

export type MemoryDeprojectionSource =
  | "memory_api"
  | "admin_board"
  | "dream_review"
  | "dream_candidate"
  | "z_review"
  | "m_review"
  | "retention"
  | "system";

export interface MemoryDeprojectionInput {
  namespace: string;
  memoryId: string;
  patch: UpdateMemoryInput;
  expectedStatus?: string;
  expectedRevision?: number;
  requireUnpinned?: boolean;
  source: MemoryDeprojectionSource;
  reason: string;
  candidateId?: string;
  operationId?: string;
}

export interface PrepareMemoryDeprojectionInput extends MemoryDeprojectionInput {
  memory: MemoryRecord;
  guard?: MemoryMutationGuard;
  now?: string;
}

export interface PreparedMemoryDeprojection {
  statements: D1PreparedStatement[];
  successGuard: MemoryMutationGuard;
  operationId: string;
  transition: "eligible_to_ineligible";
  previousRevision: number;
  currentRevision: number;
}

export interface MemoryDeprojectionResult {
  transition: "eligible_to_ineligible";
  memory: MemoryRecord;
  previousRevision: number;
  currentRevision: number;
  removedRelations: number;
  removedTimelineMemberships: number;
  invalidatedCandidates: number;
  terminalizedOutboxes: number;
  terminalizedAxisRuns: number;
  vectorSyncRequired: boolean;
  reused: boolean;
  operationId: string;
}

function resultFromRecord(
  operation: MemoryDeprojectionRecord,
  memory: MemoryRecord,
  reused: boolean
): MemoryDeprojectionResult {
  return {
    transition: "eligible_to_ineligible",
    memory,
    previousRevision: operation.previous_revision,
    currentRevision: operation.current_revision,
    removedRelations: operation.removed_relations,
    removedTimelineMemberships: operation.removed_timeline_memberships,
    invalidatedCandidates: operation.invalidated_candidates,
    terminalizedOutboxes: operation.terminalized_outboxes,
    terminalizedAxisRuns: operation.terminalized_axis_runs,
    vectorSyncRequired: operation.vector_sync_required !== 0,
    reused,
    operationId: operation.operation_id
  };
}

async function completedResult(
  env: Env,
  operation: MemoryDeprojectionRecord,
  reused: boolean
): Promise<MemoryDeprojectionResult> {
  if (!operation.completed_at || operation.invariants_verified !== 1) {
    throw new Error("memory_deprojection_incomplete");
  }
  const memory = await getMemoryById(env.DB, {
    namespace: operation.namespace,
    id: operation.memory_id
  });
  if (!memory) throw new Error("memory_deprojection_target_missing");
  return resultFromRecord(operation, memory, reused);
}

export async function deprojectMemoryFromFiveAxes(
  env: Env,
  input: MemoryDeprojectionInput
): Promise<MemoryDeprojectionResult> {
  if (input.operationId) {
    const existing = await getMemoryDeprojectionByOperationId(env.DB, input.operationId);
    if (existing) {
      if (existing.namespace !== input.namespace || existing.memory_id !== input.memoryId) {
        throw new Error("memory_deprojection_operation_scope_mismatch");
      }
      return completedResult(env, existing, true);
    }
  }

  const memory = await getMemoryById(env.DB, {
    namespace: input.namespace,
    id: input.memoryId
  });
  if (!memory) throw new Error("memory_deprojection_target_missing");

  const next = applyMemoryEligibilityPatch(memory, input.patch);
  const transition = classifyMemoryEligibilityTransition(memory, next);
  if (transition !== "eligible_to_ineligible") {
    if (!isFiveAxisMemoryEligible(memory)) {
      const existing = await findCompletedMemoryDeprojection(env.DB, {
        namespace: input.namespace,
        memoryId: input.memoryId,
        currentRevision: memory.five_axis_revision ?? 1,
        status: next.status,
        type: next.type,
        activeFact: next.active_fact
      });
      if (existing) return completedResult(env, existing, true);
    }
    throw new Error(`memory_deprojection_requires_eligible_to_ineligible:${transition}`);
  }

  const prepared = prepareMemoryDeprojection(env.DB, { ...input, memory });
  const results = await env.DB.batch(prepared.statements);
  const operation = await getMemoryDeprojectionByOperationId(env.DB, prepared.operationId)
    ?? await findCompletedMemoryDeprojection(env.DB, {
      namespace: input.namespace,
      memoryId: input.memoryId,
      currentRevision: prepared.currentRevision,
      status: next.status,
      type: next.type,
      activeFact: next.active_fact
    });
  if (!operation) throw new Error("memory_deprojection_precondition_failed");
  return completedResult(env, operation, (results[0]?.meta.changes ?? 0) === 0);
}

export { prepareMemoryDeprojection };
