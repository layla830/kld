export const relationProvenance = {
  yAuto(sourceMemoryId: string, memoryRevision: number): string {
    return `y:auto:${sourceMemoryId}:${memoryRevision}`;
  },

  yReviewApproved(candidateExternalKey: string): string {
    return `y-review:approved:${candidateExternalKey}`;
  },

  factGroupApproved(candidateExternalKey: string): string {
    return `fact-group:approved:${candidateExternalKey}`;
  },

  dreamAuto(dateLabel: string): string {
    return `dream:auto:${dateLabel}`;
  },

  apiMemoryWrite(source: string): string {
    return `api:memory-write:${encodeURIComponent(source)}`;
  }
} as const;
