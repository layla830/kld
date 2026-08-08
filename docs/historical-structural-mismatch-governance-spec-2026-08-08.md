# Historical Structural Mismatch Governance Spec (2026-08-08)

- Status: Codex-reviewed; implementation is included in the same worktree.
  No deploy, model call, or D1 write is authorized by this document.
- Base: `main` @ `1ca1d1b` (PR #120 v2 gate closure + PR #121 deterministic
  structural closure, merged).
- Verified manifest: `hrg_acd903f8c2cc13e9494d105add28737e`
  (`eligible_unproven`, status `verified`).
- Prior art: `docs/historical-relation-governance-part-c-2026-07-30.md`
  (§ Deterministic structural closure, lines 771–799),
  `docs/historical-y-reconfirmation-hardening-v2-spec-2026-08-02.md`.

## 1. Current facts (verified, not assumed)

- The manifest contains 26 structural relations: 8 `same_fact_key`, 18
  `in_thread`. All 26 were evaluated by deterministic dry-run from current
  endpoint fields, zero model calls, zero writes.
- 9 `in_thread` relations with equal non-empty current `thread` were promoted
  by apply batch `hyr_2df13585b407494c2da4526cd47184a8` (9 promoted, 0
  not_reconfirmed, 0 not_applied, `model_called: false`).
- The remaining 17 relations are deterministic mismatches and are live,
  untouched production rows:
  - 8 `same_fact_key`: current endpoint `fact_key` values are not equal;
  - 9 `in_thread`: current endpoint `thread` values are not equal.
- The 17 received no apply selection and no terminal reconfirmation ledger
  entry. Production `historical_relation_reconfirmation_batches` and
  `historical_relation_reconfirmation_entries` contain only the 9-row
  promotion batch above.
- The semantic Y/Flash stability gate failed (offset-99: 2/5 stable < 4/5;
  offset-792 probe: 1 of 3 requests `invalid_json`). Semantic sampling and
  all semantic apply remain frozen. This spec does not touch semantic
  relations and does not call any model.

## 2. Question 1 — delete, retype, or human queue?

**Conclusion: governed deletion, with snapshot-backed restorability. No
retype. No standing human queue table.**

Reasoning from the data model and ownership:

1. These edges are structural claims (`same_fact_key`, `in_thread`), defined
   in `src/memory/relationTypeRegistry.ts` as field-derived. A structural
   edge whose defining fields are currently unequal is a false claim. Its
   truth value is fully decidable from `memories.fact_key` / `memories.thread`
   without any judgment.
2. **Retype is forbidden by the freeze.** Any replacement type
   (`same_topic`, `same_issue`, …) is a semantic judgment. The model path is
   gated off, and a human-typed semantic edge would manufacture a new
   `unproven_source` (or worse, fake `human_reviewed`) provenance row —
   precisely what the provenance contract
   (`src/memory/relationProvenanceContract.js`) exists to prevent.
3. **A human review queue adds no information.** The mismatch determination
   is deterministic and re-verifiable at any time. The human decision point
   that actually matters — approving the exact 17 IDs for deletion — already
   exists in the operator approval step (selection file + fingerprint +
   explicit user authorization), same pattern as the 9-row promotion.
4. **Deletion is recoverable only through the immutable rollback snapshot.**
   The existing v2 structural promotion path requires the live relation row
   to still exist; it cannot recreate a deleted relation. If endpoint fields
   later become equal, creating a new structural edge belongs to a separate
   future deterministic builder. This is why rollback capability must ship
   and be verified before the first delete apply.
5. Ownership: these are legacy `unproven_source` rows. Runtime builders
   (Y/Dream) do not own historical cleanup; the operator governance CLI owns
   it, exactly as with the `stale_endpoint` deletion precedent.

## 3. Question 2 — can the existing snapshot/delete/rollback ledgers be reused?

**Partially. The storage layer (tables, triggers, status machine) is reusable
with zero migration. The existing public stale-endpoint commands remain
unchanged. A policy-specific SQL layer owns the structural mismatch predicate,
while shared exact-row helpers remain the single source of truth.**

Reusable without migration:

- `historical_relation_manifests` / `historical_relation_snapshots`
  (`migrations/20260730_historical_relation_governance.sql`): the
  `lifecycle_cohort` CHECK already allows `'eligible_unproven'` (lines 4–6,
  71–73); the status machine
  (`staging → verified → delete_in_progress → deleted/rolled_back`) and all
  immutability/audit triggers are cohort-agnostic.
- `historical_relation_deletions` ledger
  (`migrations/2026073001_historical_relation_delete_ledger.sql`): generic
  per `(manifest_id, relation_id)`, FK to snapshots, immutable triggers,
  delete-progress triggers — all reusable.
- The snapshot CLI (`scripts/snapshot-historical-relations.mjs`) already
  accepts `--cohort eligible_unproven` (line 40) and can stage, snapshot,
  and verify a new dedicated manifest.
- `exactLiveRelationExists` byte-equality guards
  (`src/memory/historicalRelationDeleteSql.js:28-59`): relation row +
  endpoint status/type/updated_at/five_axis_revision equality — exactly the
  drift fail-closed semantics we need, verbatim.

Blockers to direct reuse (must NOT be relaxed in place):

- CLI cohort guard: `scripts/delete-historical-relations.mjs:83-85`
  (`--cohort must be stale_endpoint`) and `:136-138`
  (`historical_relation_delete_cohort_forbidden`); same in
  `scripts/rollback-historical-relations.mjs:82-84`.
- SQL cohort hardcodes: `historicalRelationDeleteSql.js:86-90, 113-117,
  163-167, 231-235`; `historicalRelationRollbackSql.js:66`.
- The stale-endpoint *predicate* is hardcoded into the queries:
  `(source_eligible = 0 OR target_eligible = 0)`. Our 17 rows have eligible
  endpoints; their predicate is different (structural field inequality,
  re-derived live). Reusing the queries would select zero rows — or, if
  edited in place, would weaken the proven stale_endpoint guards.
- Batch size: existing delete allows up to 100; this spec mandates 10 (two
  production batches: 10 + 7).

**Forbidden shortcut — do not point any delete flow at
`hrg_acd903f8c2cc13e9494d105add28737e` itself:**

- The delete batch SQL transitions the manifest
  `verified → delete_in_progress → deleted`
  (`historicalRelationDeleteSql.js:231-269`), and `deleted` requires
  `deleted_relation_count = expected_relation_count` (1369). The reconfirmation
  worker requires this exact manifest to stay `status = 'verified'`
  (`src/memory/historicalYReconfirmation.ts:263-267, 486, 555`). Hijacking
  the shared manifest's lifecycle would break the reconfirmation pipeline
  and stall the manifest mid-machine. The 17 rows need their **own
  dedicated 17-relation manifest** with its own lifecycle.
- Do not route the 17 through reconfirmation apply either: a mismatch there
  writes a terminal `not_reconfirmed` entry, burning the one-shot
  `UNIQUE(manifest_id, relation_id)` slot
  (`migrations/20260802_historical_y_reconfirmation.sql:35`) for zero
  benefit. They were deliberately excluded from apply for this reason.

**Migration needed: none.** All required tables, CHECKs, and triggers
already accommodate a second `eligible_unproven` manifest (manifest identity
is content-hashed, so a 17-row manifest gets a new `manifest_id`;
`UNIQUE(manifest_id, namespace, lifecycle_cohort)` is satisfied). The 17
relations remain snapshotted under the big manifest as immutable historical
evidence — snapshot PK is `(manifest_id, relation_id)`, so double-coverage
is legal.

## 4. Question 3 — minimal implementation

Four pieces, all CLI/SQL-side, no Worker changes, no runtime changes:

### 4.1 Read-only manifest builder (new, small)

A small script (or a `--relation-ids` mode on the existing read-only
governance script) that:

- takes an explicit relation-ID list (the 17 IDs recorded in
  `.audit/structural-dry-run-selection-2026-08-08*.json` dry-run reports);
- runs one bounded read-only D1 query for those IDs plus endpoint
  eligibility/status/type/updated_at/five_axis_revision;
- emits a Phase-1-style manifest JSON through the existing
  `buildHistoricalRelationManifest` (`scripts/historical-relation-governance.mjs`),
  so all hashes (`relations_sha256`, `selection_sha256`, cohort
  `manifest_id`) are computed by the same code path as before;
- writes the artifact only to gitignored `.audit/`.

### 4.2 Snapshot + verify (existing tooling, unchanged)

`npm run snapshot:historical-relations -- --remote --manifest <17-row.json>
--cohort eligible_unproven --apply --confirm <new_manifest_id>` then
`--verify --confirm <new_manifest_id>`. Bounded (17 ≤ 100), idempotent,
produces an immutable verified snapshot. This is the same flow already used
for both existing cohorts.

### 4.3 Sibling mismatch-delete CLI + SQL builder (new files)

New sibling module pair — do NOT edit the stale_endpoint builders:

- `src/memory/historicalStructuralMismatchDeleteSql.js`
- `scripts/delete-historical-structural-mismatch.mjs`

Contract:

- **Default dry-run, zero writes.** `--apply` requires all of:
  `--confirm <new_manifest_id>`, a manifest-guarded selection file
  (`schema_version`, `manifest_id`, `relation_ids`, optional
  `batch_sha256`), and `--approve-selection <selection_sha256>` — the same
  fingerprint pattern as the reconfirmation CLI
  (`scripts/reconfirm-historical-y-relations.mjs`), so "user explicitly
  approved this exact ID set" is machine-checked.
- **Selection-only.** No offset/limit cohort sweeping. IDs not in the
  manifest, duplicated, or not structural mismatch → error before any SQL.
- **Dedicated-manifest shape.** Every row in the supplied manifest must be an
  eligible unproven `same_fact_key`/`in_thread` candidate and the manifest may
  contain at most 100 rows. This rejects the shared 1369-row manifest in the
  plan loader before any remote query and protects its `verified` lifecycle.
- **Batch cap 10.** Production execution is at most two batches (10 + 7).
  One command = one bounded SQL file = never loops.
- **Pre-apply re-verification (per batch, fail-closed as a whole):**
  1. remote manifest identity matches the descriptor field-for-field
     (existing `assertDeleteManifestState` pattern);
  2. every selected row still satisfies `exactLiveRelationExists` —
     byte-equal relation row and endpoint
     status/type/updated_at/five_axis_revision;
  3. every selected row's endpoints are still eligible
     (`source_eligible = 1 AND target_eligible = 1` in snapshot, and live
     endpoints still active);
  4. **the mismatch is re-derived live**: for `same_fact_key`, current
     `memories.fact_key` of both endpoints are non-null-or-unequal (i.e.
     NOT (both non-null AND equal)); for `in_thread`, same for `thread`.
     If any pair's fields have since become equal, the relation is no longer
     a mismatch: the whole batch aborts and reports that relation ID as
     `now_confirmable`. It does not invoke another write path.
  5. Any drift in (1)–(4), any missing live row, any pre-existing
     unattributed deletion → abort the entire batch, zero writes, distinct
     error codes per failure class.
- **Atomic batch SQL** mirroring the proven shape
  (`buildHistoricalRelationDeleteBatchStatements`): transition
  `verified → delete_in_progress`, per-row `INSERT OR IGNORE` ledger row +
  guarded exact-match `DELETE`, then counter updates, and
  `delete_in_progress → deleted` only when
  `deleted_relation_count = expected_relation_count` (17). All per-row
  statements keep their guards inside SQL so a partial commit is
  detectable, not silent.
- **No LLM anywhere. No memory content read or emitted.** Reports carry
  relation IDs, relation type, field-equality booleans, hashes, counts —
  never `content`, never `fact_key`/`thread` raw values (same privacy
  boundary as the v2 structural evidence hash, spec P1).
- Post-apply readback: re-run the overview classification
  (`attributed_deleted / missing_unattributed / drifted / deletable`) and
  assert `attributed_deleted` advanced by exactly the batch size; mismatch
  → error instructing dry-run diagnosis, never blind retry (same wording
  as the existing delete CLI).

### 4.4 Sibling rollback (same PR)

`scripts/rollback-historical-structural-mismatch.mjs` + SQL sibling of
`historicalRelationRollbackSql.js`, restoring only ledger-attributed rows
from the immutable snapshot, refusing to overwrite any live relation
identity (conflict → abort). Rollback capability must exist **before** the
first apply, not be deferred.

## 5. Question 4 — audit attribution, idempotency, readback, rollback boundary

- **Attribution:** every deleted row has a durable
  `historical_relation_deletions` entry `(new_manifest_id, relation_id,
  batch_id hrd_…, batch_ordinal, deleted_at)` inserted in the same atomic
  batch as the guarded `DELETE`; the `DELETE` itself requires the ledger
  row to exist (existing pattern, `historicalRelationDeleteSql.js:211-217`).
  Nothing is deletable without attribution; nothing is attributable without
  the exact live row.
- **Idempotency / replay:** re-running the same apply is safe by
  construction — `INSERT OR IGNORE` on the ledger, exact-match `DELETE`
  matches zero rows once deleted, and the overview classifies the row as
  `attributed_deleted`. The CLI's pre/post assertions turn a replay into a
  clean no-op report, not an error.
- **Readback verification:** after each batch, the CLI re-queries manifest
  state and overview; after the second batch the manifest must reach
  `status = 'deleted'` with `deleted_relation_count = 17`, and a direct
  read-only count of the 17 IDs in `memory_relations` must be 0. Results
  archived in `.audit/`.
- **Rollback boundary:** restores only rows with a ledger entry for this
  manifest, only from the immutable snapshot row, only when no conflicting
  live relation identity exists; sets `restored_at` and the manifest
  `rolled_back` status per the existing triggers. Rollback never touches
  the 9 promoted relations (different manifest, different ledger) and
  never touches the big manifest. After a rollback, re-deletion is a fresh
  governed flow with a fresh approval, not a replay flag.
- **Interaction with the big manifest:** after deletion, the 17 IDs are
  permanently excluded from any future reconfirmation selection. If one is
  ever submitted, the reconfirmation worker's drift checks fail closed
  (live row gone) — desired behavior; the runbook should note this.

## 6. Question 5 — minimal tests

Only what protects the production write boundary. Node-side unit/CLI tests
(the delete/rollback pipelines execute via the wrangler file runtime, no
Worker), following the existing
`tests/historical-relation-rollback-command.test.ts` fixture style:

1. **Mismatch predicate** — SQL builder emits the live field-inequality
   re-check per relation type; a relation whose fields are now equal is
   rejected (`now_confirmable` class) and aborts the batch.
2. **Fail-closed drift** — mocked executor where one row fails
   `exactLiveRelationExists` (or endpoint revision/eligibility drift) →
   apply throws before `execute.file`, zero SQL emitted.
3. **Selection + approval contract** — dry-run default; `--apply` without
   `--confirm`, without selection file, or with wrong
   `--approve-selection` fingerprint each rejected; non-manifest ID
   rejected; batch size > 10 rejected.
4. **Idempotent replay** — executor returning `attributed_deleted` for the
   same IDs on second apply → no-op report, no second SQL batch.
5. **Rollback guard** — restore refused when a conflicting live identity
   exists; manifest status machine respected (`rolled_back` terminal).

Explicitly out of scope: full-cohort regression re-runs, re-testing hash
computation (covered by snapshot pipeline tests), Worker integration
tests (no Worker code changes), any refactor of the stale_endpoint
builders.

## 7. Execution order (after Codex review + user approval)

1. Tests first (§6), then implementation PR (CLI + 2 SQL sibling modules +
   runbook section shipped in-PR), human review, merge, no deploy needed
   (operator CLI only).
2. Generate the 17-row manifest (read-only), snapshot, verify — one
   bounded write to governance tables, no `memory_relations` change.
3. Dry-run batch 1 (IDs 1–10) → operator reviews report → explicit user
   approval naming manifest ID + selection fingerprint → apply batch 1 →
   readback.
4. Same for batch 2 (IDs 11–17). Manifest reaches `deleted`.
5. Archive all reports in `.audit/`; update the part-c governance doc with
   the closure record (batch IDs, fingerprints, readback counts).

## 8. Open questions for Codex

1. **Resolved: policy ownership.** Keep the stale-endpoint public builders
   and guards unchanged. Reuse their exact-row primitives, and put the new
   cohort/predicate in a structural-mismatch-specific layer. Do not create a
   broadly configurable operator escape hatch.
2. **Resolved: manifest builder shape.** Add a permanent explicit-ID,
   read-only manifest command. It is reproducible and emits only the normal
   snapshot fields, never raw `fact_key` or `thread` values.
3. **Resolved: `now_confirmable`.** Abort the whole selected batch and report
   the affected IDs. Do not automatically route or write them elsewhere.

No other disputes identified — otherwise: none.

## 9. Non-goals

- No model calls, no semantic relations, no touching the frozen semantic
  gate.
- No retype, no human queue table, no migration.
- No edits to stale_endpoint delete/rollback builders, their CLI guards,
  or the reconfirmation writer/worker.
- No changes to `memoryRelations.ts` normalization, Dream/Y paths,
  `wrangler.toml`, or runtime behavior.
- No re-running the completed 26-relation dry-runs; no full-cohort
  (1095/1369) operations of any kind.
- No deletion of the 9 promoted relations' history; the big manifest and
  its snapshots remain immutable evidence.
