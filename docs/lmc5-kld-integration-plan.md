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

Already done:

- Added `fact_key` and `active_fact` to memories.
- Backfilled selected high-value long-term facts.
- Added `memory_relations`.
- Imported the first two relation batches from DS output.
- Added `queryHints` so common questions can directly target known fact keys.
- Updated recall/search so rules and preferences can lead, while diary/quote/milestone memories act as context.
- Deployed and pushed commit `844c893 Add fact-key guided memory recall`.

Current deployed behavior was checked with:

- communication style prompt
- six boundaries prompt
- comfort while crying prompt

The intended behavior is that the relevant rule/preference comes first, with supporting quote/diary/context after it.

## What KLD Has From LMC-5 So Far

- Partial Z: `fact_key` and `active_fact`.
- Partial Y: `memory_relations`.
- Small M-shaped behavior: diary-like records should not win as primary fact-key matches; they should support rules as examples/context.
- Query hints are not part of LMC-5 itself. They are a KLD adaptation that makes natural prompts hit the right structured memory coordinates.

KLD does not yet have full:

- X timeline/thread behavior.
- E ranking or response posture behavior.
- M patrol/review workflow.
- Z conflict audit and supersession workflow.

## Current Step

Add a lightweight LMC-5 coordinate layer without changing recall ranking yet.

Migration fields:

```sql
ALTER TABLE memories ADD COLUMN thread TEXT;
ALTER TABLE memories ADD COLUMN risk_level TEXT;
ALTER TABLE memories ADD COLUMN urgency_level TEXT;
ALTER TABLE memories ADD COLUMN tension_score REAL;
ALTER TABLE memories ADD COLUMN response_posture TEXT;
ALTER TABLE memories ADD COLUMN audit_state TEXT;

CREATE INDEX IF NOT EXISTS idx_memories_thread
ON memories(namespace, thread, status);

CREATE INDEX IF NOT EXISTS idx_memories_experience
ON memories(namespace, risk_level, urgency_level, tension_score, status);
```

Important: do not add `fact_key` or `memory_relations` again. KLD already has them.

Code changes:

- Add `src/memory/coordinates.ts` with simple normalizers:
  - `normalizeThread`
  - `normalizeRiskLevel`
  - `normalizeUrgencyLevel`
  - `normalizeTensionScore`
  - `normalizeResponsePosture`
  - `normalizeAuditState`
- Extend `MemoryRecord` and `MemoryApiRecord`.
- Extend `createMemory`, `updateMemory`, and mapper/API paths to read/write these nullable fields.
- Add fields to Vectorize metadata for future debugging/search migration.
- Do not let E-axis values affect ranking until enough records have reliable data.

Validation:

- `npm run typecheck`
- local D1 migration
- remote D1 migration
- deploy with `npx wrangler deploy --keep-vars`
- smoke recall for the known prompts above

## Borrow Later

Borrow after coordinate fields exist and data quality is visible:

- Aelios `backfill-xyzem-memories.mjs` prompt structure, adapted for DS/manual review.
- Aelios E-axis resonance idea in search, but only after enough memories have `risk_level`, `urgency_level`, and `tension_score`.
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

## Decision Rule

Prefer small, reversible, additive changes:

1. Add nullable fields.
2. Read/write them safely.
3. Backfill reviewed coordinates.
4. Evaluate recall.
5. Only then let E/Z/M affect ranking or maintenance.

This keeps KLD production-safe while still moving toward the full LMC-5 model.
