# Stale operational candidate supersession

## 1. Invariant

A pending operational review candidate must not survive after its recorded
snapshot or its scanner-defined family has been superseded.

The approval paths remain the final CAS boundary. They are not responsible for
cleaning stale queue state.

## 2. Scope

This change owns only:

- `y_relation_review`;
- `z_supersede`;
- `m_archive`.

It does not change Dream candidates, `timeline_date`, or
`m_relation_cleanup`.

The stable rejection reason is:

```text
superseded_by_newer_candidate_snapshot
```

Candidates are completed as `rejected`; rows are never deleted and no new
candidate status is introduced.

## 3. Two transitions, two explicit owners

### 3.1 Direct dependency snapshot invalidation

Owner: the memory mutation commit.

After a memory update wins its existing CAS, the same D1 transaction rejects
pending operational candidates that both:

1. declare that memory as a dependency; and
2. no longer match the post-update memory snapshot.

Action-specific matching is exact:

- Y compares the dependency endpoint against `source_revision` or
  `target_revision`, falling back to the recorded `updated_at` only for legacy
  payloads without revisions;
- Z compares the matching `best` or `weaker` snapshot `updated_at`;
- M compares `before.updated_at` for its target.

The candidate-linked axis run is reconciled in the same batch with the existing
`candidateReviewStatusSql()` rule.

This owner is necessary even when no replacement key can be generated. For
example, changing a Z dependency's `fact_key` removes the old fact family from
the next scan; scanner-only replacement cannot see that disappeared family.

### 3.2 Scanner family replacement

Owner: the scanner that has computed the current complete candidate set for one
semantic family.

The scanner upserts the current keys and rejects other pending keys in the same
family in one D1 batch:

- Y family: normalized `relation_type + source_id + target_id`;
- Z family: exact `payload_json.fact_key`;
- M family: `action + target_id`.

Family matching never parses `external_key` prefixes and never uses `LIKE`.
The current legal key set is excluded explicitly, so refreshing an unchanged
key does not reject it. Z replaces a whole fact-key set at once so multiple
legitimate weaker candidates cannot reject one another.

Z and M are deterministic scanners, so they also reconcile pending families
whose current legal set is empty. This closes cases where a Z conflict
disappears or an M target stops satisfying archive policy because a relation
was added without mutating the memory row.

Dry-run paths remain read-only.

## 4. Race behavior

- Scanner replacement updates only non-terminal candidate statuses.
- Approval updates only the expected pending candidate status.
- If approval wins first, scanner replacement cannot rewrite the terminal row.
- If supersession wins first, approval cannot commit.
- Candidate rejection and linked-run reconciliation are one D1 transaction.
- There is no recursive retry and no background stale-candidate sweeper.

## 5. Dependency completeness

Every Z candidate declares both endpoints:

- `best` as `source`;
- `weaker` as `target`.

This lets an eligibility transition or direct snapshot change on either endpoint
reach the same dependency owner.

## 6. Audit

Audit reports unique pending operational candidates whose live dependency
snapshot no longer matches:

```text
stale_operational_candidate_rows
```

It is the sole drift owner for this candidate-content mismatch. Existing
candidate-linked run fields remain diagnostics and must not double-count the
same defect in `drift_count`.

The audit also reports the action breakdown:

- `stale_y_relation_review_rows`;
- `stale_z_supersede_rows`;
- `stale_m_archive_rows`.

## 7. Required tests

1. Y endpoint revision advances: old key rejected, new key pending, unrelated
   pair untouched.
2. M target snapshot advances: old key rejected, current key pending.
3. Z ranking flips: the complete old set is rejected and the complete current
   set stays pending.
4. Z dependency changes `fact_key`: the old candidate is rejected even though
   the old family is absent from the next scan.
5. M target gains a relation: its no-longer-valid archive family is rejected.
6. Z candidate records both best and weaker dependencies.
7. Supersession reconciles linked `pending_review` runs.
8. Approved/rejected terminal candidates are never rewritten.
9. Dry-run performs no candidate write.
10. Audit counts each stale candidate once and the action breakdown sums to the
   unique total.
11. Dream and timeline candidates are unaffected.

## 8. Production

The read-only production count before implementation found no pending
operational candidates:

- `z_supersede`: one approved, zero pending;
- `y_relation_review`: six approved, one rejected, zero pending;
- `m_archive`: zero pending;
- `m_relation_cleanup`: zero pending.

Therefore this change has no production repair or apply step.
