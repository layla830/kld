# M-axis metabolism review closure (2026-07-08)

## Scope

The first executable M-axis pass is deliberately narrow:

- expired, unpinned `project_state` memories;
- relation self-loops;
- relations touching missing or non-live memories;
- reverse duplicates for explicitly symmetric relation types only.

It does not propose or execute changes to identity, relationship moments, diary records, content merging, or pinned memories.

## Review flow

1. Open `admin/memories?tab=m-review` and run the scan.
2. Each finding becomes a stable `memory_candidates` row.
3. The card shows the reason, exact before snapshot, and the proposed after state.
4. Rejecting resolves the stable candidate without changing memory data.
5. Approving revalidates the target, writes an `m_snapshot` event, and performs one bounded mutation.
6. Approved cards expose rollback; rollback restores the captured memory state or exact relation row and writes `m_rollback`.

Archive means `status=archived` and `active_fact=0`; it is not physical deletion. Relation cleanup changes only `memory_relations`.

## Safety and rollback

- Every approval checks that the target still matches the candidate.
- Symmetric duplicate detection is restricted to `SYMMETRIC_RELATION_TYPES`, so directional timeline/causal edges are not treated as duplicates.
- Archive approval is restricted again at execution time to expired, active, unpinned `project_state` rows.
- No operation is automatic: scan only creates review candidates.
