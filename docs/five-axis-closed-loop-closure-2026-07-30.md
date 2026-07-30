# Five-axis closed-loop closure

- Date: 2026-07-30
- Runtime baseline: `origin/main` at `1c11d51` (`#108`)
- Scope: online five-axis lifecycle ownership, async state convergence, audit
  ownership, and the bounded historical repairs required to validate those
  owners.

## Outcome

The online five-axis closed loop is complete. The F1-F11 owner review has no
remaining runtime correctness gap:

- eligibility transitions have one lifecycle owner;
- stale axis runs, outbox deliveries, and operational candidates terminate
  through guarded state transitions;
- E/Y side effects carry revision guards at the write boundary;
- diary and timeline groups rebuild from their canonical owners;
- Vector reconciliation is scanner-owned and all production Vector drift is
  zero;
- retention hard-delete cascades owned rows and exposes historical orphans
  separately;
- relation-cleanup rollback reads one validated approval snapshot, live
  snapshots survive the generic event TTL, and a terminal candidate only
  suppresses the relation incarnation it actually reviewed;
- metabolism signal state is cleared atomically during deprojection;
- audit sections use a single drift owner rather than summing overlapping
  diagnostics.

The closing changes landed in:

- `#107` / `2631bbb`: preserve live relation rollback snapshots, clear
  metabolism signals on deprojection, and version relation-cleanup candidates
  by relation incarnation;
- `#108` / `1c11d51`: normalize the 111 legacy relation snapshots whose old
  writer contract implied `relation_was_present = true`.

## Production normalization

The legacy snapshot repair was deliberately bounded and manually advanced:

1. first apply: `changed = 100`, `remaining = 11`;
2. second apply: `changed = 11`, `remaining = 0`;
3. final dry-run: `legacy_missing_flag_rows = 0`, `repairable_rows = 0`, and
   every exclusion/anomaly counter was zero.

The repair changed only
`memory_events.payload_json.relation_was_present`. It did not modify
candidates, relations, memory state, revisions, timestamps, or schema.

## Final production audit

Read-only audit timestamp: `2026-07-30T03:50:14.316Z`.

The runtime-owned sections are clean:

| Section | Result |
| --- | --- |
| diary/timeline drift | 0 |
| five-axis outbox | 0 |
| axis-run drift and ownership anomalies | 0 |
| operational candidate drift | 0 |
| snapshot contract: missing / duplicate / malformed | 0 / 0 / 0 |
| Vector drift, failed, pending, and anomalies | 0 |
| deprojection drift and revision anomalies | 0 |
| actionable retention orphans | 0 |

The overall audit remains `clean = false`, `drift_count = 1839`, for two
intentional historical relation cohorts:

- 470 stale relations touching at least one currently ineligible endpoint;
- 1369 relations with eligible endpoints but no provenance prefix because they
  predate the provenance contract.

These rows are not evidence of a remaining online owner bug. Recall traversal
filters both relation endpoints by the shared eligibility predicate, so the 470
stale rows cannot bridge recall. The 1369 rows are historical attribution debt,
not a broken current writer.

The audit also reports 180 historical-only retention rows (91 candidate
dependencies, 83 candidates, and 6 events across 135 terminal candidates).
They are non-actionable history and are not counted as live retention orphans.

## Intentionally not changed

This closure did not:

- delete any of the 470 historical relations;
- label the 1369 legacy relations with guessed provenance;
- add reprojection, a full Vector rebuild, or a migration framework;
- add fallback restore paths or relax snapshot validation;
- add new database states or schema columns.

Historical relation deletion remains outside the bug-fix closure. It requires
a separate Part C decision, not another defensive runtime branch.

## Part C prerequisites

Before any historical relation DELETE is authorized:

1. choose a durable home and retention rule for general relation snapshots;
2. define a deterministic snapshot/readback contract for every selected row;
3. classify rebuildable, reviewed, and unproven relations without overlapping
   cohorts;
4. verify snapshot counts and identities in a read-only manifest;
5. obtain separate authorization for a bounded, non-looping apply;
6. re-run recall and full five-axis audits after each batch.

Until those conditions exist, the correct state is to keep the 470 rows and
keep their drift visible.

## Rollback and operational notes

- No destructive rollback was prepared or executed. If the 111 normalization
  ever has to be reversed, use Cloudflare D1 point-in-time recovery or an exact
  event-id manifest derived from the recorded legacy writer window; do not
  remove the field by a broad timestamp-only update.
- The local `src/generated/worker-configuration.d.ts` modification is a known
  CRLF working-tree phantom with an empty content diff and was not committed.
- Three unit suites still have pre-existing CRLF parse noise:
  `diary-origin-timeline-repair`, `inactive-five-axis-repair`, and
  `inactive-vector-repair`. Targeted suites, Worker tests, typecheck, and the
  LMC circuit tests passed for the closing code changes.

## Status

Online five-axis correctness work is closed. The only remaining work is an
explicitly deferred historical relation-governance project; it should begin
only when Part C snapshot semantics and deletion authority are agreed.
