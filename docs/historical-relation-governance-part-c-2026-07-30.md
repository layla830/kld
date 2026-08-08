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

## Post-completion follow-ups (Kimi (modal), 2026-07-31)

Code landing:

- PR #110 merged into `main` at `fd7e484` (merge commit, 2026-07-31): the
  full governance toolchain (three deployed migrations, audit / snapshot /
  delete / rollback commands, shared provenance contract, nine test files,
  this handoff) is now durable on `main`. Rollback capability no longer
  depends on any local worktree or feature branch surviving.
- Pre-merge verification re-run: unit 179 passed (only the four pre-existing
  Windows import failures), Worker 31 files / 197 passed / 6 skipped,
  `tsc --noEmit` clean.

Windows CLI import noise root-caused and fixed (PR #111, head `cbd1213`,
merged into `main` as `c53dd19`):

- Not a CRLF parsing issue per se: vitest inlines project modules through
  `vm.Script`, which honors a shebang only at byte 0. CRLF defeats the
  pipeline's own shebang stripping, so `#!/usr/bin/env node` survived into
  the evaluated source below the injected SSR preamble. LF checkouts mask it,
  which is why the newer LF-era scripts never failed.
- Fix: `*.mjs text eol=lf` in `.gitattributes` (same idiom as the existing
  `ops/vps/*.py` pin); shebangs kept; local CRLF files normalized with no
  index content change.
- Unit suite is now fully green: 41 files / 193 tests passed; Worker suite
  unchanged (197 passed, 6 skipped).

Recall regression failure (`says-this-kind-of-thing`) investigated via
read-only production probes — no pipeline bug:

- entry lanes into the merged candidate pool are vector / keyword / fact-key
  hint / relation expansion; the paraphrase satisfied none of them;
- zero of all 259 quote rows (any status) lexically match the query terms;
  quotes carry no fact_keys; all 84 active quotes are
  `vector_sync_status=synced`; 248 relations still touch active quotes;
- no pre-deletion baseline ever existed, and the deletion only touched
  ineligible endpoints. Expectation was simply unsatisfiable against real
  data.
- Case replaced with a literal-anchored utterance query
  (`她那句「比骂我疼」的原话怎么说`): the quoted segment enters the pool
  through the literal channel as a protected hit, then `applyLead` hoists the
  quote (`mem_4aad46baaf264787ae16c32edadee274`, active + synced).
- Full regression against production: 6/6. PR #112 also asserts the exact
  target ID (`mem_4aad46baaf264787ae16c32edadee274`) so another quote cannot
  produce a false pass; merged into `main` as `80ae48a` on 2026-08-01.

Open items handed forward:

- 174 quote records bulk-created in `review` status on 2026-07-10 (diary
  re-import era) were never re-approved; roughly two thirds of the quote
  corpus is recall-excluded with vectors deleted. Needs a product decision.
- The `eligible_unproven` cohort (1369) remains deliberately retained under
  the Part C decision; a separate review phase is still its only exit.
- D1 Time Travel bookmark of 2026-07-30: account is Workers Free (user
  confirmed), so the retention window lapses around 2026-08-06. Row-level
  rollback (470 snapshots + 470 ledger rows + guard triggers) is unaffected.
- Housekeeping pending: merged branches
  (`agent/historical-relation-governance`, `agent/windows-mjs-shebang-eol`)
  and the local worktree still to be cleaned up.

— Kimi (modal), 2026-07-31

## Eligible-unproven Y reconfirmation runbook (2026-08-02)

The follow-up reconfirmation path is intentionally separate from the ordinary
five-axis outbox. It does not bump memory revisions, reset terminal
`memory_five_axis_runs`, run vector Top-K candidate discovery, or permit Y to
create a relation outside the selected historical manifest rows.

Ownership boundaries:

- `scripts/reconfirm-historical-y-relations.mjs` is the only operator driver;
- the server-owned `HISTORICAL_Y_RECONFIRM_MODEL` selects the review model, so
  historical batches can use Flash without changing normal Dream or Y-axis runs;
- `POST /v1/debug/historical_y_reconfirmation` is the only Worker entry;
- one request contains 1-10 exact relation IDs and never loops;
- only `eligible_unproven` snapshot rows with a Y-safe relation type are
  accepted;
- `temporal_sequence` remains X-owned, while `contradicts`, `cause_effect`,
  and `supports` remain review-owned;
- a safe relation is promoted only when Y independently returns the same
  pair and the same relation type;
- the #114 conflict promotion preserves relation ID, strength, and
  `created_at`, and appends the old semantic reason after `previous_reason:`;
- non-canonical symmetric pairs fail closed so reconfirmation cannot insert a
  normalized reverse duplicate.

The schema migration
`migrations/20260802_historical_y_reconfirmation.sql` adds immutable batch and
per-relation ledger tables. Apply this migration separately before calling the
new endpoint. A Worker deployment does not by itself prove that the D1
migration has run.

Required production sequence:

1. Generate a fresh read-only historical relation manifest.
2. Snapshot and verify the complete `eligible_unproven` cohort with the
   existing snapshot command. The Worker accepts only a fully verified
   manifest whose verified hashes and row count still match.
3. Apply and verify the reconfirmation-ledger migration under separate
   production authorization.
4. Deploy the reviewed Worker and CLI code.
5. Put the credential in the process environment only; never pass it as a CLI
   argument or write it into a report:

   ```powershell
   $env:KLD_API_KEY = '<memory:write key>'
   ```

6. Run exactly one dry-run batch. This calls the real Y model but writes
   nothing:

   ```powershell
   npm.cmd run reconfirm:historical-y -- --remote `
     --manifest .audit\historical-relations-post-pr115-2026-08-02.json `
     --offset 0 --limit 5 --json
   ```

   The report distinguishes `exact_match`, `type_changed`, `none_returned`,
   `missing_pair`, `structural_confirmed`, `structural_mismatch`, and
   `structural_skipped`, flags provenance claims and `direction_sensitive`
   directed types, and includes the bounded endpoint excerpts actually reviewed
   by the model. Reports therefore contain memory content and must remain in
   gitignored `.audit/` storage.

   Each response also carries a compact `attempts` array (per model call:
   `attempt_index`, `model`, `batch_id`, `http_status`, `elapsed_ms`,
   `finish_reason`, whitelisted `usage` tokens, `content_chars`,
   `reasoning_chars`, `parse_outcome`) and `model_called: boolean`. An
   all-structural batch (`in_thread`, `same_fact_key`) makes zero model calls
   and returns `attempts: []`, `model_called: false`. On model failure the 502
   body is `{ error, details: { attempts } }`; the `parse_outcome` taxonomy in
   `details.attempts` identifies the failure class. On failure the CLI echoes
   `historical_y_worker_error_details:{...}` to stderr before exiting non-zero,
   so capturing stderr alongside the report preserves the autopsy telemetry.

7. Review the dry-run rows offline. Put only the explicitly approved relation
   IDs in a local selection file; do not add `--offset` or `--limit` when using
   `--selection`:

   A dry-run report containing any `missing_pair` is not eligible for apply:
   never include that relation ID in an approved selection. Investigate the
   model omission and run a fresh dry-run before considering it again.

   ```json
   {
     "schema_version": 2,
     "manifest_id": "<eligible_unproven_manifest_id>",
     "relation_ids": ["<approved_relation_id>"]
   }
   ```

   Preview that exact selection once. The CLI outputs its canonical
   `batch_sha256` and still writes nothing:

   ```powershell
   npm.cmd run reconfirm:historical-y -- --remote `
     --manifest .audit\historical-relations-post-pr115-2026-08-02.json `
     --selection .audit\historical-y-approved-selection.json --json
   ```

   Only after separate user authorization naming both the manifest and the
   returned hash may the exact selection be applied:

   ```powershell
   npm.cmd run reconfirm:historical-y -- --remote `
     --manifest .audit\historical-relations-post-pr115-2026-08-02.json `
     --selection .audit\historical-y-approved-selection.json --apply `
     --confirm <eligible_unproven_manifest_id> `
     --approve-selection <batch_sha256> --json
   ```

   Unselected offset/limit apply is rejected by the CLI. Apply stays
   single-call and remains forbidden until the stability gate (below) passes.
   The apply ledger is the durable source of truth; `after_reason` stores
   either `y:auto:` provenance (semantic exact-match) or
   `historical-structural:<type>:<hash>` provenance (structural promotion).

8. Re-run the historical relation audit after each approved batch. The
   expected signal is a decrease in `eligible_unproven` equal to the ledger's
   `promoted` count; `stale_endpoint` must remain zero.

Every apply revalidates the immutable snapshot, the current relation identity,
both endpoint states, both endpoint revisions, and the exact manifest
confirmation. Any drift rejects the batch before the model or before mutation.
The content-addressed batch ID and `UNIQUE(manifest_id, relation_id)` make an
apply replay idempotent and prevent repeated model sampling from being used to
fish for a desired confirmation.

Every apply ledger outcome is terminal for that relation under the same
manifest, including `not_applied`. Operators must never edit or delete the
immutable ledger to retry it. If a `not_applied` relation remains unproven and
still needs reconsideration, generate a fresh audit manifest, snapshot and
verify its new cohort, and use the new manifest ID; if another producer already
promoted it, the fresh audit will classify it as proven instead.

Dry-run is advisory rather than a frozen model decision: apply invokes the
model again for the same exact relation IDs, so its decision can differ even
at temperature zero. The apply ledger is the durable source of truth.

There is deliberately no automatic promotion rollback command in this phase.
The immutable ledger stores `before_reason` and `after_reason`, while the
relation itself preserves the old semantic reason. Restoring provenance would
therefore be possible, but it must be implemented and reviewed as a separate,
manifest-guarded repair rather than as an unguarded UPDATE. D1 Time Travel
remains the emergency whole-database recovery layer.

### v2 hardening (2026-08-02): structural types, strict parser, telemetry

Schema version bumped to 2. All v1 batch IDs, selection-file hashes, and
approval hashes are invalid for v2 (production ledger is empty, so zero
cost). No migration needed; old code cannot replay into v2 semantics.

Structural relation types (`in_thread`, `same_fact_key`) are decided
deterministically from record fields, never by the model:

- both `fact_key` non-null and equal → `structural_confirmed` (promoted);
- both `thread` non-null and equal → `structural_confirmed` (promoted);
- otherwise → `structural_mismatch` (not reconfirmed);
- `origin_split` is excluded from the candidate set this round
  (symmetric-set conflict with `SYMMETRIC_RELATION_TYPES` —
  reverse-duplicate risk must be audited first). It is not offered to the
  CLI or selection files, and the worker rejects its relation IDs with
  409 `historical_y_relation_type_not_reconfirmable` before any ledger
  write, so its one-shot outcome cannot be burned. Plans report the count
  as `skipped_origin_split`.

Structural promotions write `historical-structural:<type>:<evidence_sha256>`
provenance (classified `deterministic_rebuildable`), never `y:auto:`. The
evidence hash covers field names, IDs, and revision numbers only — never raw
`thread`/`fact_key` values. Semantic (model) promotions keep `y:auto:`.

The model prompt bans the three structural types and adds the `instance_of`
direction rule (source A is a concrete instance of target B's concept).
`derived_from` evidence rules are unchanged.

The parser is strict: out-of-vocabulary type, duplicate `pair_id`, unknown
`pair_id`, malformed hint (missing/non-string fields, non-`none` without
explicit numeric `strength`) → attempt failure. Two consecutive failures →
502 with zero writes. `missing_pair` is reserved for an otherwise valid
response that omits a known requested `pair_id`. The silent `strength: 0.6`
default is removed.

Dry-run entries carry `field_evidence` (`{fact_key_equal, thread_equal}`,
`null` when not applicable) so structural decisions show their boolean
evidence in the report rather than only implicitly via `change_kind`.

### Stability gate (before any new sample or apply)

Before running a new 60-relation stratified sample or any apply, the same
small window (e.g. offset 99, limit 5) is run **three times** as separate
dry-run CLI invocations. Pass requires ALL of:

1. 3/3 Worker requests ultimately succeed;
2. at least 2/3 succeed on the first model attempt;
3. at least 4 of 5 pairs receive an identical type in 3/3 runs;
4. every pair whose type is directed (in any run) is self-consistent across
   3/3 runs;
5. zero structural-type out-of-vocabulary outputs across all attempts;
6. final reports contain zero `missing_pair` and zero directed-type flips.

Gate results are recorded in `.audit/`. No apply and no new sample without a
passed gate and explicit user approval.

#### Recorded v2 gate outcome (2026-08-02 to 2026-08-03)

The post-deployment offset-99, limit-5 gate failed. All three requests
succeeded on their first model attempt, but only 2 of 5 pairs received an
identical type in all three runs; the contract requires at least 4 of 5.
There were no `missing_pair`, structural out-of-vocabulary, or directed-flip
failures. Historical semantic Y sampling and all apply operations remain
stopped.

One additional offset-792 dry-run probe was run after the failed gate. Two
requests succeeded and one returned `invalid_json`; all were zero-write. This
probe was out of sequence and does not reopen the gate. PR #119 fixed the CLI
so future non-2xx captures retain the Worker's structured failure telemetry.
A production read-only check on 2026-08-08 confirmed zero reconfirmation batch
rows and zero reconfirmation entry rows.

#### Deterministic structural closure (2026-08-08)

The verified `eligible_unproven` manifest
`hrg_acd903f8c2cc13e9494d105add28737e` contained 26 structural relations:
8 `same_fact_key` and 18 `in_thread`. Bounded dry-runs evaluated all 26 from
current endpoint fields with zero model calls and zero writes:

- all 8 `same_fact_key` relations had unequal current `fact_key` values and
  were left unchanged;
- 9 `in_thread` relations had equal non-empty current `thread` values and
  were selected for promotion;
- the other 9 `in_thread` relations had unequal current `thread` values and
  were left unchanged.

After explicit approval of manifest and selection SHA-256, one production
apply promoted the 9 confirmed `in_thread` relations atomically:

- batch ID: `hyr_2df13585b407494c2da4526cd47184a8`;
- selection SHA-256:
  `2df13585b407494c2da4526cd47184a87950aa2ca116024e669ffbbd0f74d9fe`;
- result: 9 `promoted`, 0 `not_reconfirmed`, 0 `not_applied`;
- `model_called: false`, `attempts: []`;
- the apply response's ledger readback returned all 9 promoted entries.

Each promoted relation now carries `historical-structural:in_thread:<hash>`
provenance and preserves its prior reason via the existing
`|previous_reason:` suffix. The 17 mismatches were not included in the apply
selection and received no terminal ledger entry. Semantic Y sampling and
semantic apply remain stopped because the v2 model stability gate failed.
