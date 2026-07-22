export const ADMIN_BOARD_ROUTES = {
  home: { method: "GET", path: "/admin/memories" },
  create: { method: "POST", path: "/admin/memories/create" },
  edit: { method: "POST", path: "/admin/memories/edit" },
  delete: { method: "POST", path: "/admin/memories/delete" },
  approveDreamReview: { method: "POST", path: "/admin/memories/review/approve" },
  rejectDreamReview: { method: "POST", path: "/admin/memories/review/reject" },
  approveCandidate: { method: "POST", path: "/admin/memories/candidates/approve" },
  rejectCandidate: { method: "POST", path: "/admin/memories/candidates/reject" },
  repairCandidateEvidence: { method: "POST", path: "/admin/memories/candidates/repair-evidence" },
  batchRejectCandidateQuality: { method: "POST", path: "/admin/memories/candidates/batch-quality-reject" },
  batchReviewCandidateFacts: { method: "POST", path: "/admin/memories/candidates/batch-facts" },
  toggleCoordinateBackfill: { method: "POST", path: "/admin/memories/coordinate-backfill/toggle" },
  scanTimeline: { method: "POST", path: "/admin/memories/x-timeline/scan" },
  approveTimeline: { method: "POST", path: "/admin/memories/x-timeline/approve" },
  rejectTimeline: { method: "POST", path: "/admin/memories/x-timeline/reject" },
  retryFiveAxisDeadLetter: { method: "POST", path: "/admin/memories/lmc5/retry-dead-letter" },
  scanOperationalReview: { method: "POST", path: "/admin/memories/m-review/scan" },
  approveOperationalReview: { method: "POST", path: "/admin/memories/m-review/approve" },
  rejectOperationalReview: { method: "POST", path: "/admin/memories/m-review/reject" },
  batchOperationalReview: { method: "POST", path: "/admin/memories/m-review/batch" },
  rollbackOperationalReview: { method: "POST", path: "/admin/memories/m-review/rollback" }
} as const;

export type AdminBoardRoute = typeof ADMIN_BOARD_ROUTES[keyof typeof ADMIN_BOARD_ROUTES];

export const ADMIN_BOARD_POST_ROUTES = Object.values(ADMIN_BOARD_ROUTES)
  .filter((route): route is Extract<AdminBoardRoute, { method: "POST" }> => route.method === "POST");

export function isAdminBoardRoute(method: string, pathname: string): boolean {
  return Object.values(ADMIN_BOARD_ROUTES).some((route) => route.method === method && route.path === pathname);
}
