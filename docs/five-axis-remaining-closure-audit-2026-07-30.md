# Five-axis remaining closure audit — F1–F11 re-verification

- Date: 2026-07-30
- Basis: `origin/main` = `ff7b93c` ("Gate relation rollback on approval snapshot (#106)"). Local HEAD `4a06e41` is tree-identical to `ff7b93c` (`git diff 4a06e41 ff7b93c` empty); all file:line evidence below is against that tree.
- Source report: `../kld-supersede-fix/docs/five-axis-closed-loop-review-2026-07-28.md` (F1–F11 + design-constraints section).
- Method: independent re-verification against current code — no verdict inherited from the old report. Three parallel read-only partitions (F1/F2/F10, F3/F5/F7/F11, F4/F6/F8/F9+constraints) plus owner-level direct verification of F1-cascade, F2-TTL, F11-scanner, F11-A-rollback.

## Verdict summary

| # | Finding (2026-07-28) | Verdict | Primary evidence | Commit |
|---|---|---|---|---|
| F1 | retention hard-delete no cascade; audit INNER JOIN hides orphans | resolved | `src/db/retention.ts:182-268` | `a893d24` |
| F2 | memory_events 30d TTL vs snapshot recoverability | partially_resolved | `src/db/retention.ts:52`, `src/config/runtime.ts:211`, `src/api/adminBoard/metabolismActions.ts:575` | `ff7b93c` (#106, safety only) |
| F3 | `markLatestSkippedXRunsApplied` fabricated applied runs | resolved | function deleted; `src/memory/diaryTimelineBackfill.ts` 145 lines, no raw `SET status='applied'` in src | `2ecec91` |
| F4 | active-memory group membership changes ownerless | resolved | `src/memory/state.ts:158-171,229`; `src/memory/deprojection.ts:237-250`; `src/api/adminBoard/timelineActions.ts:116-119` | `5266378`,`2ecec91`,`7e54383`,`ca6b226` |
| F5 | stale candidate closure ownerless (y/m_archive/z/z-best-dep) | resolved | `src/db/memoryCandidates.ts:158-240`; `src/db/memoryCandidateDependencies.ts:258-300`; `src/db/memories.ts:552-569` | `64f2d5c` |
| F6 | diarySplit rescreen bare UPDATE bypass | resolved | `src/memory/diarySplit.ts:267-313` both transitions via `mutateMemoryLifecycle` | `7e54383` |
| F7 | Z/M rollback non-atomic | resolved | M: `metabolismActions.ts:546-552`; Z: `src/api/adminBoard/factTransitionActions.ts:166-237` single batch | `5231430` / PR `cd7538f` (#104) |
| F8 | timeline_date approval unguarded, non-atomic | resolved | `src/api/adminBoard/timelineActions.ts:35-127` guarded single batch, result checked :112 | `5231430` |
| F9 | exhausted same-revision failed runs ownerless | resolved | `src/db/memoryFiveAxisRuns.ts:425` → terminal `skipped`/`attempts_exhausted`; `src/db/memoryFiveAxisOutbox.ts:426-493` requeue; audit `scripts/inactive-five-axis-audit.mjs:245-259` | `2ecec91`,`8efd3ea`,`9e9420b` |
| F10 | memory_metabolism_signal_state no lifecycle | partially_resolved | `src/db/retention.ts:245-250`; `src/memory/recallMetabolismShadow.ts:150,219-226` | `a893d24` |
| F11 | relation rollback resurrection + scanner suppression | partially_resolved | A: `metabolismActions.ts:104-131,432-543,575` resolved; B: `src/memory/metabolismReview.ts:184-187,199-202,213-216` unresolved | `ff7b93c` (#106, part A) |

Score: 8 resolved / 3 partially_resolved / 0 fully unresolved. One live functional gap remains: F11-B.

## Per-finding evidence

### F1 — resolved

- Hard delete is now a single transactional `db.batch` with a `WITH retention_targets` CTE re-resolving eligibility (`src/db/retention.ts:182-191`), cascading before `DELETE FROM memories` (`:263-268`): candidate axis-run links (`:206-211`), candidate dependencies (`:212-217`), relations (`:218-226`), timeline memberships (`:227-232`), outbox (`:233-238`), runs (`:239-244`), signal_state (`:245-250`), recall rollups (`:251-262`).
- Eligibility additionally *blocks* hard delete while incomplete deprojections (`:117-123`), diary memberships (`:124-133`), or pending candidates (`:134-153`) reference the memory. Terminal candidates intentionally survive as history (`:173-180` — recorded policy, not oversight).
- Orphan visibility: dedicated `retention_orphans` audit section with anti-join counts (`scripts/inactive-five-axis-audit.mjs:739-941`, e.g. `orphan_relations` `:794-808`, `orphan_axis_runs` `:855-860`, `orphan_metabolism_signal_states` `:920-927`).
- No new DB-level FK — orphan prevention is application-level; covered by `tests-worker/retention-hard-delete.test.ts`.

### F2 — partially_resolved

- TTL is still unconditional on event_type: `DELETE FROM memory_events WHERE namespace = ? AND created_at < ?` (`src/db/retention.ts:52`), cutoff `memoryEventsDays` default 30 (`src/config/runtime.ts:211`). `m_snapshot` rows are deleted with everything else.
- Safety half fixed by #106 (`ff7b93c`): with the snapshot TTL-deleted, rollback's `snapshotPostStateGuard` fails and the probe throws `metabolism_relation_rollback_snapshot_invalid` (`metabolismActions.ts:575`) — fail closed, zero modifications. No resurrection possible.
- Contract half open: an approved `m_relation_cleanup` candidate is effectively rollback-able only within `MEMORY_RETENTION_EVENTS_DAYS` (30d). The old report required an explicit landing decision for snapshots (exempt from TTL or a durable home) before provenance Part C; that decision is still not implemented.
- Adjacent facts: `memory_deprojections` has no TTL (no DELETE in src — contract for m_archive rollback survives); m_archive rollback reads candidate payload + current memory row (`metabolismActions.ts:368-379`), so it is only bounded by memory hard-delete, which fails closed (`metabolism_rollback_target_changed`).

### F3 — resolved

- `markLatestSkippedXRunsApplied` no longer exists (grep over src: no match); the 22-line fabricated-`backfill:1` UPDATE and its call site were removed in `2ecec91`. Current `diaryTimelineBackfill.ts` only retires legacy day nodes and calls `rebuildDiaryTimelineForMemory`. Replacement path: `runMemoryGroupTransitionCleanup` (`src/memory/state.ts:158-171`) triggers legitimate reruns. No raw `SET status='applied'` remains in src.

### F4 — resolved

- timeline side: `runMemoryGroupTransitionCleanup` (`src/memory/state.ts:158-171`, invoked on every non-deprojection lifecycle mutation at `:229`) detects group-shape change via `timelineSequenceShapeChanged` and rebuilds current + previous groups (`src/memory/timelineRelations.ts:97-99`); stale memberships deleted at `:113-116`, `timeline_approved:` edges group-scoped-deleted at `src/db/memoryRelations.ts:180-187`.
- diary side: deprojection snapshots affected diary groups (`src/memory/deprojection.ts:237-240`) and both completion paths call `rebuildDiaryTimelineGroupsAfterTransition` (`:164-167`, `:245-250`), recoverable from the record's snapshot on retry. timeline_date approval on split items routes to diary owner + `rebuildDiaryTimelineForMemory` (`src/api/adminBoard/timelineActions.ts:116-119`).

### F5 — resolved (all four variants)

- Mechanism `replacePendingOperationalCandidateFamily` (`src/db/memoryCandidates.ts:158-240`, commit `64f2d5c`): upserts + stale-family rejection (`:174-194`) + linked-run reconciliation (`:196-227`) in one batch; stable reason `superseded_by_newer_candidate_snapshot`. Mutation-side sibling `prepareRejectStaleOperationalCandidatesForMemory` (`src/db/memoryCandidateDependencies.ts:258-300`) runs inside every `updateMemory` batch (`src/db/memories.ts:552-569`).
- y: family call at `src/memory/relationReview.ts:39-44`; stale predicate revision-first with `updated_at` fallback (`candidateSnapshotContract`).
- m_archive: family call per target `metabolismReview.ts:95-98`, plus empty-family reconciliation rejecting pendings whose target left the policy predicate (`:119-161`; verified directly).
- z: whole fact-key family replaced at `src/memory/factTransitionReview.ts:116-121` including empty sets (`:42-58`); importance/confidence edits now make the candidate stale via the mutation-side rejection in the same batch; same-revision orphaned `pending_review` runs are reconciled to `skipped` (`memoryCandidateDependencies.ts:87-115`, `memoryFiveAxisRuns.ts:52-70`).
- z best-side dependency: declared at `factTransitionReview.ts:108-111` (best=source, weaker=target); deprojection cascade-rejects dependent candidates in the deprojection batch (`memoryDeprojection.ts:575-581`).
- Audit counters: `stale_operational_candidate_rows` + per-action breakdown (`scripts/inactive-five-axis-audit.mjs:612-632`); `candidate_linked_stale_runs` (`:549`) retained as diagnostics.

### F6 — resolved

- `activateRescreenedDiary` routes both transitions through `mutateMemoryLifecycle`: new items review→active (`src/memory/diarySplit.ts:267-282`) and old items active→review (`:292-308`) with `expectedStatus`/revision guards, dedicated `operationId`, conflicts throwing. No bare UPDATE remains; run/relation closure follows the lifecycle path. (`7e54383`)

### F7 — resolved

- Z rollback `rollbackFactTransitionCandidate` (`src/api/adminBoard/factTransitionActions.ts:166-237`) is one batch via `commitMemoryCandidateRollback` with guarded restore + event (`:216-225`); pre-commit awaits are reads only. M rollback likewise single-batch (`metabolismActions.ts:546-552`, historically `5231430`, hardened by `ff7b93c`).

### F8 — resolved

- `approveTimelineCandidate` (`src/api/adminBoard/timelineActions.ts:35-127`): `prepareMemoryUpdate` with `expectedStatus:"active"` + revision guard + candidate guard (`:73-84`), guarded approval event, single `commitMemoryCandidateApproval` with checked result (`:101-112`), stale-content pre-guards (`:60-70`). (`5231430`)

### F9 — resolved

- `failFiveAxisRun` terminates exhausted runs as `status='skipped'` with `reason='attempts_exhausted'` instead of forever-`failed` (`src/db/memoryFiveAxisRuns.ts:425`+); requeue path `retryFiveAxisDeadLetter` resets attempts with an audit event (`src/db/memoryFiveAxisOutbox.ts:426-493`); audit counts `exhaustedFailedRun`/`exhaustedTerminalRun` (`scripts/inactive-five-axis-audit.mjs:245-259`). (`2ecec91`,`8efd3ea`,`9e9420b`)

### F10 — partially_resolved

- Every `memory_metabolism_signal_state` site enumerated: schema `migrations/20260719_recall_signal_rollups.sql:29,41`; sole writer `observeRecallMetabolismSignals` upsert `src/memory/recallMetabolismShadow.ts:219-226`; sole DELETE `src/db/retention.ts:245-250` (hard-delete batch, `a893d24`); sole reader `recallMetabolismShadow.ts:148-150` (`WHERE m.status='active'`); audit orphan count `inactive-five-axis-audit.mjs:920-927`.
- Transitions: **hard delete** — closed (cascade). **eligible→inactive (deprojection)** — row intentionally left, but inert: the only reader filters `status='active'`, and no decision path consumes the row otherwise; deprojection/rollback residue is hygiene-only and now audit-visible via the orphan counter (count only fires for *missing* memory rows, so parked rows for archived memories are invisible today — acceptable but noted).
- **rollback (archive→active)** — the stale band persists until the next observation pass overwrites it (ON CONFLICT UPDATE at `:219-226`); worst case is one spurious `metabolism_signal_observed` transition event. Mitigated by reader/upsert shape, not by an explicit owner.
- Verdict rationale: no live decision reads stale state; the residual is cosmetic-latent, hence partial rather than unresolved.

### F11 — partially_resolved

- **Part A (resurrection) — resolved** by `ff7b93c` (#106). Rollback restores exclusively from the `m_snapshot` event via `json_extract(snapshot.payload_json,'$.before.*')` (`metabolismActions.ts:471-505`), gated by `relationCleanupSnapshotPredicate` (`:104-131`: boolean-typed `relation_was_present`, identity match, non-null strength/created_at on the true branch, snapshot uniqueness); missing/malformed → fail closed `metabolism_relation_rollback_snapshot_invalid` (`:575`); reappeared relation → `metabolism_relation_rollback_conflict` (`:579`). No candidate-payload fallback for restore values. (Verified by full line read this session + targeted tests 14/14.)
- **Part B (scanner suppression) — unresolved.** All three relation scans use status-unfiltered dedupe:
  - self-loops `src/memory/metabolismReview.ts:184-187`, orphans `:199-202`, symmetric duplicates `:213-216` — each `NOT EXISTS ( SELECT 1 FROM memory_candidates c WHERE c.namespace = r.namespace AND c.external_key = 'm-review:relation:' || r.id )` with **no `c.status` filter**.
  - A terminal `rolled_back`/`rejected` row of that key permanently suppresses re-queuing; the upsert conflict clause only refreshes non-terminal rows (`src/db/memoryCandidates.ts:127`), and `replacePendingOperationalCandidateFamily` deliberately excludes `m_relation_cleanup` (`memoryCandidates.ts:61-75`; spec `docs/stale-operational-candidate-supersession-spec-2026-07-28.md` §2).
  - Severity: latent, not corrupting — a rolled-back relation simply never gets re-proposed. But since cleanup candidates are the only owner of that relation class, one rollback/reject silences it forever.

## Design-constraints section — no live blockers

- **active_fact outside trigger columns** (`migrations/20260716_five_axis_dependency_triggers.sql:115-116`): unchanged, status↔active_fact coupling enforced in `src/db/memories.ts:490-493`; no new activeFact-only write path observed. Inert as recorded.
- **deferred_relation dead-end**: still no path back to pending; exits only via rejection (`memoryCandidates.ts:406,414,503`; family rejection covers it via pendingStatuses). Unchanged, inert.
- **z approve recompute window limit=200** (`src/api/adminBoard/factTransitionActions.ts:85`): unchanged; F5's real-time staleness closure shrinks the practical collision surface, and stack-ranked findings do not warrant touching it now.
- **ingress silent terminal-key drop** (`src/db/memoryCandidates.ts:123-127`, `src/api/memoryCandidates.ts:97-105`): unchanged; observability gap known, not blocking.
- **axis run side-effects non-transactional** / **run reconciliation not instant**: unchanged accepted shapes.

## Remaining gaps and minimal next baton

Only two items carry residual work, and both are deliberately scoped decisions rather than large builds:

1. **F11-B (recommended next, single small diff)** — the relation-scanner dedupe should match only non-terminal candidates: add `AND c.status IN ('pending','needs_subject_review','deferred_relation')` to the three NOT EXISTS clauses at `metabolismReview.ts:184-187,199-202,213-216`, plus one targeted regression test (terminal candidate must not suppress; pending must). ⚠️ Open call before writing: after a human rollback (`was_present=1` restore), the same scan would immediately re-propose the same cleanup — a human-vs-scanner loop. The key embeds no `updated_at` and relation rows never mutate, so either accept continuous re-proposal (consistent with y/z/m_archive staleness philosophy) or define the terminal-suppression exception by status (e.g. only `rolled_back` suppresses). Decide first; do not add states or scanners.
2. **F2 (decision, not code)** — pick the long-term home for rollback-critical `m_snapshot` events: retention exemption in `deleteOldMemoryEvents` (`src/db/retention.ts:52`) vs explicit acceptance of the 30-day rollback window. One-line change either way, but it is a retention-semantics decision and should ride with the deferred provenance Part C pricing, not be slipped in unannounced.

F10's remains are cosmetic-latent (orphan counter only fires for deleted memories; stale band self-heals on next observation). No action recommended this cycle.
