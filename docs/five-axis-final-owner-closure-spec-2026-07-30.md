# Five-axis final owner closure — F2 / F10 / F11-B minimal spec

- Date: 2026-07-30. Status: spec only, no implementation.
- Basis: `origin/main` = `ff7b93c`. Prior audit: `docs/five-axis-remaining-closure-audit-2026-07-30.md`.
- Production read-only evidence (2026-07-30): approved `m_relation_cleanup` = 188, missing snapshot = 0; oldest authoritative `m_snapshot` = 2026-07-10 (~10 days from the 30-day TTL); `memory_metabolism_signal_state` rows = 0; relations whose terminal legacy candidate is `rejected` = 93, `rolled_back` = 0.
- Rulings A/B/C in this document are the owner's decisions; this spec turns them into minimal diffs. Forbidden: new scanner, fallback to candidate payload, migration, new candidate status, large abstraction.

## Verified preconditions (current code)

- Relation rows are application-layer immutable: no `UPDATE memory_relations` exists anywhere under `src/` (only INSERT/DELETE). A relation's identity is `(namespace, id)` and its incarnation is `(id, created_at)` — a delete+reinsert always produces a new `created_at`. This makes the incarnation key sound without a schema change.
- Queue payload already carries the full row: `queueRelationCandidates` writes `payload: { _kind, reason, before: row.relation }` with `before` from `SELECT r.*` (`src/memory/metabolismReview.ts:246`), so `before.created_at` exists on every candidate including the 93 legacy rejected rows.
- `deleteOldMemoryEvents` is a single standalone statement invoked from the retention loop (`src/memory/retention.ts:111`); changing the DELETE's WHERE keeps the loop untouched.
- Deprojection cleanup statements are assembled in `cleanupStatements` (`src/db/memoryDeprojection.ts:365-398`) and executed inside the single prepared deprojection batch (`:605-612`); every sibling statement carries the same `pendingOperation` guard — one more statement there inherits atomicity for free.
- Rollback-critical snapshot well-formedness is defined once today: `relationCleanupSnapshotPredicate` (`src/api/adminBoard/metabolismActions.ts:104-131`) — boolean `relation_was_present`, `before` object, identity match, unique per candidate.

### Codex review amendment

Commit A creates two tiny shared SQL builders in
`src/memory/relationCleanupSnapshotContract.js` (plus its `.d.ts`):

- the number of snapshot rows keyed by `namespace + candidate_id + action`;
- the validity predicate for one snapshot row against one candidate row.

This contract is consumed by rollback, retention, and audit. Keeping the old
private rollback predicate while copying partial variants into the other two
callers would create three owners. A valid snapshot must bind
`snapshot.payload.candidate_id = candidate.id`, match the candidate's complete
relation identity (`id/source/target/type`), have a boolean
`relation_was_present`, and, on the true branch, non-null
`strength/created_at`. The keyed snapshot count must equal exactly one.

## Commit A — retention: exempt only the rollback-live m_snapshot

**Goal:** the 30-day `memory_events` TTL must never delete the one legitimate `m_snapshot` while the owning `m_relation_cleanup` candidate is still `approved`. No blanket exemption, no candidate-payload fallback at rollback time (unchanged), no snapshot for other actions.

**Diff — one statement plus the shared contract** (`src/db/retention.ts:46-56`,
`deleteOldMemoryEvents`): extend the existing DELETE with an exemption clause;
nothing else in the retention loop changes. In outline:

```sql
DELETE FROM memory_events
WHERE namespace = ? AND created_at < ?
  AND NOT (
    event_type = 'm_snapshot'
    AND EXISTS (
      SELECT 1 FROM memory_candidates c
      WHERE c.namespace = memory_events.namespace
        AND c.id = json_extract(memory_events.payload_json, '$.candidate_id')
        AND c.action = 'm_relation_cleanup'
        AND c.status = 'approved'
        AND <shared snapshot-validity predicate>
        AND <shared keyed snapshot count> = 1
    )
  )
```

Semantics:

- Only `m_snapshot` rows for `m_relation_cleanup`, referenced by a **currently `approved`** candidate, exactly one per candidate (uniqueness = the "唯一合法" rule), and well-formed (boolean flag + object `before`) are kept. Identity is pinned through `before.id` matching the candidate's own payload — malformed or mismatched rows are *not* the legitimate snapshot and TTL-deleted normally.
- Once the candidate reaches `rolled_back`/`rejected`, the row loses exemption and the next retention pass deletes it. No new retention window, no config change.
- The exemption is the same imported well-formedness contract as rollback,
  evaluated at retention time; a rollback of an exempted snapshot therefore
  can never find its snapshot TTL-deleted while `approved` — the F2 contract
  gap closes.

**Read-only audit owner** (no writes, no repair): extend `scripts/inactive-five-axis-audit.mjs` with a small `m_snapshot_contract` section counting, for `approved` `m_relation_cleanup` candidates: (1) missing snapshot, (2) duplicate snapshot count ≠ 1, (3) malformed payload (`relation_was_present` non-boolean / `before` non-object / identity mismatch against candidate payload). These counts are the *only* owner of anomaly visibility; the audit never reads candidate payload as a restore source — it only *compares*, matching the no-fallback rule. Expected steady state after Commit A: missing = 0 forever (production baseline is already 0).

**Tests (tests-worker, extend `retention-hard-delete.test.ts` or a focused file):**

1. Old generic events and an old `m_archive` snapshot are TTL-deleted; the old `m_snapshot` of an approved relation-cleanup candidate survives.
2. After that candidate is atomically rolled back (snapshot true path), the *next* retention pass deletes its snapshot.
3. Duplicate snapshots (count = 2) for an approved candidate are not exempt — deletable.
4. Malformed snapshot (string `was_present`) is not exempt.
5. Audit section returns missing/duplicate/malformed counts as expected on seeded anomalies; clean fixture returns zero.

## Commit B — deprojection owns signal_state deletion

**Goal:** `prepareMemoryDeprojection`'s batch deletes the memory's `memory_metabolism_signal_state` rows in the same transaction as the status transition. No snapshot of the band, no restore on rollback, retention hard-delete cascade (`src/db/retention.ts:245-250`) untouched.

**Diff — one statement.** In `cleanupStatements` (`src/db/memoryDeprojection.ts:365`), append, shaped exactly like its siblings:

```sql
DELETE FROM memory_metabolism_signal_state
WHERE namespace = ? AND memory_id = ?
  AND (${pendingOperation.sql})
```

Guarded by the same `pendingOperation` operation-scope guard as every sibling statement, so it is atomic with the deprojection batch (all-or-nothing, retry-idempotent via the operation record).

**Semantics:** eligible→inactive transition removes the band row. Rollback (archive→active) restores nothing; the sole writer `observeRecallMetabolismSignals` (`src/memory/recallMetabolismShadow.ts:219-226`) recreates the row from live metrics at the next real observation — the "stale band on rollback" branch of F10 disappears because there is no band to be stale. The band is recomputation cache, not state worth preserving.

**Tests (extend `tests-worker/memory-deprojection.test.ts`):**

1. Seed a signal_state row (via the existing upsert or direct insert), deproject the memory → row gone, memory transition + candidate/relations closure unchanged.
2. Trigger-abort the deprojection commit (existing failure-injection pattern) → signal_state row still present, memory still active: no partial delete.
3. Roll back the deprojection (m_archive rollback path) → row still absent; run one observation pass → row recreated with fresh band.
4. Deprojection of a memory with no signal_state row → zero-row delete, no error.

## Commit C — relation incarnation key + shared suppression predicate

**Goal:** a terminal candidate suppresses only the *incarnation* of the relation it judged; delete+recreate (same id, new `created_at`) becomes proposable again. No status-filter shortcut (rejected re-proposal loop), no reopen of terminal rows, no new status.

**Key change** (`src/memory/metabolismReview.ts:240`): candidate external key becomes the incarnation key

```text
m-review:relation:{relation.id}:{relation.created_at}
```

`created_at` is immutable-per-incarnation (verified: relation rows are never UPDATEd), so the key is stable across scans of the same row and fresh after delete+reinsert. Terminal rows of old incarnations occupy a different key and cannot block a new incarnation; the existing `ON CONFLICT` upsert semantics (`src/db/memoryCandidates.ts:123-127`) then work unmodified.

**One local owner for both sides of the rule.** Introduce a single local helper in `metabolismReview.ts` (not exported, not moved to a shared module) that returns the suppression SQL + binds for a relation alias `r`:

```sql
AND NOT EXISTS (SELECT 1 FROM memory_candidates c
  WHERE c.namespace = r.namespace
    AND c.external_key = 'm-review:relation:' || r.id || ':' || r.created_at)
AND NOT EXISTS (SELECT 1 FROM memory_candidates c
  WHERE c.namespace = r.namespace
    AND c.external_key = 'm-review:relation:' || r.id            -- legacy key, any status
    AND json_extract(c.payload_json, '$.before.id') = r.id
    AND json_extract(c.payload_json, '$.before.source_memory_id') = r.source_memory_id
    AND json_extract(c.payload_json, '$.before.target_memory_id') = r.target_memory_id
    AND json_extract(c.payload_json, '$.before.relation_type') = r.relation_type
    AND json_extract(c.payload_json, '$.before.created_at') = r.created_at)
```

Applied identically inside the three scans of `relationCleanupRows` (self-loops `:181-188`, orphans `:191-203`, symmetric duplicates `:206-217`), replacing the three copies of the current status-unfiltered `NOT EXISTS`. The key builder (`relationCleanupCandidateKey(relation)`) and the suppression clause are the only two local helpers; the queue loop calls the key builder, the scans call the clause. `m_relation_cleanup` stays excluded from `replacePendingOperationalCandidateFamily` — no change there.

Semantics:

- Same incarnation, any terminal-or-pending status → suppressed (no human-vs-scanner loop; reject/rollback remains final for that row).
- Legacy-key candidates (no `:created_at` suffix — all 188 approved + 93 rejected in production) suppress **only** while their recorded `before` identity *and* `created_at` still equal the current row; the 93 production rows keep suppressing exactly the incarnations they rejected, and nothing else.
- Delete+reinsert with same id → legacy key differs by suffix, legacy payload `created_at` mismatches → new candidate is queued. This is the only newly-proposable case.
- Dry-run/count semantics preserved: `relationCleanupRows` feeds both, so `dryRun` counts and actual queue counts stay identical and both already reflect the suppression rule (`scanMetabolismReviewCandidates` shape at `:259-274` unchanged).

**Tests (extend `tests-worker/metabolism-relation-cleanup-actions.test.ts`):**

1. Terminal `rolled_back` candidate with an incarnation key suppresses re-queuing of the same row (scan returns no row for it, dry-run count agrees).
2. Legacy-key `rejected` candidate whose payload `before` matches the current row (production shape) → suppressed.
3. Delete the relation, reinsert with same id/new `created_at` → next scan queues a candidate with the new incarnation key; legacy row untouched.
4. Pending legacy candidate suppresses exactly like terminal legacy (payload match), preventing duplicate pendings after the key rollover.
5. Queue once, scan again → idempotent (new-key NOT EXISTS hits), count stable.
6. Approve new-key candidate → rollback (Commit-note: rollback path is key-agnostic, reads candidate by id) → restored relation carries its original `created_at`, so the same incarnation key now has a `rolled_back` candidate and stays suppressed — the rollback-restore loop cannot restart.

## Boundaries and non-goals

- Three commits, independent, shippable in order A → B → C (C is the only behavior-visible one).
- No change to: approval path guards, rollback semantics (its private SQL is
  replaced by the shared equivalent), `replacePendingOperationalCandidateFamily`
  coverage, retention cascade (`retention.ts:182-268`), any migration, any
  candidate status, any scanner beyond the shared clause.
- No scanner loop repair, no compensation deletes for existing data: the 93 legacy rows are handled by the legacy clause read-only at scan time; zero backfill.

## Blockers

None found. The one item to watch at implementation time: JSON string comparison of `created_at` (`json_extract(c.payload_json,'$.before.created_at') = r.created_at`) is exact-string equality; both sides originate from the same `SELECT r.*` row snapshot, so format drift is not expected, but the Commit-C tests 2–3 pin it explicitly.
