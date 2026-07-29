# F11 — m_relation_cleanup rollback: snapshot-gated restore / no resurrection

Date: 2026-07-29. Status: spec only, no implementation.

## 1. Invariant

Rolling back an `m_relation_cleanup` approval must restore the relation row
if and only if the approval-time `m_snapshot` event recorded
`relation_was_present = true` and no relation with the same `id` currently
exists. Nothing may ever be resurrected from the candidate payload.

## 2. Root cause

`rollbackMetabolismCandidate` (`src/api/adminBoard/metabolismActions.ts:367-414`)
builds the restore `INSERT` for the relation-cleanup branch unconditionally
from `beforeOf(payloadOf(candidate.payload_json))`. The approval path
(`relationSnapshotStatement`, same file :51-102) already writes an
`m_snapshot` event carrying `relation_was_present` — including the `false`
case where the relation was concurrently deleted before approval — but the
rollback never reads it. Outcome: an approval that raced a concurrent delete
(snapshot `false`) brings the deleted relation back on rollback.

Secondary gaps in the same branch:

- The restore values themselves come from the mutable candidate payload
  instead of the approval-time snapshot row.
- The restore `INSERT` is guarded only by the rollback event's existence; it
  has no snapshot, value, or current-relation guard of its own.

## 3. Non-negotiable constraints

- `m_snapshot` is the sole fact source for both the restore decision and the
  restored row values. No fallback to `candidate.payload_json.before`.
- No read-then-write decision: JavaScript may read the candidate row once
  (identity/status pre-check and bind inputs) but the restore-vs-abstain
  decision is expressed only inside the write statements' guards. Post-commit
  reads are diagnostics only, never decision inputs.
- Every write statement in the rollback batch carries its own guard covering
  all four categories: `snapshot` (exists, well-formed, `was_present`
  branch), `value` (snapshot `before` identity matches the requested
  relation), `status` (candidate still `approved`), `current-relation`
  (absent-before / consistent-after).
- No migration, no scanner, no new candidate status, no compensating DELETE.
- Conflict and fail-closed outcomes produce zero modifications and no
  `m_rollback` event.

## 4. Scope and ownership

Everything lives in the `m_relation_cleanup` branch of
`rollbackMetabolismCandidate`. Snapshot predicate helpers stay private to
`metabolismActions.ts` while this remains their only owner; move them to
`src/db/mutationGuards.ts` only if a second caller appears. The approval path
is unchanged: it already records the snapshot; the lookup key for rollback is

```sql
memory_events
WHERE namespace = ?
  AND event_type = 'm_snapshot'
  AND json_extract(payload_json, '$.candidate_id') = ?
  AND json_extract(payload_json, '$.action') = 'm_relation_cleanup'
```

(payload-keyed, so the current random `newId("ev")` event ids need no
backfill and the approval code needs no change.)

Out of scope: `m_archive` rollback, approval path, scanner, batch UI.

## 5. Snapshot definition

Well-formed snapshot for candidate `c`: exactly the event matched above whose
payload satisfies:

- `relation_was_present` is a JSON boolean (`json_extract` yields `0` or
  `1`; any other value is malformed);
- `before` exists and its `id`, `source_memory_id`, `target_memory_id`,
  `relation_type` equal the identity binds taken from the candidate
  payload (mismatch = malformed, fails closed even though honestly-written
  snapshots always match);
- on the `was_present = true` path additionally: `before.strength` and
  `before.created_at` are non-NULL.

Missing event or any violation above is *malformed*: fail closed.

## 6. State transition table

Single decision matrix; carried out by one guarded batch, not by if/else on
pre-reads.

| snapshot.relation_was_present | current relation (same id) | outcome |
|---|---|---|
| true  | absent  | restore original row **from snapshot `before` values**; write `m_rollback` (`relation_restored: true`); candidate → `rolled_back` |
| true  | present (any row) | conflict: zero modification, no event, candidate stays `approved`, throw `metabolism_relation_rollback_conflict` |
| false | absent  | no relation insert; write `m_rollback` (`relation_restored: false`, `restored: null`) so the no-op rollback is auditable; candidate → `rolled_back` |
| false | present | conflict: a relation with this id reappeared after cleanup; zero modification, no event, candidate stays `approved`, throw `metabolism_relation_rollback_conflict` |
| missing / malformed | any | fail closed: zero modification, no event, candidate stays `approved`, throw `metabolism_relation_rollback_snapshot_invalid` |
| any   | any | candidate status ≠ `approved` at commit CAS → return `null`, zero modification |

"Any row" for present means whatever currently holds the id — even an
identical row is a conflict (we cannot know who wrote it), except the row
this same batch just restored, which the success guard matches.

## 7. Atomic batch layout

One `commitMemoryCandidateRollback` call = one D1 batch = one transaction.
Statement order (relation-cleanup branch):

1. **S1 `m_rollback` event insert** (`INSERT ... SELECT ... WHERE`) —
   guarded by: candidate `approved` **AND** snapshot exists and is
   well-formed **AND** relation id currently absent (the only safe pre-state
   in both legal branches). The audit payload is composed from the snapshot
   row in SQL (`json_object(... json_extract(snapshot.payload_json, ...))`)
   so even the recorded audit derives from the snapshot, not from candidate
   payload.
2. **S2 relation restore insert** (`INSERT ... SELECT ... WHERE snapshot.row`) —
   values via `json_extract(snapshot.payload_json, '$.before.*')`; guarded
   by: candidate `approved` **AND** snapshot well-formed **AND**
   `relation_was_present = 1` **AND** relation id absent **AND** snapshot
   `before` identity equals the requested identity (value guard). On the
   `was_present = false` branch this writes zero rows by guard, which is
   correct and not an error.
3. **S3 candidate UPDATE → `rolled_back`** — the existing CAS, with
   `successGuard` = combine(`memoryEventExistsGuard(m_rollback)`, snapshot
   well-formed, **current-relation post-state**: (`was_present = 1` **AND**
   relation exists with full identity match) **XOR-branch** (`was_present =
   0` **AND** relation absent)).
4. **S4** existing five-axis run reconciliation (unchanged).

Why zero-row guards are atomic-safe: guards re-evaluate per statement inside
the single batch transaction with consistent visibility, so S1/S2's guards
and S3's success guard can only disagree if a *previous statement in the
same batch* changed the observed state — and those changes (event row,
restored relation) are exactly what the later guards require. Candidate
status cannot change mid-batch, so either every statement's guard passes and
all writes land, or the failing guard makes its statement write zero rows
and S3 commits 0 changes → `committed = false`. A raised exception (e.g.
trigger `RAISE(ABORT)`) rolls back the whole batch: no event, no relation,
no status flip — ever.

## 8. Post-commit diagnostics (reads allowed here, not decisions)

When `committed === false` for the relation branch, resolve the outcome in
this order:

1. candidate no longer `approved` → return `null` (concurrent status change;
   zero modification, as table row 6);
2. snapshot missing or malformed → throw
   `metabolism_relation_rollback_snapshot_invalid` (fail closed);
3. relation with the id currently exists → throw
   `metabolism_relation_rollback_conflict`;
4. otherwise return `null`.

New error identifier: `metabolism_relation_rollback_snapshot_invalid`.
Existing `metabolism_relation_rollback_conflict` is reused unchanged.

## 9. Tests (tests-worker/metabolism-relation-cleanup-actions.test.ts, new rollback describe; reuse `relationCleanupFixture`)

1. **present restore** — approve with relation present (snapshot true),
   assert approval deletes row; rollback restores the row with values
   identical to the snapshot `before` (not merely the candidate payload:
   mutate candidate payload `before.strength` between approve and rollback
   and assert the restored strength follows the snapshot); `m_rollback`
   event has `relation_restored: true`; candidate `rolled_back`.
2. **absent no resurrection** — delete the relation before approving
   (snapshot false); rollback inserts no `memory_relations` row, candidate →
   `rolled_back`, `m_rollback` event exists with `relation_restored: false`.
3. **false snapshot, relation reappears** — as (2), then re-insert a
   relation with the same id (different values) before rollback; rollback
   throws `metabolism_relation_rollback_conflict`, the existing row is
   untouched, candidate stays `approved`, `m_rollback` count is 0. Also
   assert the identical-reinsert case conflicts (true snapshot variant).
4. **missing snapshot fail closed** — approve, delete the `m_snapshot`
   event; rollback throws `metabolism_relation_rollback_snapshot_invalid`;
   relation absent stays absent, candidate stays `approved`, no event.
5. **malformed snapshot fail closed** — two cases: corrupt
   `relation_was_present` to a string; blank `before.id`. Both fail closed
   as in (4).
6. **concurrent candidate state** — candidate flipped to `rejected` (or
   `rolled_back`) before rollback: returns `null`, zero modification of
   relation/events/status.
7. **failure-injection atomicity** — trigger `RAISE(ABORT)` on the
   `rolled_back` status transition (pattern from
   z-m-axis-circuit.test.ts:432-446): rollback throws, relation row not
   inserted, `m_rollback` count 0, candidate stays `approved`. Plus
   guard-mismatch atomicity: on the conflict path (3), assert no partial
   `m_rollback` event survived even though S1 precedes S3.

The existing z-m-axis-circuit.ts:380-471 "removes and restores a reviewed
relation cleanup candidate" test stays green (snapshot true, absent → S2
restores; behavior identical).

## 10. Open / adjust points for implementation

- Restore-row `reason` is nullable; the S2 `json_extract` of a missing key
  yields NULL, which is acceptable for `reason` only — the value guard must
  still reject NULL `strength`/`created_at`.
- `relation_was_present` is written as JSON boolean; guards must compare
  `json_extract(...) = 1` and treat NULL/other as malformed, not as false.
- Longer-term the approval path could use a deterministic event id
  (`ev_m_snapshot_${candidate.id}`, as the m_archive branch already does);
  deliberately NOT done here — payload-keyed lookup keeps the approval diff
  at zero.
- `m_archive` rollback still restores from `candidate.before` with no
  snapshot consult; it does not share this bug class (archive snapshots are
  written under a success guard in one batch) but is the natural F12 audit
  candidate. Explicitly out of scope here — owner noted so it is not lost.
