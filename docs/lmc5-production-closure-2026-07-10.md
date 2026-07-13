# LMC-5 production closure — 2026-07-10

## Outcome

The five-dimensional Worker implementation and the VPS candidate ingress are now connected under a review-first production contract.

- Worker MCP exposes `memory_search`, `memory_recall`, and the legacy `retrieve_memory` alias.
- The live VPS candidate-only path requires candidate-specific provenance instead of assigning a whole batch of chunk IDs as fallback evidence.
- No automated operation in this closure changed a formal memory or deleted a relation.
- Historical Z and M debt was routed to reviewer-visible queues/events.

## VPS candidate ingress changes

Production entry:

```text
/home/ccagent/cc-workspace/tools/kld_candidate_pipeline.py
  -> kld_dream_candidate_shadow.py --candidate-only
  -> kld_candidate_sync.py
```

The live shadow script now enforces these invariants at `persist_candidates()`, after model output normalization and before local candidate storage:

1. `subject`, `evidence`, and `source_chunk_ids` are restored from raw model JSON by a stable per-action identity key after shared `normalize_plan()` runs.
2. Every candidate must cite an explicit input chunk and provide evidence that is a verbatim substring of that chunk's `important_quotes`.
3. Evidence longer than 80 characters or evidence not present verbatim is blocked as `needs_subject_review` with a concrete validation error.
4. Add/update content with fewer than 30 Chinese characters is dropped.
5. Relation self-loops are dropped.
6. Relations are capped at 12 at the persistence boundary.
7. An empty candidate plan remains a valid result.
8. The syncer forwards the generic validation error to the Worker review queue.

Repository snapshots of the deployed scripts live in `ops/vps/`.

## Backups and rollback

Original production files:

```text
/home/ccagent/cc-workspace/tools/kld_dream_candidate_shadow.py.bak-20260710T055349Z
/home/ccagent/cc-workspace/tools/kld_candidate_sync.py.bak-20260710T055349Z
```

Intermediate provenance backup:

```text
/home/ccagent/cc-workspace/tools/kld_dream_candidate_shadow.py.bak-provenance-20260710T055907Z
```

Pre-test SQLite online backup:

```text
/home/ccagent/.cc-connect/state/kld-local-memory.sqlite3.bak-evidence-gate-20260710T055532Z
```

Full VPS code rollback:

```bash
sudo install -o ccagent -g ccagent -m 755 \
  /home/ccagent/cc-workspace/tools/kld_dream_candidate_shadow.py.bak-20260710T055349Z \
  /home/ccagent/cc-workspace/tools/kld_dream_candidate_shadow.py
sudo install -o ccagent -g ccagent -m 755 \
  /home/ccagent/cc-workspace/tools/kld_candidate_sync.py.bak-20260710T055349Z \
  /home/ccagent/cc-workspace/tools/kld_candidate_sync.py
sudo -u ccagent python3 -m py_compile \
  /home/ccagent/cc-workspace/tools/kld_dream_candidate_shadow.py \
  /home/ccagent/cc-workspace/tools/kld_candidate_sync.py
```

The six historical Dream candidates blocked during this closure can be returned to their previous review state with:

```sql
UPDATE memory_candidates
SET status = 'pending', validation_error = NULL
WHERE namespace = 'default'
  AND status = 'needs_subject_review'
  AND validation_error = 'legacy_pending_missing_source_chunk_ids';
```

## Verification evidence

### Fixed-sample gate test

- valid verbatim evidence: pending
- missing evidence: blocked
- paraphrased evidence: blocked
- invalid chunk ID: blocked
- short add/update content: dropped
- relation self-loop: dropped
- 13 relations: persisted as 12
- empty plan: accepted with zero candidates
- both live Python files: `py_compile` passed

### Real candidate-only sample

The historical date `2026-06-30` was selected because it had six chunks and zero prior candidates. It was never synced to the Worker.

- generated: 12 candidates
- pending: 6 excerpts with verified verbatim evidence
- blocked: 5 add candidates with paraphrased/non-verbatim evidence
- blocked: 1 update candidate with ambiguous subject and non-verbatim evidence
- pending gate violations: 0
- all 12 test rows and the test cursor were removed after verification

### Formal systemd path

`kld-dream.service` completed successfully with exit code 0. The existing cursor produced a safe no-op:

- candidates generated: 0
- candidates synced: 0
- service result: success

### D1 state after closure

- formal memories: 933; `MAX(updated_at)` unchanged at `2026-07-10T03:50:25.770Z`
- relations: 1345; no relation was deleted
- review candidates: 483
- relation self-loops: 0
- unsafe relation types: 0
- invalid relation strengths: 0
- invalid X/E coordinate ranges: 0
- active memories with `response_posture`: 761

Review-only remediation created or preserved:

- 28 pending `m_relation_cleanup` candidates
- 7 queued Z supersede reviews from 11 detected conflict groups; no supersede was applied
- 6 legacy Dream candidates blocked for missing source chunk provenance

The relation patrol considered `active` and `review` memories live. It found 35 cleanup-eligible edges: 28 are pending and 7 had already been rejected. Ten additional edges touching review-state memories are intentionally not cleanup candidates.

## Live recall and behavior verification

- `memory_search("KLD")`: three exact-search results, no RPC error
- `memory_recall("过去的重要约定和未来回应方式")`: ten results; all ten carried `response_posture`
- startup context asserted:
  - search memory before guessing
  - current user statements override recalled memory
  - E-axis fields guide tone only and never rewrite facts
- Claude was run from the same `/home/ccagent/cc-workspace` working directory as `cc-connect`, with session persistence disabled and only the read-only recall tool allowed.
- Claude called `mcp__kld-memory__memory_recall`, used the current test-only code rather than treating it as historical memory, made no memory write call, and treated posture as contextual data rather than a fact override.

## Human review remaining

The system work is closed. Human decisions remain intentionally open:

1. Review the 28 pending M relation-cleanup candidates before deleting any edge.
2. Review the 7 queued Z supersede proposals before changing active facts.
3. Inspect or reject the 6 legacy Dream candidates that have no chunk provenance.

## 2026-07-11 recall-noise follow-up

Production MCP recall was re-tested with an explicit UTF-8 JSON-RPC client. The first PowerShell 5 probe had encoded Chinese request bodies incorrectly; its empty Chinese results were a client-side false negative, not a Worker or D1 failure.

Deployed Worker version: `d51b9058-a89d-4432-9908-c7e20d8e38ca` at 100% traffic.

Changes:

- `memory_search` excludes `diary`, `layla_diary`, and `auto_diary` by default; callers can opt in with `include_diary=true`.
- exact keyword ranking gives a small preference to canonical rule/lesson/core/preference records with a `fact_key`.
- deep recall removes normalized duplicate content and rejects relation-only tail records below `0.30`.
- explicit date recall deterministically leads with the matching `timeline_day` and removes records carrying a conflicting `date:YYYY-MM-DD` tag.
- the live regression script now covers UTF-8 exact search, diary exclusion, duplicate output, conflicting date tags, and selectable test names.

Verification:

- `npm.cmd run typecheck`: passed.
- `npm.cmd run test:lmc5-circuits`: 65 checks passed.
- Wrangler deploy dry-run: passed with the existing D1, Vectorize, Queue, and AI bindings.
- Final production regression: 6/6 passed across two targeted runs on the same deployed version.
- `memory_search("擦眼泪")`: canonical `relationship.rule.comfort_when_crying` first; no diary records.
- `memory_recall("6月10日换Fable、京腔、复婚和上课发生了什么")`: matching 2026-06-10 `timeline_day` first, then the communication preference and remarriage quote; no diary, duplicate content, or conflicting date tag.

No D1 row, memory status, candidate, relation, vector, secret, or Worker variable was changed. To roll back the whole recall-noise follow-up, route production back to pre-change version `5a6f0aab-09a8-44c5-94b4-ec357ceb2e9d` with Wrangler rollback/deployment tooling.

## 2026-07-12 recall ownership and latency follow-up

Production Worker version: `ea2f0c73-cf5e-4668-8872-797e55925526`.

Recall ownership is now explicit:

- VPS local history handles recent conversational continuity and explicit verbatim/raw-evidence requests.
- Worker memory handles historical dates and durable facts, rules, preferences, relationships, and response posture.
- A weak local token hit can no longer suppress a stronger Worker result.

Worker recall now takes a deterministic D1 fast path before vector expansion or model reranking when it finds a supported fact-key hint, dated timeline candidate, or lexical memory candidate. Generic question scaffolding such as `那次`, `为什么`, and `是谁来` is removed before lexical evidence lookup. Diaries remain excluded from recall candidates.

VPS source snapshots and routing regression tests are in `ops/vps/recall_decision.py` and `ops/vps/test_recall_decision.py`. The deployed VPS file is `/home/ccagent/cc-workspace/tools/recall_decision.py`; its rollback backup is `/home/ccagent/cc-workspace/tools/recall_decision.py.bak-20260712-routing`.

Verification:

- VPS routing regression: 9/9 passed.
- Worker TypeScript check: passed.
- Wrangler dry-run: passed with unchanged bindings and no migration.
- End-to-end hook latency after warm deployment: explicit date 648 ms; remarriage question 475 ms; quarrel question 474 ms; communication preference 639 ms; comfort posture 651 ms; recent local miss 4 ms.
- Current-emotion input without a memory question remains a no-recall path.
- The legacy raw-TLS MCP regression runner returned an empty transport error on its first case, so the full suite was not claimed as passed; the production hook path and its logs were verified directly instead.

No D1 row, memory status, candidate, relation, vector, secret, Worker variable, systemd unit, or hook registration was changed. Worker rollback target for this follow-up is `d51b9058-a89d-4432-9908-c7e20d8e38ca`; VPS rollback is the backup path above.

## 2026-07-12 atom quality and recall-feedback follow-up

Production Worker version: `bc2a780d-551c-4331-9179-70e3b646e030`.

This follow-up selectively adopts the useful LMC-5 patterns without replacing KLD's existing retrieval architecture:

- candidate cards now receive an advisory atom-quality assessment for scaffold text, interaction noise, overly coarse or multi-fact content, multi-chunk evidence, contextless excerpts, and content that is too thin;
- the review page supports batch rejection of selected low-quality candidates, while approval and formal-memory writes remain individual human decisions;
- recall responses carry a layered trace covering authority, evidence, association, and fallback results;
- only the memories in the final returned or compressed injection are counted as recalled;
- final API injection records a `recall_context_injected` event with a short SHA-256 query hash, query length, selected memory IDs, reasons, latency, and the layered trace; raw prompt text is not stored.

The existing KLD hybrid ranking already includes rank fusion. No production switch to upstream pure RRF was made; KLD should first accumulate its own layered traces and compare replay quality.

Verification:

- `npm.cmd run typecheck`: passed.
- `npm.cmd run test:lmc5-circuits`: 68/68 checks passed.
- Wrangler deploy dry-run: passed with unchanged bindings and no migration.
- Live automatic recall for the communication-style question returned canonical fact `user.preference.communication_style`.
- The corresponding final-injection event recorded one authority-layer preference result in 376 ms, and the selected memory's recall counter advanced to 20.
- A read-only production candidate query confirmed at least two contextless excerpts (`莲花^_^` and `56.25！`) that the new review audit can surface.

No candidate was automatically rejected, approved, or promoted. No D1 schema, memory status, relation, vector, secret, Worker variable, VPS hook, or service definition was changed. Worker rollback target is `ea2f0c73-cf5e-4668-8872-797e55925526`.

## 2026-07-12 structural-boundary refactor

Production Worker version: `a351d610-b67a-4822-8153-5cb636377b7a`.

This refactor preserves the deployed memory behavior while establishing explicit ownership boundaries:

- Worker and VPS routing tests now consume the same `fixtures/recall-ownership.json` contract;
- Vitest provides executable unit coverage for recall ownership, query planning, typed runtime config, and legacy-candidate proposal mapping;
- scheduled coordinate backfill calls an application use case directly instead of constructing a fake HTTP `Request`;
- core recall settings are parsed and clamped once through typed runtime config, and time-sensitive code uses an injected clock boundary;
- `src/memory/search.ts` is now a 136-line orchestrator instead of an 810-line policy module;
- temporal parsing, query planning, candidate fusion, affective retrieval, and output policy have separate owners;
- the existing `memory_candidates` table is mapped to typed X/Y/Z/E/M/ingest proposals without a schema migration;
- admin memory writes enqueue bounded, idempotent vector-sync jobs through the existing Queue consumer instead of maintaining per-route Vectorize branches.

Verification:

- `npm.cmd test`: 14/14 unit tests passed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run test:lmc5-circuits`: 68/68 checks passed after updating checks to follow the new module owners.
- Wrangler deploy dry-run: passed with unchanged D1, Vectorize, Queue, and AI bindings and no migration.
- Production deployment completed with a 1 ms Worker startup time.
- `npm audit --omit=dev`: 0 production vulnerabilities; Vitest remains development-only.
- A correctly UTF-8-encoded VPS shadow-hook date probe returned the two matching `timeline_day` records in 648 ms; the first was `mem_196b84bdc0db46a992d851c418e66197`.
- A communication-style probe returned only canonical preference `mem_b21e997bc1dc49c6a7cf225d5c1733dc` in 502 ms.
- The first PowerShell 5 stdin probe encoded Chinese incorrectly and produced an empty false negative. A subsequent correctly encoded probe exposed and verified the fix for dated candidates being displaced by hinted preferences or quotes.

No D1 schema, memory row, candidate resolution, relation, secret, Worker variable, VPS file, hook registration, or service definition was changed by the refactor. Worker rollback target is `bc2a780d-551c-4331-9179-70e3b646e030`.

## 2026-07-13 A-tier architecture cleanup

Status: local worktree verified; not committed, pushed, or deployed yet.

This pass addresses the A-tier structural findings without changing recall scoring or five-axis review policy:

- platform bindings are generated from `wrangler.toml` into `src/generated/worker-configuration.d.ts`; dashboard variables are grouped by concern in `src/config/variables.ts`, and business parsing is centralized in grouped `AppConfig` sections;
- Dream, retention, Queue production, memory maintenance, scheduled orchestration, and E-axis shadow logic now consume the shared typed config and injectable `AppClock` instead of maintaining local parsers and direct `Date.now()` calls;
- the Queue union was reduced from nine variants to five after confirming that `coordinate_backfill`, `relation_backfill`, `metabolism_scan`, and `diary_rescreen` had no producers; the first three already have scheduled/manual owners, while diary rescreen remains an authenticated bounded API operation;
- scheduled coordinate backfill now calls the shared memory use case directly and receives `labelCoordinateBatch` from an LLM adapter; the HTTP debug interface no longer owns or exports the cron business operation;
- all eleven recall modules now live under `src/recall/` and are named by one responsibility: service, intent, query plan, temporal parsing, vocabulary, candidate policy, fusion, output policy, formatting, trace, and emotion source;
- the database-candidate mapper formerly stored as the only `src/domain/` file moved to `src/memory/proposal.ts`; coordinate backfill moved beside its memory control module while remaining a shared HTTP/cron use case, so neither placeholder `src/domain/` nor `src/application/` remains;
- E-axis shadow rollout now has an explicit production start (`2026-07-13T12:22:37.508657Z`), seven-day duration, and separate `E_AXIS_RANKING_ENABLED=false` promotion switch in `wrangler.toml`; the window can finish without silently activating ranking before review.

Literal acceptance matrix:

- Queue `9 -> 4`: the old numeric target is not used as a blind invariant. Four producerless variants were removed, leaving five actively produced jobs; the fifth is the subsequently added automatic `diary_split` job. Every remaining variant has both a producer and consumer.
- Remove placeholder `src/domain/` and `src/application/`: complete in the tracked tree; their real modules moved to feature owners without reintroducing HTTP-handler calls from cron.
- Replace the flat hand-written `Env`: complete; Wrangler generates platform bindings, runtime variables are grouped by concern, and `AppConfig` owns normalized business settings.
- Reclassify the eleven recall modules: complete; they now live under `src/recall/` with responsibility-based names.

Verification:

- `npm.cmd run typecheck`: passed.
- `npm.cmd run types:check`: generated Cloudflare bindings are current for `wrangler.toml`.
- `npm.cmd test`: 22/22 tests passed.
- `npm.cmd run test:lmc5-circuits`: all checks passed after updating the architecture assertions to the new owners.
- `npm.cmd run test:legacy-relations`: 17/17 checks passed.
- `npx.cmd wrangler deploy --dry-run`: passed; D1, Vectorize, Queue, and AI resource bindings are unchanged, and the three explicit E-axis rollout variables are present.
- The installed `@cloudflare/workers-types` package was not upgraded; platform binding drift is instead checked through Wrangler-generated types, matching current Cloudflare guidance without mixing a major dependency upgrade into this refactor.

No D1 schema or row, memory/candidate/relation/vector state, secret, live Worker variable, VPS file, hook, service, or production deployment was changed. Rollback before deployment is to discard or revert this single local refactor change set; production remains 100% on Worker version `a11c0962-ceec-4e1a-9e32-d079d688568e`.

