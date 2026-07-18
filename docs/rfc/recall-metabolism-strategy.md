# RFC: Recall-Signal-Driven Metabolism Strategy

- Status: Approved by Layla; implementation gated on RFC merge
- Scope: M-axis strategy and recall-signal infrastructure
- Code changes in this RFC: None
- Proposed rollout: Shadow first, review-first mutations, reversible approvals

## 1. Summary

KLD already records lifetime recall counters and uses them in the M-axis cold-memory scanner. The current rule is intentionally conservative: an unprotected, low-importance, low-confidence memory that has never been recalled, has stayed cold for 90 days, and does not anchor a relation may become an `m_archive` review candidate.

That baseline should remain unchanged. It is safe, understandable, covered by tests, and does not physically delete memory.

The next M-axis increment should add two abilities without weakening that baseline:

1. distinguish “used before but now cold” from “never used”; and
2. recognize sustained recent reuse without allowing a tight loop or repeated request to inflate importance automatically.

This RFC recommends a normalized daily recall rollup plus one shared recall-signal writer. It does **not** recommend storing JSON recall history on each memory, and it does not rely on a `recall_runs` table because no such table exists in the current repository.

No new M-axis action should mutate memory automatically. New archive or promotion proposals remain `memory_candidates`, require human approval, revalidate their evidence at approval time, write snapshots, and support rollback.

## 2. Goals and non-goals

### Goals

- Make recall evidence consistent across the final context-injection entrypoints.
- Support batched 7-, 30-, 90-, and 180-day metrics without N+1 queries.
- Preserve the existing never-recalled cold-memory policy exactly.
- Add an optional “previously used, now cold” archive policy after a shadow period.
- Define a review-first promotion policy for memories with sustained reuse.
- Make every candidate explainable from stored metrics and thresholds.
- Prevent repeated promotion/archive proposals from oscillating.

### Non-goals

- Automatically delete, archive, promote, split, supersede, or rewrite memories.
- Count every search result as a recall; only memory actually selected for context counts.
- Infer user satisfaction from the next chat message.
- Move Z-axis fact supersession into M.
- Implement `split_thread` or `distill_growth` from recall frequency alone.
- Change the current 90-day baseline in the first implementation PR.

## 3. Current code baseline

### 3.1 Recall counters

`markMemoriesRecalled()` updates the final selected memory rows in chunks and performs `recall_count = recall_count + 1` plus `last_recalled_at = now` ([`src/db/memories.ts:565-581`](../../src/db/memories.ts#L565-L581)). Chunking already avoids D1's binding limit and should be retained by the future shared writer.

The API recall route counts only the memory IDs actually selected when `should_recall` is true, then writes a `recall_context_injected` audit event containing the selected IDs and trace ([`src/api/recall.ts:57-77`](../../src/api/recall.ts#L57-L77)).

The gateway injection path also counts the final selected IDs ([`src/memory/inject.ts:63-76`](../../src/memory/inject.ts#L63-L76)), but it does not write the same recall event.

The MCP retrieve route writes `recall_search_observed` when E-axis trace data exists ([`src/api/mcp.ts:448-471`](../../src/api/mcp.ts#L448-L471)), while its underlying search counts recalls only when `recordRecall` is explicitly true ([`src/memory/search.ts:137-138`](../../src/memory/search.ts#L137-L138)). No current call site supplies that option.

The result is an inconsistent signal boundary:

| Entry point | Lifetime counter | Audit event | Should count as use? |
|---|---:|---:|---:|
| API context injection | Yes | `recall_context_injected` | Yes |
| Gateway context injection | Yes | No equivalent event | Yes |
| MCP `retrieve_memory` | No | `recall_search_observed` in traced cases | Yes; count all deduplicated returned memory IDs once per operation |
| Exact/search-only result | No | Usually no | No |

Before adding advanced M policies, these entrypoints must call one shared writer. Layla's product decision is to treat a successful explicit MCP `retrieve_memory` response as recall exposure: the service cannot know which returned item the model ultimately used, so it counts every deduplicated returned memory ID once for that operation. Internal ranking candidates and exact/list/search-only results still do not count. Keeping `source = mcp_retrieve`, capping effective daily contribution, and requiring multiple active days prevents occasional broad MCP results from dominating M policy metrics.

### 3.2 Current M archive policy

The scanner protects `identity`, `relationship_moment`, `diary`, `layla_diary`, and `auto_diary`. Its current cold threshold is **90 days**, not 180 days ([`src/memory/metabolismReview.ts:16-25`](../../src/memory/metabolismReview.ts#L16-L25)).

For the `cold_low_signal` branch, a memory must be active, unpinned, outside the protected types, older than the cutoff, not recalled since the cutoff, never recalled, below the importance and confidence limits, and not referenced by a relation. The query is batched and capped at 50 rows ([`src/memory/metabolismReview.ts:36-75`](../../src/memory/metabolismReview.ts#L36-L75)).

The scanner upserts stable `m_archive` candidates instead of mutating memory directly ([`src/memory/metabolismReview.ts:79-106`](../../src/memory/metabolismReview.ts#L79-L106)). Candidate upsert only refreshes unresolved candidates with the same external key ([`src/db/memoryCandidates.ts:51-68`](../../src/db/memoryCandidates.ts#L51-L68)).

Approval supports only `m_archive` and `m_relation_cleanup` today. Before archiving a `cold_low_signal` memory, it rechecks recall count, age, thresholds, and relation anchors, then snapshots the record and changes it to `status = archived` and `active_fact = false` ([`src/api/adminBoard/metabolismActions.ts:44-97`](../../src/api/adminBoard/metabolismActions.ts#L44-L97)). Rollback restores the snapshot ([`src/api/adminBoard/metabolismActions.ts:163-205`](../../src/api/adminBoard/metabolismActions.ts#L163-L205)).

This review-first and reversible contract is the foundation for every policy proposed below.

### 3.3 Existing event storage is not an analytics table

`memory_events` contains an event type, optional memory ID, JSON payload, and timestamp ([`migrations/0001_init.sql:79-85`](../../migrations/0001_init.sql#L79-L85)). E-axis observation reads recent event payloads in a bounded batch ([`src/memory/eAxisObservability.ts:125-139`](../../src/memory/eAxisObservability.ts#L125-L139)).

There is no `recall_runs` table in the current schema. Recall IDs are often embedded as arrays inside event JSON, signal coverage differs by entrypoint, and `memory_events` has no dedicated `(namespace, event_type, created_at)` analytics index. Expanding historical JSON arrays every nightly scan would therefore be an unsuitable long-term metric source.

Existing events remain useful for diagnostics and a best-effort shadow comparison, but they must not be the sole source for mutation candidates.

## 4. Why the current signals are insufficient

### 4.1 Previously hot, now cold

The condition `recall_count = 0` deliberately excludes every previously recalled memory. It cannot distinguish a durable memory still in use from one used frequently a year ago and never touched since.

### 4.2 Recent warming

`recall_count` is lifetime-only. A count of 20 may mean twenty uses this week or twenty uses across three years. `last_recalled_at` cannot express velocity or repeated active days.

### 4.3 Repeated-loop inflation

A single automated loop can retrieve the same memory many times. Raw count alone would incorrectly promote it. Metrics need a capped daily contribution and a minimum number of distinct active days.

### 4.4 Outcome attribution

The system does not currently have a stable recall ID shared across context injection and a later user outcome. Treating “the user sent another message” as success would be false attribution. Outcome-based metabolism should be deferred until its contract can be defined independently.

## 5. Storage options

### Option A1: More rolling fields on `memories`

Example fields:

- `weekly_recall_count INTEGER`
- `weekly_window_started_at TEXT`

Advantages:

- Simple point lookup.
- Small implementation surface for one fixed window.

Disadvantages:

- Reset/update races at window boundaries.
- Poor support for 7-, 30-, 90-, and 180-day questions simultaneously.
- Every recall writes the already-hot `memories` row again.
- Historical behavior cannot be recomputed after threshold changes.

### Option A2: JSON history on `memories`

Example: `recalled_at_history TEXT` containing the last N timestamps.

Advantages:

- Keeps recent timestamps beside the memory.

Disadvantages:

- Read-modify-write races can lose timestamps.
- JSON parsing and trimming on every recall increases write amplification.
- Batched window aggregation is awkward in D1.
- A fixed N truncates high-frequency history unevenly.

This option is rejected.

### Option B: Aggregate existing `memory_events`

Advantages:

- No new capture table.
- Preserves append-only diagnostic events.

Disadvantages:

- Current entrypoints do not emit equivalent events.
- IDs may be stored inside JSON arrays rather than `memory_id`.
- Historical JSON expansion is expensive and difficult to index.
- Events are audit/observability records, not a stable metric contract.

This option is suitable only for shadow comparison or best-effort backfill.

### Recommended option: normalized daily rollup

Add a dedicated table:

```sql
CREATE TABLE memory_recall_daily (
  namespace TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  recall_day TEXT NOT NULL,
  source TEXT NOT NULL,
  recall_count INTEGER NOT NULL DEFAULT 0,
  first_recalled_at TEXT NOT NULL,
  last_recalled_at TEXT NOT NULL,
  PRIMARY KEY (namespace, memory_id, recall_day, source)
);

CREATE INDEX idx_memory_recall_daily_window
  ON memory_recall_daily(namespace, recall_day, memory_id);

CREATE TABLE memory_recall_receipts (
  namespace TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (namespace, operation_id, memory_id, source)
);

CREATE INDEX idx_memory_recall_receipts_expiry
  ON memory_recall_receipts(created_at);
```

Initial source values:

- `api_context`
- `gateway_injection`
- `mcp_retrieve`

A future shared `recordRecallSignals()` repository function should:

1. require a stable recall `operation_id` from the calling boundary;
2. accept only final selected/injected memory IDs;
3. deduplicate IDs within one recall operation;
4. claim `(namespace, operation_id, memory_id, source)` receipts;
5. increment lifetime counters and daily rollups only for newly claimed receipts; and
6. optionally write one audit event with the same source and operation ID.

The receipt claim and counter/rollup updates must be atomic. The recommended implementation is an `AFTER INSERT` trigger on `memory_recall_receipts`: `ON CONFLICT DO NOTHING` suppresses a repeated receipt, and the trigger updates lifetime counters and the daily rollup only for a newly inserted receipt. An equivalent transactional implementation is acceptable if it preserves the same invariant. If an entrypoint cannot provide a stable operation ID across delivery retries, it cannot claim exactly-once accounting and must be fixed at that orchestration boundary before it participates in advanced M metrics. Receipt rows may be deleted after a short retry-safety window, recommended at 7 days.

Daily aggregation bounds long-term table growth, allows multiple windows from the same rows, and permits thresholds to change without reconstructing raw chat history. Source separation also makes accidental inflation visible; the short-lived receipt table supplies retry idempotency without becoming the long-term analytics source.

Recommended retention is 400 days. Lifetime counters remain on `memories`; daily rows older than the retention window may be deleted by maintenance after the advanced policies have operated in shadow for at least one full cold window.

### Capacity budget

A read-only production snapshot on 2026-07-19 showed:

- one namespace and 1,180 memories, including 837 active memories;
- a current D1 size of approximately 10.7 MB;
- 70 API recall exposures across 48 observed operations since 2026-07-12 (gateway injection does not yet emit an equivalent event); and
- 26 MCP search exposures across four observed operations since 2026-07-13.

At the current observable rate of roughly 15 memory exposures per day, the conservative upper bound is about 6,000 daily-rollup rows over 400 days and about 105 seven-day receipt rows. The daily table will normally be smaller because repeated exposure of the same memory/source/day shares one row.

At 10 times the current traffic, the corresponding planning bound is approximately 60,000 daily rows and 1,050 live receipt rows. Phase 1 therefore sets a 64 MB storage budget for the new tables and indexes combined. As of 2026-07-19, [Cloudflare's D1 limits](https://developers.cloudflare.com/d1/platform/limits/) are 500 MB per database on Free and 10 GB on Workers Paid; [D1 indexes also consume database storage](https://developers.cloudflare.com/d1/best-practices/use-indexes/). The shadow report must measure actual row count and database growth before Phase 2 rather than relying on this estimate.

If the added storage approaches 64 MB, implementation must not silently continue at 400 days. The next review chooses either a 180-day retention window or aggregation of rows older than 90 days into weekly buckets.

## 6. Metrics

For one memory at scan time, load all required windows in a single grouped query or CTE:

- `recalls_7d`, `recalls_30d`, `recalls_90d`, `recalls_180d`
- `active_days_7d`, `active_days_30d`, `active_days_90d`
- `last_recalled_at`
- lifetime `recall_count`

To reduce loop inflation, policy counts should use an effective daily count:

```text
effective_daily_count = min(raw_daily_count, 3)
```

An optional heat score may be observed during shadow mode:

```text
heat_30d = sum(
  min(daily_count, 3) * 2 ^ (-age_days / 14)
)
```

The initial half-life is 14 days, with an allowed tuning range of 7–30 days. Heat must not be the sole trigger for a mutation candidate. Candidate policies should also require distinct active days and fixed window counts so the decision remains explainable.

## 7. Metric-to-action mapping

### 7.1 `m_archive`

#### Existing `cold_low_signal` policy

Keep unchanged:

- never recalled (`recall_count = 0`);
- cold for 90 days;
- active and unpinned;
- outside protected types;
- importance at or below 0.35;
- confidence at or below 0.60;
- no relation anchor;
- human approval, snapshot, revalidation, and rollback.

The existing regression test locks the never-recalled and no-relation behavior ([`tests/metabolism-cold-memory.test.ts:5-43`](../../tests/metabolism-cold-memory.test.ts#L5-L43)). The Worker circuit locks approval and rollback ([`tests-worker/z-m-axis-circuit.test.ts:238-290`](../../tests-worker/z-m-axis-circuit.test.ts#L238-L290)). These tests must continue to pass without fixture changes.

#### Proposed additive `cooled_after_use` policy

After at least 30 days of shadow observation, propose an archive candidate only when all conditions hold:

- lifetime `recall_count >= 5`;
- `last_recalled_at < now - 180 days`;
- `recalls_30d = 0` and `recalls_90d = 0`;
- active, unpinned, outside protected types;
- importance at or below 0.35;
- confidence at or below 0.60;
- no relation anchor;
- no unresolved archive candidate and no archive decision within cooldown.

Tuning ranges:

- prior recall minimum: 3–10;
- cold duration: 120–365 days;
- cooldown: 30–60 days.

This policy is additive; it must not replace or broaden `cold_low_signal`.

### 7.2 Proposed `m_promote`

Promotion means proposing a modest importance increase, not changing memory type or fact state.

The repository uses a 0–1 importance scale: the MCP input schema explicitly constrains importance to that range ([`src/api/mcp.ts:189-210`](../../src/api/mcp.ts#L189-L210)). The proposed `+0.10` step and `0.80` cap therefore use the existing scale rather than introducing a new unit.

Initial candidate conditions:

- `effective_recalls_7d >= 3`;
- `effective_recalls_30d >= 5`;
- `active_days_30d >= 2`;
- current importance below 0.80;
- active and outside diary/automatic diary types;
- no unresolved promotion candidate;
- no approved/rejected/rolled-back promotion within 30 days.

Suggested approved mutation:

```text
importance = min(current_importance + 0.10, 0.80)
```

Approval must requery the windows, compare the candidate's memory snapshot/version, store the old importance, synchronize the vector record when required, and support rollback.

Tuning ranges:

- 7-day threshold: 3–5;
- 30-day threshold: 5–12;
- required active days: 2–4;
- increase step: 0.05–0.15;
- cooldown: 30–60 days.

No promotion should occur automatically, and multiple recalls in one operation or one day must not bypass the active-day rule.

### 7.3 Proposed `m_mark_review`

This should initially be a review card, not a direct mutation of `audit_state`.

Possible trigger:

- high sustained reuse (`effective_recalls_30d >= 8`, `active_days_30d >= 3`); and
- low confidence (`confidence <= 0.60`) or an existing contradiction/review signal.

The card asks a reviewer to improve, merge, clarify, or leave the memory unchanged. The final action should be routed to the owning axis or existing candidate action rather than letting M silently rewrite content.

### 7.4 `split_thread`

Recall frequency is not sufficient evidence that a thread should split. At most, heat may gate a later coherence analysis:

- `effective_recalls_30d >= 8`;
- `active_days_30d >= 3`;
- thread has enough members; and
- a separate semantic analyzer identifies distinct clusters.

This requires its own RFC and is out of scope for the first implementation.

### 7.5 `supersede`

Supersession belongs to the Z-axis fact-conflict workflow. M may surface a review signal, but it must not implement a second supersession mutation path.

### 7.6 `distill_growth`

Recall heat alone cannot justify generating a new durable memory. A future review-only proposal would require:

- at least three supporting source memories;
- repeated use across at least 30 days;
- shared thread or fact context;
- explicit evidence links; and
- semantic distillation validation.

This is phase 3 and requires a separate content-generation contract.

### 7.7 `m_relation_cleanup`

Keep the existing stale/broken relation policy unchanged. Recall heat is not sufficient evidence for deleting a relation, and its Worker approval/rollback circuit must remain intact ([`tests-worker/z-m-axis-circuit.test.ts:292-343`](../../tests-worker/z-m-axis-circuit.test.ts#L292-L343)).

## 8. Cooldown and anti-oscillation rules

Every new policy must use a stable external candidate key including:

- namespace;
- memory ID;
- action;
- policy version; and
- threshold-crossing window or band.

The scanner must batch-load existing candidates and recent decisions. It must not issue a candidate-history query per memory.

A new candidate is suppressed when:

- an unresolved candidate for the same memory/action already exists; or
- the same action was approved, rejected, or rolled back during its cooldown.

Approval must revalidate metrics and the memory version. If the memory cooled, warmed, was archived, became pinned, gained a relation anchor, or changed importance outside the allowed range, approval should resolve as stale/no-op rather than apply old evidence.

Archive and promotion bands must not overlap. If both appear possible because of configuration error, archive takes no action and emits a configuration audit signal.

## 9. Audit and admin visibility

During shadow mode, write `metabolism_signal_observed` only when one of these occurs:

- a memory enters or leaves a metric band;
- a candidate would be proposed;
- a candidate is suppressed by cooldown; or
- an approval revalidation changes the outcome.

Do not write an event for every memory on every nightly scan.

The event payload should include:

- memory ID and namespace;
- source window counts and active days;
- capped heat score;
- policy and scanner version;
- thresholds used;
- proposed action;
- suppression/revalidation reason.

It must not include raw user queries or recalled chat text.

The admin card should show the same evidence, the current memory fields, last recall time, relation-anchor status, proposed mutation, cooldown state, and rollback availability.

## 10. Outcome signal: deferred decision

An eventual `recall_outcome_observed` event may be useful, but only after the system has:

- a stable recall operation ID;
- an explicit attribution window;
- a small outcome enum such as `accepted`, `corrected`, `ignored`, or `unknown`;
- a privacy policy that excludes raw reply text; and
- a defined producer responsible for the label.

Until then, outcome must remain absent rather than be guessed from message continuation. Advanced M v1 uses only observable selection frequency and time.

## 11. Proposed implementation phases

### Phase 0: approve this RFC

- Confirm thresholds, source weights, cooldown, and rollout policy.
- Make no production behavior change.

### Phase 1: unify and observe recall signals

- Add the `memory_recall_daily` migration and indexes.
- Add repository methods for batched upsert and window aggregation.
- Introduce `recordRecallSignals()` and route API injection, gateway injection, and MCP retrieval through it.
- Keep exact/search-only results uncounted.
- Emit sparse `metabolism_signal_observed` events.
- Run for at least 30 days in shadow mode.
- Create no new archive/promotion candidate.

### Phase 2: review-first policies

- Add `cooled_after_use` as a second `m_archive` policy.
- Add typed `m_promote` and, if approved, `m_mark_review` candidate handling.
- Extend admin rendering, revalidation, snapshot, vector synchronization, axis-run resolution, and rollback.
- Preserve the existing action registry and candidate-state contracts.

### Phase 3: semantic proposals

- Consider `split_thread` and `distill_growth` only under separate RFCs with semantic evidence and dedicated behavior tests.

## 12. Estimated code impact

Expected Phase 1 changes:

- one D1 migration for the daily rollup and short-lived receipt tables plus indexes;
- a recall-signal repository module;
- shared orchestration replacing the current entrypoint-specific counter/event calls;
- a batch aggregation query used by M nightly maintenance;
- admin/shadow observability additions;
- unit and Worker behavior tests.

Expected Phase 2 changes:

- new branches in `metabolismReview.ts`;
- typed M actions and admin handlers;
- candidate list/view updates;
- approval revalidation, snapshot, vector sync, rollback, and axis-run status tests.

The window aggregation must be one batch query/CTE for each scanner page, not N+1 queries.

## 13. Verification requirements

Phase 1 cannot be considered complete without tests proving:

1. API, gateway injection, and MCP retrieval write equivalent daily signals for final selected IDs.
2. Duplicate IDs in one operation increment only once.
3. Search-only candidates do not increment recall metrics.
4. Reusing the same stable operation ID under repeated delivery increments counters and rollups only once.
5. Window aggregation returns correct counts and active days at boundary timestamps.
6. Source-specific rows sum correctly without hiding source skew.
7. Existing `cold_low_signal` fixtures remain unchanged and green.

Phase 2 additionally requires Worker behavior tests for:

1. candidate generation and deduplication;
2. cooldown suppression;
3. approval-time stale evidence;
4. snapshot and vector synchronization;
5. rollback;
6. axis-run status reconciliation; and
7. no candidate creation during shadow mode.

## 14. Risks and mitigations

### Signal inflation

Mitigate with per-operation deduplication, capped daily counts, active-day minimums, source visibility, and human approval.

### Entry-point drift

Mitigate by having all final-use paths call one shared function and by testing each entrypoint against the same contract.

### D1 write pressure

Use batch upserts, one long-lived row per memory/source/day, 7-day receipt retention, and bounded daily-rollup retention. Do not store every recall as a new long-lived analytics row.

### Scanner query cost

Use a single grouped CTE per candidate page, a window index, and a hard page limit. Do not expand historical JSON or query each memory separately.

### Threshold churn

Version policies, shadow new thresholds, log band transitions sparsely, and require cooldown before repeat candidates.

### Incorrect automatic mutation

There is none. Every new M action remains review-first, revalidated, snapshotted, and reversible.

## 15. Decisions approved by Layla

Layla approved the RFC recommendations on 2026-07-19 with an explicit clarification for MCP retrieval:

1. Keep the existing 90-day never-recalled baseline unchanged. **Approved.**
2. Enable additive `cooled_after_use` after a 30-day shadow period with a 180-day cold threshold. **Approved.**
3. Use normalized daily rollups rather than JSON history or direct `memory_events` aggregation. **Approved.**
4. Count every deduplicated memory returned by a successful explicit MCP `retrieve_memory` operation once, while excluding internal ranking and exact/list/search-only results. **Approved.**
5. Use `+0.10`, capped at `0.80`, for an approved promotion, subject to shadow data. **Approved.**
6. Require at least two active days for promotion. **Approved.**
7. Defer outcome tracking until recall attribution is explicit. **Approved.**
8. Retain daily rollups for 400 days, subject to the 64 MB budget and post-shadow reassessment. **Approved.**

Phase 1 implementation may begin only after this approved RFC is merged. Phase 2 remains gated on the 30-day shadow report.
