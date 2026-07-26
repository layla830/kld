import type { MemoryMutationGuard } from "./memories";

export function combineMutationGuards(
  ...guards: MemoryMutationGuard[]
): MemoryMutationGuard {
  return {
    sql: guards.map((guard) => `(${guard.sql})`).join(" AND "),
    binds: guards.flatMap((guard) => guard.binds)
  };
}

export function memoryCandidateStatusGuard(
  namespace: string,
  candidateId: string,
  status: string
): MemoryMutationGuard {
  return {
    sql: "EXISTS (SELECT 1 FROM memory_candidates WHERE namespace = ? AND id = ? AND status = ?)",
    binds: [namespace, candidateId, status]
  };
}

export function memoryStatusGuard(
  namespace: string,
  memoryId: string,
  status: string
): MemoryMutationGuard {
  return {
    sql: "EXISTS (SELECT 1 FROM memories WHERE namespace = ? AND id = ? AND status = ?)",
    binds: [namespace, memoryId, status]
  };
}

export function memoryExistsGuard(
  namespace: string,
  memoryId: string
): MemoryMutationGuard {
  return {
    sql: "EXISTS (SELECT 1 FROM memories WHERE namespace = ? AND id = ?)",
    binds: [namespace, memoryId]
  };
}

export function memoryEventExistsGuard(
  namespace: string,
  eventId: string
): MemoryMutationGuard {
  return {
    sql: "EXISTS (SELECT 1 FROM memory_events WHERE namespace = ? AND id = ?)",
    binds: [namespace, eventId]
  };
}

export function memoryEventsExistGuard(
  namespace: string,
  eventIds: string[]
): MemoryMutationGuard {
  const uniqueEventIds = [...new Set(eventIds)];
  if (uniqueEventIds.length === 0) {
    throw new Error("memory_event_guard_requires_ids");
  }
  const placeholders = uniqueEventIds.map(() => "?").join(", ");
  return {
    sql: `(SELECT COUNT(*) FROM memory_events WHERE namespace = ? AND id IN (${placeholders})) = ?`,
    binds: [namespace, ...uniqueEventIds, uniqueEventIds.length]
  };
}
