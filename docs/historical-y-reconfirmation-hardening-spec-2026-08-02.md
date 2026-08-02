# Historical Y reconfirmation hardening spec

- Date: 2026-08-02
- Status: Codex-reviewed with amendments; local implementation authorized,
  but no commit, deploy, model calls, or D1 changes are authorized by this spec
- Scope: harden the merged historical Y reconfirmation pipeline (PR #115,
  PR #116) before any production apply
- Production manifest: `hrg_acd903f8c2cc13e9494d105add28737e`
  (`eligible_unproven`, verified)
- Cohort sizes: 1369 `eligible_unproven` total, 1095 Y-reconfirmable
- First-10 dry-run evidence: 4 `would_promote`, 6 `not_reconfirmed`;
  `invalid_json` twice at batch size 10; succeeded as 1+3+3+3; production
  readback confirmed batch ledger = 0, entry ledger = 0, rows written = 0

This spec was written after re-reading the merged source. All file/line
references below were verified against the `agent/historical-y-flash` worktree
at `03cdcda` on top of the PR #115/#116 merge state (`origin/main` `5913056`).

## Verified current behavior (grounding for every section)

- CLI `scripts/reconfirm-historical-y-relations.mjs`:
  - `DEFAULT_LIMIT = 10`, `MAX_LIMIT = 10` (lines 17-18), enforced at lines
    74-76;
  - exactly one Worker POST per invocation, documented "never loops"
    (lines 36-37, single fetch at lines 161-174);
  - `--apply` requires `--confirm <exact manifest_id>` (lines 144-147);
  - plan = contiguous `slice(offset, offset + limit)` over manifest-ordered
    reconfirmable candidates (lines 116-141); there is no explicit-ID or
    selection-file input today;
  - the Worker-returned `batch_id` must equal the locally computed
    content-addressed ID or the command fails (lines 186-188).
- Writer `src/memory/historicalYReconfirmation.ts`:
  - `MAX_RELATIONS_PER_BATCH = 10` (line 29);
  - dry-run default (line 624), apply requires exact confirm (lines 625-627);
  - manifest must be fully verified (lines 147-158);
  - per-relation snapshot, live-identity, endpoint-state and endpoint-revision
    drift checks fail closed before any model call or mutation (lines
    160-210, preflight at 250-316);
  - a relation already present in the entries ledger rejects the whole
    request with `historical_y_relation_already_processed` (lines 289-291),
    and every insert guard repeats the `NOT EXISTS` condition (lines 384-389,
    475-480, 532-537);
  - replay: a stored batch returns its ledger entries with no new model call,
    for dry-run and apply alike (lines 631-651);
  - decisions: exact match = same `pair_id` AND same normalized
    `relation_type` (lines 318-333); a pair the model does not return at all
    is indistinguishable from an explicit `none` (both become proposed type
    `"none"`, lines 323-326);
  - promotion preserves relation ID, strength, and `created_at`, and rewrites
    `reason` to `y:auto:<source_memory_id>:<revision>` plus
    `|previous_reason:<old>` (lines 137-145, 565-575;
    `src/db/relationProvenance.ts:2-4`);
  - `not_reconfirmed` writes only an immutable ledger entry; the relation row
    is never modified or deleted (lines 510-512, 579);
  - model errors fail the whole batch with 502 and zero writes (lines
    672-674);
  - the DB batch is one atomic `db.batch()` (line 581);
  - the model's own `reason` text is never persisted anywhere in the
    historical path — ledger entries store `before_reason` (snapshot),
    `proposed_relation_type`, `proposed_strength`, `outcome`, `after_reason`
    only (lines 501-548, 676-685).
- Shared proposer `src/memory/fiveAxis/yRelations.ts`:
  - `proposeRelationsViaLlm` is shared by the normal Y builder, Dream, and
    the historical path (historical call site:
    `historicalYReconfirmation.ts:667-671`);
  - model resolution: override (here `HISTORICAL_Y_RECONFIRM_MODEL`) →
    `DREAM_MODEL` → `MEMORY_MODEL` → `MEMORY_EXTRACT_MODEL` (lines 96-101);
    server-owned var `wrangler.toml:36` =
    `deepseek/deepseek-v4-flash`, so historical batches use Flash without
    changing Dream/Y;
  - prompt builder `buildRelationPrompt` (lines 142-181): each memory
    content is truncated to 200 chars (lines 146-149); type definitions at
    lines 155-167 including `derived_from：B 是从 A 提炼而来` (line 166) and
    `不确定就用 none` (line 167); output example includes a `reason` field
    (lines 171-176);
  - request: temperature 0, `max_tokens: 1800`, `response_format:
    json_object` (lines 207-210); up to 2 attempts per proposer call — one
    initial plus one "previous response was invalid" retry (lines 195,
    202-204), so one Worker request already costs up to 2 model calls;
  - `invalid_json` is returned when no JSON object can be extracted (lines
    224-227).
- Schema `migrations/20260802_historical_y_reconfirmation.sql`:
  - `relation_count BETWEEN 1 AND 10` CHECK (line 10) — already permits any
    operator limit ≤ 10 without a migration;
  - entry outcomes: `promoted | not_reconfirmed | not_applied` (lines 29-31);
  - `UNIQUE(manifest_id, relation_id)` (line 35) — one terminal outcome per
    relation per manifest;
  - immutability triggers on both tables (lines 49-71).
- Runbook `docs/historical-relation-governance-part-c-2026-07-30.md:553-646`:
  - terminal outcomes under one manifest, including `not_applied`; the only
    reopen path is a fresh audit manifest + snapshot + verify + new manifest
    ID (lines 630-635);
  - dry-run is advisory; apply re-samples the model (lines 637-639);
  - no automatic promotion rollback in this phase (lines 641-646).
- Existing tests:
  - `tests/historical-y-reconfirmation-command.test.ts` — remote/credential
    boundaries, cohort filtering, exact-manifest confirm + one bounded
    request, content-addressed sorted IDs (lines 73-144);
  - `tests-worker/historical-y-reconfirmation.test.ts` — zero-write LLM
    dry-run, atomic promote with before/after evidence, bounded no-op on
    type mismatch, endpoint-revision drift fails closed before the model,
    `temporal_sequence` stays X-owned, non-canonical symmetric pair rejected
    (lines 124-289).

## A. Flash output stability

Observed: two `invalid_json` failures at batch size 10, success at 1+3+3+3.
Two plausible root causes, both output-side:

1. `max_tokens = 1800` truncation (`yRelations.ts:208`). Ten hints ×
   (36-char `pair_id` + type + strength + free-text Chinese `reason`) can
   exceed 1800 output tokens.
2. Reasoning-token consumption. `deepseek/deepseek-v4-flash` may spend a
   large share of the `max_tokens` budget on hidden reasoning before
   emitting JSON, so the visible JSON gets cut off. Larger batches raise the
   reasoning surface.

Both causes grow with batch size, matching the observation. Neither is
addressed by retrying the identical request (the proposer already does one
internal retry, lines 195-204, and it still failed twice).

### Options

| Option | What changes | Pros | Cons |
| --- | --- | --- | --- |
| A1. Tighten operator + Worker limit to 3 | `scripts/reconfirm-historical-y-relations.mjs:17-18`, `historicalYReconfirmation.ts:29` | Matches the empirically safe size; smallest per-request cost | 1095/3 = 365 invocations ≈ 730 worst-case model calls for the full cohort; does not fix the underlying output problem; batch 3 still failed-adjacent (1+3+3+3 worked once, no statistical confidence) |
| A2. Raise `max_tokens` | `yRelations.ts:208` | Directly addresses truncation; cheap to try | On the **shared** proposer it also changes Dream/Y behavior and cost; alone it does not shrink verbose `reason` output |
| A3. Shrink historical prompt/output | historical-scoped prompt variant | `reason` is provably dead weight in the historical path (never persisted — see verified facts); removing it from the output contract cuts output size roughly in half and removes the main truncation driver | Needs a dedicated proposer so Dream/Y are untouched (see B) |
| A4. Auto-split retry | CLI or Worker loops halves until success | Self-healing | **Conflicts with the operator safety contract**: one command = one Worker request, bounded batch, never loops (CLI lines 36-37). Splitting means either multiple Worker requests per command or an internal model-call loop with unbounded-ish cost. It also changes failure semantics from "fail closed, operator decides" to "tooling retries on its own" |

### Recommendation

Adopt **A3 + A2 scoped to a historical-dedicated proposer**, keep **A4
rejected as default**, keep A1 only as a fallback:

- Build a historical-dedicated proposer (new module, reusing
  `callOpenAICompat` and the JSON-extraction helpers) with:
  - output schema `hints: [{ pair_id, relation_type, strength }]` — **no
    `reason` field** (it is never persisted in this path);
  - `max_tokens` raised to 4096 for this path only;
  - the same temperature 0, `json_object`, and the existing single internal
    retry — no new retry layers.
- Keep DB CHECK 1..10 untouched (migration line 10) — no migration.
- Keep `MAX_LIMIT = 10` in the CLI but lower `DEFAULT_LIMIT` to 5
  (`scripts/reconfirm-historical-y-relations.mjs:17`) until the sample (D)
  shows `invalid_json` below 1% at size 10; the Worker bound
  (`historicalYReconfirmation.ts:29`) stays 10.
- On `invalid_json` the batch keeps failing closed with zero writes; the
  operator reruns the same IDs with a smaller `--limit` manually. This is
  the only "retry" and it is a human decision, not tooling behavior.

Why this protects the existing boundaries: one Worker request per command
(unchanged), ≤ 2 model calls per request (unchanged), per-request cost
bounded by batch ≤ 10 × compact output (strictly lower than today), no
loops anywhere, no shared-prompt side effects on Dream/Y.

## B. `derived_from` semantic constraint

Problem (from the independent first-10 review): Flash upgraded two
content-overlap pairs to `derived_from` without evidence — one reversed the
direction between a lesson and a later event, while the other treated two
parallel consolidated rules as though one were distilled from the other.
Writing guessed provenance is exactly what this governance program forbids,
so the historical prompt must be stricter than the shared one. Production
relation IDs and memory text are intentionally omitted from this public spec.

### Historical-only prompt rules

Add to the dedicated historical prompt (not the shared one):

1. `derived_from` means: **target B was distilled/abstracted from source A**
   (direction per `yRelations.ts:166`). Never emit it for mere content
   similarity.
2. Acceptable evidence for `derived_from` (at least one required):
   - B explicitly summarizes, quotes, or enumerates A's specific event
     content (matching dates, quotes, or facts that appear in A);
   - B states it is a lesson/rule drawn from the specific record A.
3. Explicit non-evidence: same topic, same principle stated as
   general-rule vs. specific-case, shared keywords, shared `fact_key`
   stem, or two independently consolidated rules. These justify
   `same_topic` / `same_issue` at most.
4. Synthetic positive example: A = raw incident record; B = lesson quoting
   A's specific facts and explicitly stating the rule drawn from it →
   `derived_from` (B from A) is acceptable.
5. Synthetic negative example 1: two independently consolidated rules
   share a principle → `same_topic`, **not** `derived_from`: there is no
   distillation evidence.
6. Synthetic negative example 2: a behavior-pattern lesson and a later
   event that instantiates the same failure may support `instance_of`, but
   never `derived_from` claiming the event was distilled from the lesson.
7. When unsure: prefer `none` or a non-provenance safe type
   (`same_topic`/`same_issue`) over any provenance claim.

### Implementation placement

This **requires the dedicated historical proposer** from A3 — not a
parameter tweak of `buildRelationPrompt` (`yRelations.ts:142-181`). The
shared prompt and `proposeRelationsViaLlm` must remain byte-identical so
normal Y-axis and Dream runs are unaffected (`runRelationBuild`,
`yRelations.ts:271+`, and Dream call sites). The historical writer
(`historicalYReconfirmation.ts:667-671`) swaps its `proposeRelations`
dependency to the new module; the `HISTORICAL_Y_RECONFIRM_MODEL` override
(`wrangler.toml:36`) already isolates the model, so no model-config change
is needed.

## C. `not_reconfirmed` and human review

### Keep the immutable ledger

The entries ledger is the only durable anchor for three properties this
phase depends on: replay idempotency (content-addressed batch +
`UNIQUE(manifest_id, relation_id)`), the anti-fishing guarantee (runbook
lines 626-628: repeated model sampling cannot be used to hunt for a desired
confirmation), and the audit separation between "model declined" and "never
processed". No change.

### Surface the one-shot tension explicitly

Today, `not_reconfirmed` is terminal per relation per manifest
(`UNIQUE`, migration line 35; `already_processed`, writer lines 289-291;
runbook lines 630-635). Consequence: **any broad apply freezes the current
prompt's false-rejects**. If the prompt is fixed later, those relations can
only be reopened through a fresh audit manifest + snapshot + verify cycle
(runbook lines 632-635) — expensive and operationally heavy. Therefore:

- no apply beyond an explicitly approved pilot until the D-sample validates
  the hardened prompt;
- the dry-run report must make false-rejects easy to find *before* apply.

### Dry-run classification improvements (zero-write preserved)

Extend dry-run entries with a `change_kind` field, computed in
`chooseDecision` (`historicalYReconfirmation.ts:318-333`):

| `change_kind` | Meaning |
| --- | --- |
| `exact_match` | same pair, same normalized type (today's `would_promote`) |
| `type_changed` | model returned the pair with a different safe type |
| `none_returned` | model explicitly returned `none` for the pair |
| `missing_pair` | model returned no hint for this `pair_id` at all |

Today `none_returned` and `missing_pair` collapse into `"none"` (lines
323-326), which hides model omissions from reviewers — a real observability
gap, since a missing pair is model flakiness while an explicit `none` is a
judgment. Additionally, when the proposed type is a provenance type
(`derived_from`, `instance_of`, `origin_split`), the report should flag
`provenance_claim: true` so reviewers see every provenance assertion the
model makes. Dry-run remains strictly zero-write (writer lines 686-699);
`change_kind` is report-only and does not alter ledger semantics (apply
outcomes stay `promoted | not_reconfirmed | not_applied`).

Each dry-run entry must also carry `review_evidence` containing the original
relation type/strength and the two endpoint IDs, types, status, active-fact
flags, revisions, creation timestamps, and the exact bounded content excerpts supplied to the
historical proposer. Without this evidence, the 60-row human review in D
cannot distinguish semantic model errors from correct reclassification.
These excerpts are response-only, never stored in D1, and reports containing
them must remain in gitignored `.audit/` storage.

### Human review queue

Needed for `type_changed`, `none_returned`, `missing_pair`, and every
`provenance_claim` row. Design:

- the queue is an **operator-side artifact**, not a D1 write path: the CLI
  already emits machine-readable JSON (`--json`); the review table is built
  offline from saved dry-run reports (same pattern as the gitignored
  `.audit/` evidence files);
- **no queue writes in the apply path**, and no new Worker endpoint in this
  round. The existing review-owned candidate queue
  (`queueRelationReviewCandidate`, `yRelations.ts:261`) has different
  semantics (live-Y `contradicts`/`cause_effect`/`supports`) and must not
  be reused for historical reconfirmation;
- if a durable queue is later wanted, it must be a separate, explicitly
  reviewed command — never a side effect of dry-run (zero-write) or apply
  (terminal-outcome-only).

### Invariants restated

- dry-run: zero writes, always;
- apply: never deletes or rewrites a relation except the guarded exact-match
  promotion; `not_reconfirmed` touches only the ledger;
- idempotency: batch ID is content-addressed
  (`historicalYReconfirmationContract.js:33-47`); entries are
  insert-once; replay returns stored entries without a model call (writer
  lines 631-651);
- retry semantics: a failed apply (model error / drift) writes nothing, so
  rerunning the same IDs is safe; a succeeded apply is terminal and must
  never be "retried" — the fresh-manifest path is the only reopen.

## D. 50–100 sample plan (design only — do not execute)

Goal: measure the hardened prompt's behavior before any apply is
considered.

- **Sample size**: 60 relations (12 invocations × `--limit 5`). 60 gives
  ±13% worst-case 95% confidence on any rate, enough to separate "prompt
  fixed" from "prompt still broken" against the first-10 baseline (3/10
  semantic misjudgments).
- **Sampling**: stratified across the cohort, not the first 60. The
  manifest is ordered by `(created_at, id)`, so a contiguous prefix is
  time-biased toward the oldest imports. Take 12 contiguous windows of 5 at
  evenly spaced offsets across 0..1094 (offsets ≈ 0, 99, 198, …, 1090).
  Each window is one CLI invocation = one Worker request; the operator runs
  them as 12 separate manual commands. No tooling loop is added.
- **Cost upper bound**: 12 Worker requests × ≤ 2 model calls × 5 pairs =
  ≤ 24 model calls, ≤ 60 pairs judged. Hard stop: never exceed 12 requests
  in this phase.
- **Metrics to record per batch**: `promote` (`exact_match`),
  `type_changed`, `none_returned`, `missing_pair`, `invalid_json`,
  `provenance_claim` count; plus wall time and token usage if exposed.
- **derived_from error rate**: every `derived_from` proposal (any
  direction) goes to the human review table; report direction-correctness
  as judged against both endpoint contents.
- **Human review table** (offline artifact, one row per relation):
  `relation_id, source_id, target_id, source_type, target_type,
  original_type, original_strength, original_reason, proposed_type,
  proposed_strength, change_kind, provenance_claim, human_verdict
  (correct | wrong | uncertain), notes`.
- **Stop conditions** (any one halts the sample and sends the pipeline back
  to A/B):
  - `invalid_json` in > 1 of 12 batches;
  - direction-wrong or evidence-free `derived_from` in > 20% of all
    `derived_from` proposals;
  - `missing_pair` in > 10% of relations (model flakiness too high to
    interpret `not_reconfirmed`);
  - any drift rejection (live data is moving; re-verify the manifest
      first);
  - `exact_match` rate < 30% (retype-heavy cohort; strategy needs
    rethinking, not larger samples).
- **Explicit prohibitions**: no automatic full run of 1095/1369; no apply
  in this phase; any future apply requires separate, explicit user approval
  naming the exact manifest and selection (see E).

## E. Existing writer and selective apply

Constraint: never bypass the operator CLI, never call the raw endpoint or
hand SQL to cherry-pick rows.

Feasibility within the current design:

- The Worker endpoint already accepts an arbitrary explicit ID array
  (validated against snapshots, drift, one-shot), and the batch ID is
  content-addressed over exactly those IDs
  (`historicalYReconfirmationContract.js:33-47`). A subset apply is
  therefore a *new, smaller batch*, not a partial replay of the dry-run
  batch — legitimate and fully guarded.
- The CLI today can only produce contiguous offset/limit slices
  (`scripts/reconfirm-historical-y-relations.mjs:116-141`). What is missing
  is an approved-selection input.

Proposed mechanism — **manifest-guarded approved-selection file**:

- New CLI option `--selection <path>` (mutually exclusive with explicitly
  supplied `--offset` or `--limit`): a local JSON file containing
  `schema_version`, `manifest_id`, sorted `relation_ids` (≤ 10), an optional
  `batch_sha256` checksum over the canonical batch JSON (same
  `canonicalHistoricalYBatch`), and a
  human-approval block (`approved_by`, `approved_at`, `rationale`).
- `approved_by`, `approved_at`, and `rationale` are descriptive local notes
  only. They are self-asserted metadata and are never treated as
  authentication or authorization by the CLI or Worker.
- CLI validation: file `manifest_id` must equal the manifest's
  `eligible_unproven` cohort ID; every ID must belong to the reconfirmable
  candidate set rebuilt from the manifest (same filter as lines 116-120);
  any supplied `batch_sha256` must recompute; apply still requires `--confirm
  <exact manifest_id>` **plus** `--approve-selection <batch_sha256>`
  so the operator confirms both the manifest and the exact human-approved
  ID set.
- A selection dry-run accepts an ID-only selection file and outputs the exact
  canonical `relation_ids` and computed `batch_sha256`. The same file can then
  be used for apply only when the operator supplies that value via
  `--approve-selection`; operators never hand-reimplement the canonical hash.
- Any dry-run entry classified as `missing_pair` is ineligible for selection
  or apply. A model omission must be investigated and followed by a fresh
  dry-run; it must never be converted into a terminal ledger outcome merely
  by including that ID in an approved selection.
- After hardening, every apply requires `--selection`; the legacy
  offset/limit apply form is rejected. Offset/limit remains available only
  for advisory dry-runs and sampling, so approved-selection cannot be
  bypassed while still using the operator CLI.
- Ledger linkage: no schema change. The batch row's `relation_ids_json`
  *is* the approved ID set, keyed by the content-addressed `batch_id`
  (migration lines 1-19); the selection file remains local evidence under
  `.audit/`, exactly like the read-only manifests. Storing the selection
  hash in D1 is possible later but not required for auditability, and this
  spec deliberately avoids a new migration.
- Resampling difference (runbook lines 637-639): apply calls the model
  again; a dry-run `would_promote` can resample to `not_reconfirmed`. That
  is safe (no wrong write) but burns the relation's one-shot outcome under
  this manifest (C). Mitigation: selective apply only after the D-sample
  validates the hardened prompt, and the approval block must record that
  the approver accepted resampling risk. >10 approved IDs means multiple
  manual CLI invocations — no loop in tooling.

## F. Tests and deployment order

New/changed tests:

1. `tests/historical-y-proposer.test.ts` (new unit): compact output schema
   without `reason`; derived_from evidence rules present in prompt;
   positive/negative examples present; parser accepts compact hints and
   rejects prose; `missing_pair` vs `none_returned` classification in
   `chooseDecision`; `provenance_claim` flag on `derived_from` /
   `instance_of` / `origin_split`.
2. `tests/historical-y-reconfirmation-command.test.ts` (extend):
   `--selection` parsing, hash recompute, manifest-ID mismatch rejection,
   non-candidate ID rejection, `--offset`/`--selection` exclusivity,
   `--approve-selection` required for apply-with-selection, one bounded
   request preserved, `DEFAULT_LIMIT = 5`.
3. `tests-worker/historical-y-reconfirmation.test.ts` (extend): dry-run
   entries carry `change_kind`; missing-pair pair is reported as
   `missing_pair` and still zero-write; apply with a subset ID set writes
   batch + entries for exactly that subset; replay of the subset batch is
   idempotent; `UNIQUE(manifest_id, relation_id)` still rejects
   reprocessing; the hardened proposer is used while the shared
   `proposeRelationsViaLlm` and `buildRelationPrompt` stay byte-identical
   (guard test importing both and comparing behavior with a mock model).
4. `tests/y-relations.test.ts`: unchanged — must keep passing unmodified
   (proves Dream/Y untouched).

Order (no step may be skipped or reordered):

1. write/extend tests; 2. implement; 3. PR; 4. human review (Codex);
5. merge; 6. automatic deploy + verification (wrangler deploy, then a
   single `--limit 1` dry-run smoke against production, zero writes);
7. D-sample dry-run (12 manual invocations); 8. human review of the sample
   report and review table; 9. only then may an apply be requested, with
   explicit user approval naming the manifest and selection file.

No database migration is required for A–E; if any step later needs one, it
is a separate reviewed migration, applied under its own authorization.

## G. Non-goals

- no cleanup of other worktrees;
- no tidying of `agent/historical-relation-governance`;
- no rewrite of existing migrations or ledger tables;
- do not run `build_relations.py` — the VPS legacy script is permanently
  deleted;
- no change to normal Dream/Y model configuration (`DREAM_MODEL`,
  `MEMORY_MODEL`, `MEMORY_EXTRACT_MODEL`, shared prompt, shared proposer);
- no full-cohort historical governance run (1095/1369).

---

## 1. Confirmed current facts

1. The full writer already exists and is merged: manifest/snapshot
   verification, relation + endpoint drift guards, guarded exact-match
   promotion, atomic batch, immutable batch/entry ledger, idempotent replay
   (`historicalYReconfirmation.ts` throughout; migration
   `20260802_historical_y_reconfirmation.sql`).
2. Promotion never writes guessed types: only an exact pair+type match
   promotes; everything else is ledger-only `not_reconfirmed`
   (writer lines 318-333, 510-512, 565-579). The first-10 review's wrong
   `derived_from`/`none` judgments therefore never reached relation rows.
3. Dry-run is advisory; apply re-samples the model (runbook 637-639).
4. Every outcome is terminal per relation per manifest; reopening requires
   a fresh manifest cycle (migration line 35; runbook 630-635).
5. The proposer is shared with Dream/Y; historical isolation exists only
   for the model (`HISTORICAL_Y_RECONFIRM_MODEL`, `wrangler.toml:36`;
   fallback chain `yRelations.ts:96-101`).
6. `max_tokens = 1800` and a `reason`-heavy output contract on the shared
   prompt (`yRelations.ts:171-176, 208`); the historical path never
   persists model `reason`.
7. One Worker request per CLI invocation, never loops, apply needs exact
   manifest confirm (CLI lines 36-37, 144-147, 161-174).
8. Production ledgers are empty; the only production evidence is the
   first-10 dry-run.
9. DB CHECK already allows batch sizes 1-10; no migration is needed for any
   recommendation here.
10. Dry-run collapses "model returned none" and "model omitted the pair"
    into one `"none"` (writer lines 323-326).

## 2. Recommended decisions

- D1. Build a historical-dedicated proposer: compact output without
  `reason`, `max_tokens` 4096 for this path only, derived_from evidence
  rules with synthetic positive/negative examples; shared Dream/Y prompt and
  proposer byte-identical.
- D2. No auto-split retry anywhere; batches keep failing closed; smaller
  reruns are a manual operator decision.
- D3. Keep DB/Worker bound at 10; set CLI `DEFAULT_LIMIT = 5` until the
  sample proves size-10 stability; no migration.
- D4. Add `change_kind` + `provenance_claim` to dry-run reports
  (zero-write, report-only); build the human review table offline.
- D5. Run the 60-relation stratified sample (12 × 5) with explicit stop
  conditions before any apply is even requested.
- D6. Add a manifest-guarded `--selection` file for approved-subset apply,
  with `--approve-selection <sha256>`; ledger linkage via existing
  content-addressed batch rows; no schema change.

## 3. Points for Codex review (disagreements welcome)

- P1. Terminal `not_reconfirmed` vs. reopen cost: is "fix prompt first,
  sample second, apply last" sufficient, or should a reopen mechanism
  (beyond the fresh-manifest path) be designed now?
- P2. Dedicated proposer module vs. adding a `promptVariant` parameter to
  the shared proposer. This spec prefers the dedicated module to guarantee
  zero Dream/Y side effects; the alternative is smaller but riskier.
- P3. `max_tokens` 4096 for the historical path — acceptable cost exposure,
  or should it stay 1800 with the compact output schema alone?
- P4. Is 60 the right sample size, and is stratified-by-offset acceptable
  given the CLI only supports contiguous slices?
- P5. Selection file as local evidence vs. persisting the selection hash in
  D1 (would require a migration this spec avoids).
- P6. `change_kind` extends the dry-run response schema — acceptable
  CLI/Worker co-change, or should classification stay an offline
  post-processing step?
- P7. `DEFAULT_LIMIT = 5` vs. tightening to 3 (the only empirically clean
  size so far) at the cost of ~50% more invocations.

## 4. Implementation file list (after approval)

- new: `src/memory/historicalYProposer.ts` — dedicated prompt + request +
  parser (reuses `callOpenAICompat`, JSON extraction helpers);
- modify: `src/memory/historicalYReconfirmation.ts` — swap proposer
  dependency, add `change_kind` / `provenance_claim` to dry-run entries,
  split `missing_pair` from `none_returned` in `chooseDecision`;
- modify: `scripts/reconfirm-historical-y-relations.mjs` — `DEFAULT_LIMIT
  = 5`, `--selection` + `--approve-selection`, selection-file validation;
- modify: `tests/historical-y-reconfirmation-command.test.ts`,
  `tests-worker/historical-y-reconfirmation.test.ts`;
- new: `tests/historical-y-proposer.test.ts`;
- modify: `docs/historical-relation-governance-part-c-2026-07-30.md` —
  runbook update after merge;
- no migration; no changes to `src/memory/fiveAxis/yRelations.ts`,
  `src/db/relationProvenance.ts`, `wrangler.toml`, or Dream/Y call sites.

## 5. Acceptance criteria

1. All new and existing tests pass; `tests/y-relations.test.ts` passes
   unmodified; the shared prompt builder is provably untouched.
2. CLI still performs exactly one Worker request per invocation, never
   loops, defaults to dry-run, and requires exact manifest confirm for
   apply — verified by contract tests.
3. Dry-run remains zero-write, proven by Worker integration tests
   (D1 row counts unchanged across a dry-run).
4. Historical prompt contains the derived_from evidence rules and synthetic
   positive/negative examples; output schema has no `reason` field.
5. Dry-run report distinguishes `exact_match` / `type_changed` /
   `none_returned` / `missing_pair` and flags `provenance_claim`.
6. Sample phase obeys its bound: ≤ 12 Worker requests, ≤ 24 model calls,
   with recorded stop-condition outcomes.
7. No apply occurs without a separate explicit user approval naming the
   manifest ID and the selection-file hash.
8. `invalid_json` rate at the sample's batch size is ≤ 1/12 batches; if
   not, the phase returns to section A before any apply discussion.

## Codex review disposition

- P1: no reopen mechanism in this round; a fresh verified manifest remains
  the only reopen path.
- P2: approved a dedicated historical proposer; the shared Dream/Y proposer
  remains unchanged.
- Prompt examples must be synthetic and structural. Production memory text,
  IDs, dates, or labels must never be hard-coded into the public repository.
- P3: approved `max_tokens = 4096` only for the historical proposer. The
  12-request sample bound limits exposure; no full-cohort run is authorized.
- P4: approved the 60-row, 12-window manual sample design, subject to the
  response-only `review_evidence` requirement above.
- P5: approved local selection evidence with existing ledger linkage and no
  migration. Self-asserted approval metadata is explicitly non-authoritative.
- P6: approved additive `change_kind` and `provenance_claim` fields on
  dry-run entries only; apply and replay remain ledger-shaped.
- P7: approved `DEFAULT_LIMIT = 5` after compacting historical output. The
  first production smoke remains limit 1, and the sample stops on the
  documented invalid-JSON threshold.
- Automatic split/retry remains rejected. One CLI invocation still performs
  exactly one Worker request, with at most the existing two model attempts.
- The historical parser rejects duplicate `pair_id` decisions as invalid
  output. It never chooses an exact match from an ambiguous multi-hint pair.
