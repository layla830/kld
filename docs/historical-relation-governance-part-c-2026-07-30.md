# Historical relation governance — Part C

- Date: 2026-07-30
- Baseline: `origin/main` at `519ad14`
- Phase: ledger schema applied; clean deletion dry-run complete; destructive
  batches pending explicit authorization
- Production writes completed: governance and deletion-ledger schemas plus 470
  immutable snapshot rows; no relation mutation

## Decision

Historical relation governance has two different problems and must not collapse
them into one DELETE queue:

1. relations touching an endpoint that is no longer five-axis eligible;
2. relations whose endpoints remain eligible but whose writer provenance cannot
   be proven.

The first group is inert in recall because frontier traversal applies the
shared eligibility predicate to both endpoints. It may later become a
snapshot-backed hygiene DELETE cohort.

The second group is live graph state. It must remain in place unless a separate
review proves a row-specific decision. Missing provenance is not evidence that
the relation is false, and this project will not write guessed prefixes into
`memory_relations.reason`.

## Current production baseline

Read-only audit generated at `2026-07-30T04:55:35.997Z`:

| Lifecycle cohort | Provenance detail | Rows | Phase-1 decision |
| --- | --- | ---: | --- |
| `stale_endpoint` | unproven | 468 | manifest; no delete |
| `stale_endpoint` | `legacy_backfill` | 2 | manifest; no delete |
| `eligible_unproven` | unproven | 1369 | retain; manifest for review |
| `eligible_proven` | known owner | 204 | outside debt manifest |

The mutually exclusive lifecycle totals are therefore:

- `stale_endpoint = 470`;
- `eligible_unproven = 1369`;
- `eligible_proven = 204`;
- all relations = `2043`.

## Phase-1 owner

`scripts/audit-historical-relations.mjs` is the only Phase-1 manifest owner.
It is SELECT-only and has no apply mode.

The script:

- reuses the shared five-axis endpoint eligibility contract;
- reuses one centralized relation provenance prefix contract;
- classifies every row into exactly one lifecycle cohort and exactly one
  provenance class;
- selects only `stale_endpoint` and `eligible_unproven` into the debt manifest;
- includes the complete `memory_relations` row plus endpoint lifecycle metadata,
  but never reads memory content, summaries, tags, or source messages;
- sorts rows by `(created_at, id)`;
- hashes the exact relation identity
  `(namespace, id, source, target, type, strength, reason, created_at)`;
- separately hashes endpoint eligibility inputs, lifecycle revisions, and the
  resulting cohort so a relation cannot remain byte-identical while silently
  moving out of the selected cohort;
- refuses duplicate identities, namespace drift, non-debt rows, and
  summary/manifest count mismatch;
- prints only counts and hashes unless an explicit local `--output` path is
  supplied.

Example:

```text
npm run audit:historical-relations -- \
  --remote \
  --namespace default \
  --output .audit/historical-relations-2026-07-30.json
```

The output file is local, gitignored evidence. It is not yet the durable
rollback snapshot.

## Repeatability evidence

Two independent remote, SELECT-only reads completed after the selection-state
hash was added:

| Generated at | Debt rows | `stale_endpoint` | `eligible_unproven` |
| --- | ---: | ---: | ---: |
| `2026-07-30T05:14:35.660Z` | 1839 | 470 | 1369 |
| `2026-07-30T05:15:15.213Z` | 1839 | 470 | 1369 |

Both manifests produced:

- relation identity SHA-256:
  `12228f99b61e50e932f5d025cc1ec90a56ff897ef7f8eaa37b3670ae11ad0951`;
- selection-state SHA-256:
  `1fe6e30bb35f4d3470a0d72e65af6f2f205c2dc01b141f5c970974170410565b`.

This satisfies the first read-only stability gate. It does not authorize a
snapshot write or DELETE.

The final two Phase-1 reads also produced stable per-cohort identities:

| Cohort | Rows | Manifest ID |
| --- | ---: | --- |
| `stale_endpoint` | 470 | `hrg_7fb07e6cc914c9e227bf118e6c138706` |
| `eligible_unproven` | 1369 | `hrg_acd903f8c2cc13e9494d105add28737e` |

## Durable snapshot home

The durable snapshot owner will be dedicated D1 governance tables, not
`memory_events`.

Reason:

- ordinary `memory_events` are subject to age retention;
- the current `m_snapshot` exemption is candidate-specific and should not grow
  another unrelated fallback branch;
- historical relation governance needs exact manifest identity, full-row
  snapshots, explicit lifecycle state, and readback verification under one
  owner;
- a local JSON file or Time Travel bookmark is useful supporting evidence but
  is not a durable row-level restore contract.

The Phase-2 schema is defined in
`migrations/20260730_historical_relation_governance.sql` and has been applied
to the remote D1 database. It owns:

- one immutable manifest identity and selection-contract version;
- expected relation count and SHA-256;
- one complete snapshot row per selected relation;
- snapshot verification state;
- bounded apply progress and rollback ownership;
- retention independent of generic event TTL.

The two dedicated tables are:

- `historical_relation_manifests`, which owns expected hashes, progress and
  lifecycle state;
- `historical_relation_snapshots`, which preserves exact relation rows and
  endpoint selection metadata without a foreign key back to the live relation.

Database triggers prevent manifest deletion, snapshot update/delete, expected
identity changes, and verification of an incomplete snapshot.

`scripts/snapshot-historical-relations.mjs` is the only snapshot writer. It:

- defaults to a read-only status check;
- requires the exact cohort `manifest_id` for `--apply` and `--verify`;
- writes at most 100 rows per invocation and never loops;
- revalidates every live relation and both endpoint revisions before insert;
- never updates or deletes `memory_relations` or `memories`;
- marks a manifest verified only after D1 readback reproduces the expected
  count, relation hash, and selection-state hash;
- recomputes the stored snapshot count from immutable snapshot rows during
  verification, so a batch-tail interruption cannot permanently strand an
  otherwise complete staging manifest.

The Worker-safe SQL owner is
`src/memory/historicalRelationSnapshotSql.js`. The CLI and Worker lifecycle
test import the same builders. The test executes the generated apply
statements through D1 `batch()`, then executes the generated verify statement,
including recovery from an intentionally stale manifest count. `created_at`
is audit metadata rather than part of the content-addressed manifest identity,
so regenerating an identical manifest does not conflict with its first-write
timestamp.

When the repository-installed Wrangler is too old for the current D1 import
API, operations may pin an exact official CLI package with
`HISTORICAL_RELATION_WRANGLER_FILE_PACKAGE=wrangler@x.y.z`. The override is
used only for the bounded `--file` snapshot batch; manifest queries and verify
continue through the repository-installed Wrangler. Arbitrary package names
and floating tags are rejected.

Remote schema rollout completed on 2026-07-30:

- Wrangler applied only
  `20260730_historical_relation_governance.sql`;
- two governance tables, two indexes, and five protection triggers exist;
- `historical_relation_manifests = 0`;
- `historical_relation_snapshots = 0`;
- the existing default-namespace relation count remains `2043`;
- the post-migration five-axis audit remains unchanged at
  `470 stale_endpoint + 1369 eligible_unproven`, with operational and vector
  sections clean;
- no migrations remain pending.

The authorized production snapshot rollout completed on 2026-07-30:

1. the default read-only preflight reported `0 / 470`, status `absent`;
2. five separately invoked batches wrote
   `100 + 100 + 100 + 100 + 70` immutable snapshot rows;
3. D1 readback reproduced the expected relation and selection hashes;
4. manifest `hrg_7fb07e6cc914c9e227bf118e6c138706` is `verified`;
5. the final read-only check reported one manifest, 470 snapshot rows, and
   `memory_relations = 2043`.

No relation row was deleted or updated. The deletion ledger migration is now
deployed; any actual relation deletion remains a separate destructive
authorization gate.

Operational note: repository Wrangler 4.85.0 could query D1 but its
`/d1/.../import` request failed OAuth authentication. The bounded `--file`
batches were therefore pinned to official Wrangler 4.115.0 through
`HISTORICAL_RELATION_WRANGLER_FILE_PACKAGE`; manifest queries and verify
continued through the repository Wrangler. A read-only SQL-file probe and all
five production batches passed the newer import path.

## Bounded-delete implementation and production preflight

The deletion command is implemented and tested. Its supporting schema is
deployed, but no delete batch has run.

`migrations/2026073001_historical_relation_delete_ledger.sql` adds one
immutable per-relation deletion ledger plus monotonic manifest progress. This
is required to distinguish a governance-owned delete from a relation that
another subsystem removed. A future rollback may restore only ledger-attributed
rows; snapshot absence alone is never sufficient ownership evidence.

`scripts/delete-historical-relations.mjs`:

- accepts only the exact `stale_endpoint` cohort;
- defaults to a read-only report;
- requires `--apply --confirm <exact manifest_id>` for a write;
- caps one invocation at 100 rows and never loops;
- requires the tested
  `HISTORICAL_RELATION_WRANGLER_FILE_PACKAGE=wrangler@4.115.0` import path for
  apply, rather than accepting an unverified file-execution version;
- rejects the whole apply when any snapshot row is drifted or missing without
  this governance ledger's attribution;
- inserts the immutable ledger row before an exact guarded relation delete;
- rechecks that the attributed deletion count increased by exactly the selected
  batch size;
- never updates `memories` and never rewrites a surviving relation.

If the post-apply attribution count does not increase by the selected batch
size, the command exits nonzero. Operators must treat that result as a
possibly partially committed bounded batch, rerun the default dry-run
diagnostics, and never retry blindly.

The SQL owner is `src/memory/historicalRelationDeleteSql.js`. The Worker test
executes its generated statements against D1, verifies deletion attribution,
replay safety, and endpoint-revision drift rejection. The local evidence is:

- bounded-delete command tests: 4 passed;
- bounded-delete Worker and ledger tests: 4 passed;
- full Worker suite: 31 files passed, 197 tests passed, 6 skipped;
- TypeScript check and JavaScript syntax check passed.

The full unit suite also retains four pre-existing Windows CLI import failures
(`SyntaxError: Invalid or unexpected token`); all 36 loadable files and 177
tests passed, including every new historical-governance unit test.

The row-level recovery path is implemented locally before any destructive
batch:

- `scripts/rollback-historical-relations.mjs` is default read-only, accepts
  only the same exact manifest and `stale_endpoint` cohort, restores at most
  100 ledger-attributed rows, never loops, and never overwrites an existing
  live relation identity;
- `migrations/2026073002_historical_relation_rollback_guards.sql` permits both
  full and partial-batch rollback while requiring every ledger row to have
  write-once `restored_at` evidence before the manifest can become
  `rolled_back`;
- Worker integration executes delete, exact restore, and replay against D1;
  targeted command tests are `6 / 6`, the complete Worker suite remains
  31 files passed with 197 tests passed and 6 skipped.

The independent Kimi read-only review initially found an asymmetric guard:
restore allowed an endpoint revision to change, while attribution still
required the old endpoint revision. The final implementation separates the
contracts:

- deletion requires exact relation fields plus exact endpoint selection state;
- rollback requires exact restored relation fields and only requires both
  endpoint rows to still exist.

The Worker test now changes an endpoint revision after delete, then proves
restore, attribution, `rolled_back`, and replay. Kimi's final verdict was
`APPROVE`, with no P0, P1, or P2 findings.

One accepted P3 remains: SQL-file import uses adjacent restore and attribution
statements. A theoretical interruption between them would leave an exact live
snapshot row with `restored_at IS NULL`; the command classifies that as a
conflict and stops for explicit attribution repair rather than guessing.

The rollback-guard migration is deployed and verified. It remains available
before and throughout every bounded production delete.

Production deletion-ledger rollout completed on 2026-07-30:

- exact CLI: official `wrangler@4.115.0` D1 file import;
- 11 migration statements completed successfully;
- because the SQL-file import API does not update Wrangler migration history,
  a guarded metadata-only insert recorded
  `2026073001_historical_relation_delete_ledger.sql` as migration ID `28`
  after verifying the ledger table and forward-only trigger existed;
- post-migration state:
  `memory_relations = 2043`, snapshots `= 470`, deletion ledger `= 0`,
  manifest status `verified`, attributed deletes `= 0`;
- D1 completion bookmark:
  `0000083a-000003f6-000050b8-2d35dc0f8e6c43fa14675ac254fb1582`,
  captured on 2026-07-30. D1 Time Travel retains restore points for 7 days on
  Workers Free and 30 days on Workers Paid; verify the account plan before
  relying on this finite emergency layer.

The production delete dry-run then reported:

- expected and immutable snapshot rows: `470 / 470`;
- safely deletable: `470`;
- drifted: `0`;
- missing without governance attribution: `0`;
- selected by the bounded first-batch window: `100`;
- changed rows: `0`.

The first destructive batch was not started: the execution approval layer
requires an explicit user statement authorizing deletion of the 470 live
relation rows. A post-rejection readback confirmed
`memory_relations = 2043`, ledger `= 0`, manifest `verified`.

A final read-only readiness pass at `2026-07-30T07:58:13.598Z` confirmed:

- the historical audit reproduced the same `1839 = 470 + 1369` debt rows,
  both cohort manifest IDs, and both aggregate SHA-256 values;
- snapshot status remained `470 / 470`, remaining `0`, status `verified`;
- rollback dry-run reached production successfully and reported ledger `0`,
  restored `0`, restorable `0`, conflict `0`, selected `0`, changed `0`.

A later production readback at `2026-07-30T16:01:33+08:00` again made no
changes and confirmed:

- `memory_relations = 2043`;
- manifest status `verified`, expected/snapshotted `470 / 470`,
  deleted `0`, rolled back `0`;
- deletion ledger `0`;
- rollback-guard migration `2026073002` still not deployed.

After the user returned and approved continuing within the clarified
470-relation scope, the production rollback gate completed at
`2026-07-30T17:51:49+08:00`:

- `wrangler@4.115.0 d1 migrations list --remote` showed exactly one pending
  migration:
  `2026073002_historical_relation_rollback_guards.sql`;
- `d1 migrations apply --remote` executed its three commands successfully;
- the migration-history row exists exactly once;
- the live trigger text contains both the partial-rollback count guard and
  the requirement that no deletion-ledger row remain unrestored;
- post-migration counts were unchanged:
  `memory_relations = 2043`, snapshots `= 470`, ledger `= 0`, manifest
  `verified`.

The immediately following first-batch dry-run again reported
`deletable = 470`, `drifted = 0`, `missing_unattributed = 0`,
`selected = 100`, `changed = 0`. The destructive process was rejected before
spawn because the execution safety layer requires a literal authorization
naming the exact manifest and batch plan.

The user then supplied that literal authorization, including permission to
read the existing local KLD credential only inside the recall-regression
process. Production batch 1 completed before the safety pause at
`2026-07-30T18:15:25+08:00`:

- batch ID `hrd_e2b114ceefd639232e1b7e699f435e63`, ordinal `1`;
- exactly 100 immutable ledger rows and 100 exact guarded deletes;
- `memory_relations: 2043 -> 1943`;
- manifest status `delete_in_progress`,
  `deleted_relation_count = 100`, `delete_batches_completed = 1`;
- remaining cohort state:
  `deletable = 370`, `drifted = 0`, `missing_unattributed = 0`.

The post-batch five-axis audit reproduced
`1739 = 370 stale_endpoint + 1369 eligible_unproven`; every operational
counter outside historical relation debt remained zero. Timeline origin
provenance remained valid at 120 rows.

Production recall initially timed out before reaching the Worker because the
Node process did not inherit the enabled Windows proxy. Re-running through
`http://127.0.0.1:7897` reached production and passed 5 of 6 cases. The only
failure, `says-this-kind-of-thing`, was stable on a second isolated run:
the candidate pool contained no `quote`, so post-processing could not make a
quote lead. The only batch-1 edge touching the returned top three was
`rel_107dd3866048429b8ce39760fd8053b8`, from an eligible lesson to an
ineligible diary. This does not prove the recall failure was caused by the
delete, and no pre-delete recall report exists to establish a baseline.

Batch 2 is intentionally paused. The next escalation attempt hit the Codex
automatic-approval usage limit, so no further production command or wmux
readback was attempted. The durable rollback path remains available while the
manifest is `delete_in_progress`:

```powershell
$env:HISTORICAL_RELATION_WRANGLER_FILE_PACKAGE='wrangler@4.115.0'
npm.cmd run rollback:historical-relations -- --remote `
  --manifest .audit\historical-relations-readonly-6.json `
  --cohort stale_endpoint --limit 100 --apply `
  --confirm hrg_7fb07e6cc914c9e227bf118e6c138706 --json
```

The read-only five-axis pre-delete audit found zero operational drift in axis
runs, candidates, vectors, deprojection, timeline membership/diary-day
integrity, and outbox state. Timeline provenance had 120 valid origin-diary
rows and every timeline drift counter was zero. Its
`clean=false` result is entirely the known historical relation debt:
`470 stale_endpoint + 1369 eligible_unproven`. The LMC-5 circuit audit passed
every circuit. The one-time coordinate backfill audit is not runnable because
`scripts/lmc5_coordinates.json` no longer exists in any current worktree; this
is recorded as no input rather than a passing production E-axis check. Live
recall is now connected and evidence is recorded above; its current result is
5/6 rather than a passing regression gate.

## What is and is not reprojected

Historical governance does not blindly rerun all five axes:

- `stale_endpoint` relations are relation hygiene. Their ineligible endpoint
  memories must not be re-enqueued into five-axis projection.
- `eligible_unproven` relations remain live. The Y-axis builder may later
  re-derive and compare them, but missing provenance alone is not permission
  to delete or rewrite them.
- X, E, Z, or M is rerun only for a row-specific coordinate or projection
  defect found by a separate audit.

## Required gates before any DELETE

1. Generate two independent read-only manifests and verify identical relation
   count and SHA-256.
2. Review and merge the dedicated snapshot schema, writer, and lifecycle
   tests.
3. Apply the schema separately; no relation rows change.
4. Snapshot one explicitly named cohort and verify count plus every exact row
   identity.
5. Obtain explicit authorization to delete the exact 470 live rows named by
   the verified manifest.
6. Apply and verify the rollback-guard migration; no relation rows change.
7. Delete only rows still byte-for-byte equivalent to their verified snapshot.
8. Execute five separately verified invocations (`100 + 100 + 100 + 100 + 70`)
   and re-run recall regression plus the full five-axis audit after each batch.

Cloudflare D1 Time Travel remains an emergency whole-database recovery layer.
It does not replace the row-level snapshot because its retention window is
finite and restore overwrites the live database. See the
[official D1 Time Travel documentation](https://developers.cloudflare.com/d1/reference/time-travel/).

## Deletion completion (Kimi handoff, 2026-07-30)

After the Codex usage-limit pause, the remaining four batches were completed
under the same verified manifest `hrg_7fb07e6cc914c9e227bf118e6c138706` with
explicit user authorization:

| Batch | ID | Rows | `attributed_deleted` after batch |
| --- | --- | ---: | ---: |
| 2 | `hrd_1928880601ea777f16af3ed17709535e` | 100 | 200 |
| 3 | `hrd_94351e7a1a19515ed68e6279f0584967` | 100 | 300 |
| 4 | `hrd_9f77c9d1e5ef23a31ff2966dc571f677` | 100 | 400 |
| 5 | `hrd_0cdc0d7770c7a4b9357712a9ddd0bcf7` | 70 | 470 |

Final state:

- manifest status `deleted`, ledger `470`, `delete_batches_completed = 5`,
  `drifted = 0`, `missing_unattributed = 0`, `deletable = 0`;
- `memory_relations: 2043 -> 1573` (`470` deleted, `1369 eligible_unproven`
  plus `204 eligible_proven` retained, as decided);
- final five-axis audit: `stale_endpoint = 0`, `drift_count = 1369`, entirely
  the deliberately retained `eligible_unproven` cohort; all operational
  sections zero;
- recall regression after every batch stayed at `5/6` with the same single
  pre-existing failure (`says-this-kind-of-thing`: no `quote` in the
  candidate pool), unchanged from the post-batch-1 profile;
- two transient Cloudflare OAuth `10000` failures (one audit, one batch-5
  preflight) were retried successfully; the failed batch-5 attempt aborted
  during the read-only overview query before any write.

The durable rollback path remains available: 470 immutable snapshot rows plus
470 ledger rows are intact, and the rollback-guard triggers are deployed. The
D1 Time Travel bookmark recorded above is subject to its finite retention
window.

## Explicitly out of scope

- no relation delete without explicit destructive authorization;
- no extraction of an API key from historical local config without explicit
  authorization;
- no additional production snapshot write in this stage;
- no guessed provenance;
- no fallback restore path;
- no change to recall traversal;
- no attempt to make `clean=true` by hiding historical debt from the audit.
