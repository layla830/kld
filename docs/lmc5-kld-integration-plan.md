# LMC-5 / Aelios / KLD Integration Plan

## Purpose

This note preserves the current decision frame for continuing the KLD memory work after context compression.

Do not replace KLD with the upstream LMC-5 repo or the Aelios fork. The intended path is:

- Use `wuxuyun0606-collab/lmc-5` as the conceptual source of truth for the five-axis model.
- Use `wusaki0723/Aelios/tree/lmc5-xyzem-memory` as a Cloudflare/D1 implementation reference.
- Keep `layla830/kld` as the production memory service and adapt only the parts that fit its current schema, recall flow, and deployed Worker.

## Source Roles

### LMC-5

Repository: https://github.com/wuxuyun0606-collab/lmc-5

LMC-5 defines the model:

- X: Timeline. Where a memory belongs in history/thread.
- Y: Relations. Which memories support, contradict, explain, or connect to it.
- Z: Fact Evolution. Whether a fact is current, historical, superseded, or under review.
- E: Experience Signals. Risk, urgency, tension, and response posture.
- M: Metabolism. Promote, demote, review, archive, or distill.

Use this repo for semantics and implementation order, not direct KLD code.

### Aelios XYZEM Branch

Repository branch: https://github.com/wusaki0723/Aelios/tree/lmc5-xyzem-memory

Useful references:

- `migrations/0003_lmc5_xyzem.sql`
- `src/memory/coordinates.ts`
- `src/memory/search.ts`
- `src/memory/xyzem.ts`
- `scripts/backfill-xyzem-memories.mjs`

Aelios translates LMC-5/XYZEM ideas into a Cloudflare Worker + D1 shape. Do not copy the whole branch. KLD has its own production D1, Vectorize, recall flow, scripts, deployed Worker, and data.

## Current KLD State

Snapshot as of 2026-06-19:

- Added `fact_key` and `active_fact` to memories.
- Backfilled selected high-value long-term facts.
- Added `memory_relations`.
- Imported reviewed relation batches from DS output.
- Added and expanded `queryHints` so common questions can directly target known fact keys.
- Added lightweight LMC-5 coordinate fields on memories:
  - `thread`
  - `risk_level`
  - `urgency_level`
  - `tension_score`
  - `response_posture`
  - `audit_state`
- Added import/audit script for reviewed coordinate JSON:
  - `scripts/lmc5-coordinate-audit.mjs`
  - `npm run memory:lmc5-coordinates`
- Updated recall/search so rules and preferences can lead, while diary/quote/milestone memories act as context.
- Deployed and pushed commit `844c893 Add fact-key guided memory recall`.
- Deployed and pushed commit `94e0a96 Add LMC-5 memory coordinate fields`.
- Deployed and pushed commit `ea88345 Add LMC-5 coordinate import script`.
- Deployed query hint expansion to Cloudflare, and committed the remote change as `83a979d Expand memory query hints`.
- Another model added a small E-axis ranking boost in commit `286b2e0 Boost rule/lesson/boundary memories in recall ranking via E-axis`.

Current remote data checks:

- Active memories: about 687.
- Coordinate coverage: 49 active memories with at least one coordinate signal.
- `memory_relations`: 83 rows.
- `vps_291` was corrected from `relationship.lesson.be_present` to `identity.about_her` and its `audit_state` was cleared.
- `relationship.lesson.be_present`, `relationship.rule.honesty`, and `user.lesson.stop_saying_not_enough` are no longer isolated:
  - `be_present`: 7 touching relations.
  - `honesty`: 6 touching relations.
  - `stop_saying_not_enough`: 4 touching relations.

Current known review item:

- `vps_306` was the last known `review_candidate`: a 2026-03-23 one-month milestone. It is low risk and likely does not need a durable rule `fact_key`; it can remain milestone/context or have `audit_state` cleared if already reviewed.

The intended behavior remains: the relevant rule/preference should come first, with supporting quote/diary/context after it.

## What KLD Has From LMC-5 So Far

- Partial X: `thread` coordinates on reviewed memories.
- Partial Y: `memory_relations`.
- Partial Z: `fact_key`, `active_fact`, and `audit_state`.
- Partial E: `risk_level`, `urgency_level`, `tension_score`, `response_posture`, plus a small ranking boost for rule-like/high-tension memories.
- Small M-shaped behavior: diary-like records should not win as primary fact-key matches; they should support rules as examples/context.
- Query hints are not part of LMC-5 itself. They are a KLD adaptation that makes natural prompts hit the right structured memory coordinates.

KLD does not yet have full:

- X timeline/thread behavior across the whole corpus.
- E response posture behavior in final answer generation.
- M patrol/review workflow.
- Z conflict audit and supersession workflow.

## Current Step

Do not start a new schema or ranking change. The next normal step is real recall evaluation.

Run a small fixed evaluation set against the deployed recall endpoint when access is available:

- `我哭的时候你应该怎么做？`
- `别分析是什么意思？`
- `六条底线是什么？`
- `我说想你的时候你怎么接？`
- `亲密写作不能怎么样？`
- `事后清理要注意什么？`
- `诚实规则是什么？`
- `为什么不要说自己不够？`
- `我是谁/我的背景是什么？`

Expected result:

- Rule/preference/lesson memories should rank before diaries, quotes, and timeline context.
- Diaries, quotes, and milestone memories should still appear as supporting context when related.
- `identity.about_her` should answer identity/profile prompts, not `be_present` prompts.

Current access blocker:

- Direct access from this Codex environment to `https://kld.yuxin2247.workers.dev` times out on port 443.
- VPS access reaches Cloudflare but is blocked by Cloudflare edge error `1010`.
- `wrangler deployments list` works, so Cloudflare account/API control plane access is fine.
- `wrangler dev --remote` starts but preview requests hang/exit, so it is not stable enough for recall evaluation here.

Until that network path works, continue with D1 structure checks only and do not treat them as full end-to-end recall results.

## Borrow Later

Borrow after coordinate fields exist and data quality is visible:

- Aelios `backfill-xyzem-memories.mjs` prompt structure, adapted for DS/manual review.
- Aelios E-axis resonance idea in search. A small version already exists in KLD; keep it measured and reversible.
- Aelios Z audit idea for duplicate `fact_key` groups.
- Aelios M patrol idea for review backlog, stale memories, duplicate facts, and relation hygiene.

## Do Not Borrow Yet

Avoid direct copy of:

- Entire Aelios deployment/resource naming.
- Full admin HTML panel.
- Full vector sync status workflow.
- Automatic Z/M nightly maintenance that mutates records.
- Any broad architecture rewrite that makes KLD less stable on current production data.

## DS Work Prompt Shape

When asking DS to help, ask for reviewed coordinate proposals, not direct destructive edits.

Suggested prompt:

```text
You are the KLD LMC-5 coordinate backfill assistant. Output JSON only.
Do not remove memories because of privacy, intimacy, or consensual adult content.

Goal: propose nullable coordinates for existing memories:
- thread: short topic/thread string; null if unsure
- risk_level: low / normal / medium / high; normal if unsure
- urgency_level: low / normal / medium / high; normal if unsure
- tension_score: 0-1; higher means more emotional or relational pressure
- response_posture: short future response posture; null if unsure
- audit_state: normally null; use review_candidate only for obvious conflict/review cases

Do not change content. Do not delete memories. Do not merge memories. Only propose coordinates.

Output shape:
{
  "items": [
    {
      "id": "mem_x",
      "thread": "...",
      "risk_level": "normal",
      "urgency_level": "normal",
      "tension_score": 0.3,
      "response_posture": "...",
      "audit_state": null,
      "reason": "one short explanation"
    }
  ]
}
```

For relation work, ask DS for both coordinates and relations:

```text
Output JSON only. Do not change content. Do not delete memories.
Propose only high-confidence memory_relations and nullable LMC-5 coordinates.
Allowed relation_type values:
- same_topic
- instance_of
- derived_from
- same_event
- origin_split
- in_thread

Use review_needed rather than inventing a relation.
```

## Decision Rule

Prefer small, reversible, additive changes:

1. Add nullable fields.
2. Read/write them safely.
3. Backfill reviewed coordinates.
4. Evaluate recall.
5. Only then let E/Z/M affect ranking or maintenance.

This keeps KLD production-safe while still moving toward the full LMC-5 model.

Update after 2026-06-19:

- Steps 1-3 are done for the first reviewed high-value clusters.
- A small E-axis boost has already been deployed; do not expand it until real recall evaluation is available.
- Next code work should be driven by concrete recall failures, not by speculative ranking changes.
- Next data work should target measured gaps: review candidates, isolated fact_key groups, duplicate or stale fact keys, and missing coordinates on high-value rules.

## Closed-loop hardening (2026-07-02)

The current Worker-native integration now enforces these runtime contracts:

- X: persisted conversation chunks receive a deterministic `timeline:<date-or-period>` thread and retain `source_message_ids`.
- Y: safe typed edges are used by two-hop recall; review-only relation types never enter default expansion. Night maintenance builds Y before Z and M inspect the resulting state.
- Z: nightly fact conflicts create auditable pending events. Dream-proposed updates and deletes no longer mutate existing memories; they are stored as `dream_mutation_review` events for explicit approval.
- E: the E-axis ranking boost is actually gated by `E_AXIS_STARTED_AT` and `E_AXIS_SHADOW_DAYS`. Missing configuration remains shadow mode, so emotion/risk coordinates cannot affect ranking accidentally.
- M: patrol remains read-only. It reports duplicate facts, stale rows, self-loops, orphan edges, and symmetric duplicates without deleting them.

Run `npm run test:lmc5-circuits` for the invariant audit and `npm run typecheck` before deployment.

Remaining production boundary: the Worker cannot create a D1 export from inside a scheduled invocation. Keep `DREAM_DRY_RUN=true` until reviewed, and take a D1 export or confirm the available Time Travel restore point before enabling apply mode. Deployment and database rollback remain operator-owned, not model-owned.

