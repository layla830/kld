export const FIVE_AXIS_NAMES = ["X", "Y", "Z", "E", "M"] as const;
export type FiveAxisName = typeof FIVE_AXIS_NAMES[number];

export const FIVE_AXIS_RUN_STATUS = {
  RUNNING: "running",
  APPLIED: "applied",
  PENDING_REVIEW: "pending_review",
  SKIPPED: "skipped",
  FAILED: "failed"
} as const;
export type FiveAxisRunStatus = typeof FIVE_AXIS_RUN_STATUS[keyof typeof FIVE_AXIS_RUN_STATUS];
export const FIVE_AXIS_RUN_STATUSES = Object.values(FIVE_AXIS_RUN_STATUS) as readonly FiveAxisRunStatus[];

export const FIVE_AXIS_OUTBOX_STATUS = {
  PENDING: "pending",
  QUEUED: "queued",
  FAILED: "failed",
  DEAD_LETTER: "dead_letter",
  COMPLETED: "completed",
  SKIPPED: "skipped"
} as const;
export type FiveAxisOutboxStatus = typeof FIVE_AXIS_OUTBOX_STATUS[keyof typeof FIVE_AXIS_OUTBOX_STATUS];
export const FIVE_AXIS_OUTBOX_STATUSES = Object.values(FIVE_AXIS_OUTBOX_STATUS) as readonly FiveAxisOutboxStatus[];

type OutboxTransitionDefinition = {
  from: readonly FiveAxisOutboxStatus[];
  to: readonly FiveAxisOutboxStatus[];
};

const ACTIVE_OUTBOX_STATUSES = [
  FIVE_AXIS_OUTBOX_STATUS.PENDING,
  FIVE_AXIS_OUTBOX_STATUS.QUEUED,
  FIVE_AXIS_OUTBOX_STATUS.FAILED
] as const;
const ACTIVE_OUTBOX_STATUS_SET = new Set<FiveAxisOutboxStatus>(ACTIVE_OUTBOX_STATUSES);

export const FIVE_AXIS_OUTBOX_TRANSITIONS = {
  queue: { from: ACTIVE_OUTBOX_STATUSES, to: [FIVE_AXIS_OUTBOX_STATUS.QUEUED] },
  complete: { from: ACTIVE_OUTBOX_STATUSES, to: [FIVE_AXIS_OUTBOX_STATUS.COMPLETED] },
  skip: { from: ACTIVE_OUTBOX_STATUSES, to: [FIVE_AXIS_OUTBOX_STATUS.SKIPPED] },
  fail: {
    from: ACTIVE_OUTBOX_STATUSES,
    to: [FIVE_AXIS_OUTBOX_STATUS.FAILED, FIVE_AXIS_OUTBOX_STATUS.DEAD_LETTER]
  },
  finalize_exhausted: {
    from: [FIVE_AXIS_OUTBOX_STATUS.QUEUED, FIVE_AXIS_OUTBOX_STATUS.FAILED],
    to: [FIVE_AXIS_OUTBOX_STATUS.DEAD_LETTER]
  },
  retry_dead_letter: {
    from: [FIVE_AXIS_OUTBOX_STATUS.DEAD_LETTER],
    to: [FIVE_AXIS_OUTBOX_STATUS.PENDING]
  }
} as const satisfies Record<string, OutboxTransitionDefinition>;

export type FiveAxisOutboxTransition = keyof typeof FIVE_AXIS_OUTBOX_TRANSITIONS;

export function canTransitionFiveAxisOutbox(
  transition: FiveAxisOutboxTransition,
  from: FiveAxisOutboxStatus,
  to: FiveAxisOutboxStatus
): boolean {
  const definition: OutboxTransitionDefinition = FIVE_AXIS_OUTBOX_TRANSITIONS[transition];
  return definition.from.includes(from) && definition.to.includes(to);
}

export function statusPlaceholders(statuses: readonly FiveAxisOutboxStatus[]): string {
  return statuses.map(() => "?").join(", ");
}

export function isProcessableFiveAxisOutboxStatus(status: FiveAxisOutboxStatus): boolean {
  return ACTIVE_OUTBOX_STATUS_SET.has(status);
}
