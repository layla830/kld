# Historical Y reconfirmation hardening v2 spec (r2, Codex-reviewed)

- Date: 2026-08-02 (r2 incorporates the Codex review resolutions; v2 r1 was
  approved in direction but blocked on 5 spec defects)
- Status: implemented by PR #118 and CLI telemetry follow-up PR #119;
  merged and deployed. Post-deployment work remained dry-run only, and the
  production reconfirmation batch and entry ledgers were still empty on
  2026-08-08.
- Supersedes: v1 (`historical-y-reconfirmation-hardening-spec-2026-08-02.md`)
  and v2 r1 (this document's first revision)
- Base: `main` @ `73e39d4` (PR #117 merged and deployed)
- Evidence: stratified sample halted after 4 of 12 batches per the v1 stop
  conditions. Reports: `.audit/sample-2026-08-02-offset-{0,99,198,297}.json`,
  smoke `.audit/smoke-limit1-2026-08-02.json`

## 0. Corrections carried forward from r1

1. Sample tally: `exact_match` 3/15 (20%), `type_changed` 11/15 (73.3%),
   `none_returned` 1/15, `missing_pair` 0, `invalid_json` 1 batch (offset
   99, zero writes). The `exact_match < 30%` stop condition triggered.
2. `instance_of` canonical direction: **source A is a concrete instance of
   target B's concept** (`src/api/adminBoard/metabolismView.ts:31`).
3. `enable_thinking: false` is already sent on the AI Gateway path
   (`src/proxy/openaiAdapter.ts:83-86`); reasoning tokens are not an
   established cause of `invalid_json`.
4. Temperature-0 output is not reproducible across runs
   (`rel_1379596822424ef1a96a0645c311b115`: smoke `same_issue` vs. sample
   `same_topic`).

## 0.1 Codex review resolutions (binding for this spec)

- **P1**: deterministic structural confirmation may use the existing
  `promoted` outcome (no migration), under the proof-provenance conditions
  in 1.3 — crucially, the proof must live in the ledger's `after_reason`,
  because apply/replay ledger rows do not store `change_kind`.
- **P2**: structural pairs are excluded from the model request entirely.
  An all-structural batch makes zero model calls and returns
  `attempts: []`, `model_called: false`. Mixed batches send only semantic
  pairs to Flash.
- **P3**: `origin_split` stays skipped this round. `source_message_ids`
  intersection matches legacy-builder evidence, but there is a structural
  conflict to audit first: the admin table calls `origin_split` symmetric
  (`metabolismView.ts:34`) while `SYMMETRIC_RELATION_TYPES`
  (`src/db/memoryRelations.ts:51-63`) does not include it, so pair
  normalization (`memoryRelations.ts:106`) never canonicalizes
  `origin_split` direction and reverse duplicates are possible. Equal
  `source` alone is never sufficient evidence.
- **P4**: no second model call in apply. A dual call cannot freeze the
  human-reviewed dry-run result; it is just another random sample. Apply
  stays single-call and remains forbidden until the stability gate passes.
  Any future strengthening is a separate "decision-bound selection"
  design, not retry stacking.
- **P5**: telemetry goes to both the response body and Workers structured
  logs; `usage` is extracted through a numeric whitelist; `batch_id` is
  the correlation key; 502 uses `{ error, details: { attempts } }`;
  telemetry is never embedded in the error code string; no prompt, memory
  content, or completion text is ever recorded.
- **P6**: stability thresholds, precisely defined in 1.5.

## Problem 1 — relation semantics and evidence boundaries

### 1.1 Canonical direction registry (true single source of truth)

New shared module `src/memory/relationTypeRegistry.ts` exporting the
canonical relation-type metadata (label, meaning, direction) for every
relation type, mirroring today's product table:

- `src/api/adminBoard/metabolismView.ts:20-41` is **refactored to import
  from this registry** — the admin table and the historical pipeline read
  the same definitions, not two copies kept in sync by a test;
- `src/memory/historicalYReconfirmationContract.js` imports the two
  directed safe types this pipeline can emit and re-exports them as
  `HISTORICAL_Y_DIRECTED_RELATION_TYPES` with their canonical A/B
  direction text:
  - `derived_from`: target B is distilled/evolved from source A;
  - `instance_of`: source A is a concrete instance of target B's concept;
- the contract module also exports
  `HISTORICAL_Y_STRUCTURAL_RELATION_TYPES = { in_thread, same_fact_key,
  origin_split }` (structural = decidable only from record fields);
- a unit test asserts the registry is the only definition site (the admin
  view and the contract both import it).

### 1.2 Prompt: direction rule and structural ban

Update `buildHistoricalYPrompt` (`src/memory/historicalYProposer.ts:33-67`):

- add the `instance_of` direction rule from the registry: "instance_of
  是有方向的：起点 A 是终点 B 概念的一个具体实例。方向不明时不得输出
  instance_of。", with one synthetic positive and one synthetic negative
  example;
- remove `in_thread`, `same_fact_key`, `origin_split` from the allowed
  list (line 51) and state: these three are decided by the system from
  record fields, the evidence is not in the model input, the model must
  never output them;
- keep the hardened `derived_from` evidence rules unchanged (zero
  `derived_from` proposals in the sample — they worked).

### 1.3 Structural types: deterministic checks + proof provenance (P1)

The writer already loads full `MemoryRecord`s for both endpoints
(`historicalYReconfirmation.ts:301-308`); records carry `fact_key`,
`thread`, `source_message_ids` (`src/types.ts:172-174, 206-208, 222`).

Deterministic rules:

| Type | Rule |
| --- | --- |
| `same_fact_key` | both `fact_key` non-null and equal |
| `in_thread` | both `thread` non-null and equal |
| `origin_split` | skipped this round (P3); excluded from the reconfirmable candidate set and reported as skipped |

Behavior for a relation whose original type is structural:

- the pair is **excluded from the model request** (P2); its verdict is
  decided by the deterministic rule alone;
- rule passes → outcome `would_promote` (dry-run) / `promoted` (apply),
  with `change_kind: structural_confirmed` in the report;
- rule fails → `not_reconfirmed`, `change_kind: structural_mismatch`;
  the relation is never modified;
- dry-run entries include boolean field evidence only (`fact_key_equal`,
  `thread_equal`) — never raw values.

**Proof provenance (mandatory)**:

- a structural promotion must NOT write `y:auto:` provenance. Its new
  `reason` is
  `historical-structural:<relation_type>:<evidence_sha256>` plus the
  existing `|previous_reason:<old>` suffix convention;
- `evidence_sha256` = SHA-256 (first 32 hex chars) over a canonical JSON
  object: `{ schema_version: 2, relation_type, matched_fields:
  [<field names that matched, e.g. "thread">], source_memory_id,
  source_five_axis_revision, target_memory_id,
  target_five_axis_revision }`. Field *names* only — raw
  `thread`/`fact_key` values are never hashed in or stored;
- the prefix `historical-structural:` is added to
  `RELATION_PROVENANCE_PREFIXES.deterministic_rebuildable`
  (`src/memory/relationProvenanceContract.js:9-14`), so the post-apply
  historical audit classifies these rows as proven and they leave
  `eligible_unproven`;
- the ledger's `after_reason` permanently stores this proof reason; the
  replay path (`historicalYReconfirmation.ts:631-651`) returns stored
  entries unchanged, so the proof survives replay verbatim. The
  response-only `change_kind` is informational; `after_reason` is the
  durable contract;
- semantic (model) promotions keep `y:auto:` unchanged.

### 1.4 Exact-match contract

A semantic relation promotes only when all of:

1. the model returns the same pair with the same normalized type;
2. the type is not structural (structural uses 1.3);
3. directed types (`derived_from`, `instance_of`) are flagged
   `direction_sensitive: true` in the dry-run report, and every directed
   exact-match in any future sample must be human spot-checked against
   both endpoint contents before the corresponding apply is requested.

### 1.5 Stability gate (P6, precise)

Before any new sample or apply, the same small window is run **three
times** (three separate manual CLI invocations, dry-run). Pass requires
ALL of:

1. 3/3 Worker requests ultimately succeed;
2. at least 2/3 succeed on the first model attempt;
3. at least 4 of 5 pairs receive an identical type in 3/3 runs;
4. every pair whose type is directed (in any run) is self-consistent
   across 3/3 runs;
5. zero structural-type out-of-vocabulary outputs across all attempts;
6. final reports contain zero `missing_pair` and zero directed-type
   flips.

A provider `seed` may be sent if honored, but the gate stands regardless;
seed support must be proven by the same three-run check, not assumed.

## Problem 2 — failure observability (P5)

### 2.1 Per-attempt structured telemetry

Instrument `proposeHistoricalYRelations`
(`historicalYProposer.ts:99-149`) to record per attempt:

- `attempt_index` (0/1), `model`, `batch_id` (correlation key, passed in
  from the writer), `http_status` (or null), `elapsed_ms`;
- `finish_reason` (`src/types.ts:124`) when present;
- `usage` via a **numeric whitelist only**: `prompt_tokens`,
  `completion_tokens`, `total_tokens`, and
  `completion_tokens_details.reasoning_tokens` when numeric — the
  upstream object is never passed through; missing fields are explicit
  nulls, never guesses;
- `content_chars` (assistant-text length), `reasoning_chars` when a
  reasoning field exists — never the text itself;
- `parse_outcome` ∈ `ok | http_error | exception | no_json_object |
  hints_array_invalid | duplicate_pair_id | out_of_vocabulary_type |
  unknown_pair_id | malformed_hint | empty_choices`.

No prompt text, no memory content, no completion text — only structured
features, consistent with Cloudflare's structured-logging guidance for
Workers.

### 2.2 Surfacing

- one JSON line per attempt via `console.log` (Workers logs /
  `wrangler tail`), keyed by `batch_id`;
- the Worker response result (dry-run and apply) includes the compact
  `attempts` array plus `model_called: boolean`, so `.audit/` reports are
  self-contained;
- on model failure the 502 body is
  `{ error: "historical_y_model_error:<last_error>", details: { attempts } }`
  (`historicalYReconfirmation.ts:672-674`, `src/api/debug.ts:221-261`).
  The error code string stays as today; the parse taxonomy lives in
  `details.attempts[].parse_outcome`, never in the code string;
- all-structural batches (P2) return `attempts: []`,
  `model_called: false`.

### 2.3 Unified parser semantics (blocking fix)

`parseHistoricalHints` (`historicalYProposer.ts:69-97`) becomes strict:

- any of: out-of-vocabulary type, duplicate `pair_id`, unknown `pair_id`
  (not in the requested set), malformed hint (missing/non-string fields;
  a non-`none` hint without an explicit numeric in-range `strength`) →
  the **attempt fails** with the corresponding `parse_outcome`;
- if the second attempt also fails, the whole batch returns 502 with zero
  writes (existing fail-closed path);
- `missing_pair` is reserved for an otherwise fully valid response that
  omits a known requested `pair_id` — and nothing else;
- the silent `strength: 0.6` default (line 93) is removed; `none` keeps
  `strength: null`.

## Schema/version guard (blocking fix)

`HISTORICAL_Y_RECONFIRMATION_SCHEMA_VERSION` is bumped to 2
(`historicalYReconfirmationContract.js:1`). The version feeds
`canonicalHistoricalYBatch` (`:33-39`), so every batch ID, selection-file
hash, and approval hash produced under v1 semantics becomes invalid for
v2. Production impact is nil (batch ledger = 0, entry ledger = 0), and no
migration is needed; old code simply cannot replay into v2 semantics.

## Re-verification plan (after r2 merges and deploys)

1. Rerun offset 99, limit 5, dry-run — must succeed and carry full
   `attempts` telemetry (zero writes).
2. Repeat the same window twice more; evaluate the 1.5 gate exactly.
3. Gate passes → decide on a fresh 60-relation stratified sample (v1
   sample data does not transfer). Gate fails → return to Problems 1/2
   with telemetry; do not scale.
4. No apply in this phase. The human type-correction writer must not be
   designed, let alone executed, until a validated sample shows it is
   needed.

### Post-deployment result

The required offset-99, limit-5 window was run three times after deployment.
All three Worker requests succeeded on their first model attempt, with zero
`missing_pair`, structural out-of-vocabulary output, or directed-type flip.
However, only 2 of 5 pairs received an identical type in all three runs,
below the required 4-of-5 threshold. The stability gate therefore **failed**.

No apply or 60-relation sample is authorized. An additional offset-792
dry-run probe was performed after the failed gate: two requests succeeded and
one ended in `invalid_json`. It wrote nothing, but it was outside the ordered
plan above and must not be treated as authorization to continue sampling.
PR #119 subsequently preserved Worker failure telemetry on CLI stderr.

## Tests and deployment order (blocking fix: runbook ships in-PR)

New/changed tests:

1. `tests/historical-y-proposer.test.ts`: structural ban in prompt;
   `instance_of` direction rule present; strict parser (OOV / duplicate /
   unknown pair / malformed / missing strength → attempt failure; second
   failure → 502, **not** `missing_pair`); `missing_pair` only for valid
   response missing a known pair; telemetry whitelist (usage numbers,
   finish_reason, parse_outcome, no raw text).
2. `tests/historical-y-structural.test.ts` (new): `same_fact_key` /
   `in_thread` deterministic rules (equal, unequal, null);
   `origin_split` skipped; evidence-hash format (no raw values);
   `historical-structural:` prefix classified as
   `deterministic_rebuildable`.
3. `tests-worker/historical-y-reconfirmation.test.ts`: all-structural
   batch → zero model calls, `attempts: []`, `model_called: false`;
   mixed batch excludes structural pairs from the model request;
   structural promotion writes `historical-structural:<type>:<hash>`
   (not `y:auto:`) and the ledger `after_reason` stores it; replay
   returns the stored proof verbatim; dry-run zero writes; 502 body shape
   `{ error, details: { attempts } }`; schema-version-2 batch IDs do not
   collide with v1 hashes.
4. `tests/historical-y-reconfirmation-command.test.ts`: CLI contract
   unchanged (one request, no loop, exact-manifest confirm).
5. Registry test: `metabolismView` and the historical contract both
   import `src/memory/relationTypeRegistry.ts`.

Order: tests → implementation → PR **including the runbook update**
(`docs/historical-relation-governance-part-c-2026-07-30.md` runbook
section ships in the same PR and is reviewed together, not post-merge) →
Codex review → merge → deploy → re-verification gate → sample decision.
No migration; Dream/Y/shared proposer/model config untouched.

## Non-goals

- no apply of any kind; no human type-correction writer (not even a
  design);
- no new 60-sample until the re-verification gate passes;
- no `origin_split` confirmation until the symmetric-set conflict and
  reverse-duplicate impact are audited (P3);
- no changes to Dream/Y/shared proposer/model configuration;
- no migration, no ledger or relation writes;
- no cleanup of other worktrees or branches.

---

## 1. Confirmed current facts

1. Sample tally: `exact_match` 3/15 (20%), `type_changed` 11/15 (73.3%),
   `none_returned` 1/15, `missing_pair` 0, `invalid_json` 1/4 batches
   (offset 99, zero writes); sample halted per v1 stop conditions.
2. Prompt inputs exclude `thread`/`tags`/`fact_key`
   (`historicalYProposer.ts:33-44`) while structural verdicts were
   allowed (`:51`); offset-198 `in_thread=1.0` was evidence-free.
3. Canonical directions live in `metabolismView.ts:20-41`; r2 makes them
   a shared registry imported by both admin and the historical pipeline.
4. `origin_split` is labeled symmetric in admin (`metabolismView.ts:34`)
   but absent from `SYMMETRIC_RELATION_TYPES`
   (`memoryRelations.ts:51-63`), so its pair order is never canonicalized
   (`memoryRelations.ts:106`).
5. `enable_thinking: false` is already sent (`openaiAdapter.ts:83-86`).
6. Temp-0 output is not reproducible across runs.
7. Provenance classification is prefix-based
   (`relationProvenanceContract.js:9-30`); `y:auto:` is classified
   `builder_backed`, and `deterministic_rebuildable` is where the new
   `historical-structural:` prefix belongs.
8. `MemoryRecord` exposes `fact_key`/`thread`/`source_message_ids`;
   `OpenAIChatResponse` types `finish_reason`/`usage`
   (`src/types.ts:124, 134, 172-174, 206-208, 222`).
9. Production ledgers remain 0; no v1 batches exist to invalidate, so the
   schema-version bump is free.
10. The ledger stores no `change_kind`; durable proof must live in
    `after_reason`.

## 2. Recommended decisions (post-review)

- D1. Shared `relationTypeRegistry.ts`; admin view refactored to import
  it; historical contract re-exports directed/structural sets from it.
- D2. Prompt: `instance_of` direction rule added; structural types
  banned; derived_from rules unchanged.
- D3. Structural originals: excluded from model requests; deterministic
  `fact_key`/`thread` checks; promotion proof
  `historical-structural:<type>:<hash>` in `after_reason`, prefix
  classified `deterministic_rebuildable`; `origin_split` skipped.
- D4. Strict parser with attempt-failure taxonomy; `missing_pair`
  reserved for valid-but-incomplete responses; no silent strength
  default.
- D5. Per-attempt telemetry to response + Workers logs, numeric usage
  whitelist, `batch_id` correlation, 502 `{ error, details }`.
- D6. `HISTORICAL_Y_RECONFIRMATION_SCHEMA_VERSION = 2`.
- D7. Three-run stability gate with the six precise P6 criteria before
  any sample or apply; single-call apply unchanged.
- D8. Runbook ships inside the implementation PR.

## 3. Resolved dispute points (Codex rulings)

- P1 → resolved: `promoted` outcome reused; proof in `after_reason` via
  `historical-structural:` provenance (1.3).
- P2 → resolved: structural pairs fully excluded from model requests;
  all-structural batch = zero model calls (1.3, 2.2).
- P3 → resolved: `origin_split` skipped; symmetric-set conflict and
  reverse-duplicate audit are prerequisites for any future rule.
- P4 → resolved: no dual apply call; apply stays forbidden until the
  gate passes; "decision-bound selection" is a future separate design.
- P5 → resolved: telemetry in response + logs, whitelisted, keyed by
  `batch_id`, 502 `{ error, details: { attempts } }`.
- P6 → resolved: thresholds as defined in 1.5.

Open questions for the implementation PR review (non-blocking):

- Q1. Evidence-hash length: 32 hex chars proposed; full 64 acceptable if
  reviewers prefer maximal collision resistance in `reason` text.
- Q2. Whether `matched_fields` should also cover future multi-field
  rules (e.g. `fact_key` + `thread` conjunctions) — the canonical JSON
  already allows a list.

## 4. Implementation file list (after approval)

- new: `src/memory/relationTypeRegistry.ts`;
- modify: `src/api/adminBoard/metabolismView.ts` (import registry;
  behavior identical);
- modify: `src/memory/historicalYReconfirmationContract.js` (schema
  version 2, directed/structural sets re-exported from registry);
- modify: `src/memory/historicalYProposer.ts` (prompt, strict parser,
  telemetry);
- modify: `src/memory/historicalYReconfirmation.ts` (structural checks,
  proof provenance, model-request exclusion, `model_called`/`attempts`,
  502 details);
- modify: `src/memory/relationProvenanceContract.js`
  (`historical-structural:` prefix → `deterministic_rebuildable`);
- modify: `src/api/debug.ts` (502 `{ error, details }` passthrough);
- modify: `docs/historical-relation-governance-part-c-2026-07-30.md`
  (runbook — same PR);
- tests: `tests/historical-y-proposer.test.ts`,
  `tests/historical-y-structural.test.ts` (new),
  `tests-worker/historical-y-reconfirmation.test.ts`,
  `tests/historical-y-reconfirmation-command.test.ts`;
- no migration; no changes to `src/memory/fiveAxis/yRelations.ts`,
  `src/db/memoryRelations.ts` normalization behavior, Dream/Y, or
  wrangler config.

## 5. Acceptance criteria

1. All tests pass; Dream/Y/shared-proposer files byte-identical;
   `metabolismView` renders identically while importing the registry.
2. Prompt contains the `instance_of` direction rule and excludes the
   three structural types; strict-parser failures produce 502 after two
   attempts, never silent `missing_pair`; no silent `strength` default.
3. All-structural batch: zero model calls, `attempts: []`,
   `model_called: false`; structural promotion writes
   `historical-structural:<type>:<hash>` into `after_reason` and the
   audit classifies it `deterministic_rebuildable`.
4. Every response and 502 carries whitelisted per-attempt telemetry keyed
   by `batch_id`, with zero raw content.
5. v1 batch/selection hashes cannot drive v2 requests (schema version 2).
6. Offset-99 rerun plus two repeats: the six P6 gate criteria measured
   and recorded in `.audit/`; no apply and no new sample without a passed
   gate and explicit user approval.
7. Runbook changes are inside the implementation PR diff.
8. Production ledgers remain 0 until a separately approved apply.
