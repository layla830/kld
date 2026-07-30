# Legacy relation snapshot normalization

- Date: 2026-07-30.
- Scope: one historical D1 normalization for approved `m_relation_cleanup`
  snapshots written before the boolean `relation_was_present` field existed.
- Non-goals: no runtime fallback, no relaxed rollback/retention/audit contract,
  no candidate-payload restore source, no migration, no automatic loop.

## Production evidence

The post-#107 read-only audit found:

- 188 approved relation-cleanup candidates, each with exactly one keyed snapshot;
- 77 snapshots with a boolean `relation_was_present`;
- 111 snapshots with an object `before` but no `relation_was_present`;
- the 111 legacy rows range from `2026-07-10T05:48:22.152Z` through
  `2026-07-20T08:20:47.218Z`;
- the first flagged row is `2026-07-20T09:38:40.150Z`;
- all 111 have non-null `strength` and relation `created_at`;
- snapshot and candidate `before` agree on id/source/target/type;
- all 111 legacy candidates have `result_memory_id IS NULL`, matching the old
  writer's `resolveMemoryCandidate(..., "approved")` call without a result id;
- no selected relation id currently exists;
- no duplicate keyed snapshot exists.

Code history supplies the semantic proof: the legacy writer in
`709606d^:src/api/adminBoard/metabolismActions.ts` threw when the relation was
absent, then wrote `{ candidate_id, action, before }`, deleted that exact row,
and only then approved the candidate. Therefore a snapshot from that writer
without the later flag can only mean `relation_was_present = true`.

## Selection owner

Dry-run and apply use one SQL selection. A row is repairable only when all are
true:

1. namespace matches;
2. candidate is currently `approved` with action `m_relation_cleanup`;
3. event is a keyed `m_snapshot` for that candidate and action;
4. the keyed snapshot count is exactly one;
5. `relation_was_present` is absent, not malformed or already boolean;
6. `before` is an object with non-null `strength` and `created_at`;
7. snapshot and candidate identities match on id/source/target/type;
8. candidate `result_memory_id IS NULL`, an additional fingerprint of the old
   writer; modern relation cleanup approvals populate this field;
9. snapshot predates `2026-07-20T09:38:40.150Z`, the first observed flagged row;
10. no current relation with `before.id` exists.

Excluded rows remain visible in dry-run diagnostic counters. Apply updates only:

```sql
payload_json = json_set(
  payload_json,
  '$.relation_was_present',
  json('true')
)
```

No candidate, relation, status, timestamp, or other event field changes.

## Command contract

```text
npm run repair:legacy-relation-snapshots -- --remote --namespace default --json
npm run repair:legacy-relation-snapshots -- --remote --namespace default \
  --limit 100 --apply --confirm legacy-relation-snapshots --json
```

- dry-run executes one `SELECT`;
- apply executes one bounded `UPDATE`, then the same dry-run query;
- maximum batch size is 100;
- no `all`, cohort selector, or automatic loop exists;
- apply reports `changed`, `remaining`, and `has_more`.

Production requires two separately authorized apply calls for the current
111-row cohort, followed by the full read-only audit. Acceptance is:

```text
m_snapshot_contract.missing_snapshot_candidates = 0
m_snapshot_contract.duplicate_snapshot_candidates = 0
m_snapshot_contract.malformed_snapshot_candidates = 0
```

The known relation/provenance historical backlog is unrelated and may keep the
overall audit `clean = false`.
