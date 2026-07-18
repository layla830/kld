# Formal diary to X-axis closure

Formal `diary` and `layla_diary` records remain source documents and are not projected directly into five-axis memory. Their active `timeline_split` children are projected.

Ordinary memory records are already atomic: they are not diary-split and enter the five-axis outbox directly.

## Runtime ownership

- `timeline_day` is the durable anchor for one diary date.
- Other active split records for the same `origin:<diary_id>` and `date:<yyyy-mm-dd>` join that anchor through X-owned `in_episode` relations.
- Canonical day anchors are connected by X-owned adjacent `temporal_sequence` relations in either `diary:kld` or `diary:layla`.
- These relations use `diary_day:*` and `diary_timeline:*` reasons. Reconciliation replaces only edges with the exact owned reason.
- Diary items do not receive synthetic `fact_key` values; Z-axis fact semantics remain separate.
- If two model attempts still omit a required day node, the splitter creates a bounded verbatim anchor tagged `timeline_day_fallback:verbatim`; this keeps X structurally closed without inventing an extracted fact.

## Automatic split recovery

- A `diary_split_v2_complete` event is terminal only when its payload records `item_count > 0`.
- An empty model result is recorded as `diary_split_v2_incomplete`, so the missed-job scan can retry it instead of preserving a false success.
- An active V2 `timeline_day` child is also durable evidence that the diary was split successfully.
- The missed-job scan runs from the existing five-minute scheduler with a bounded batch. Successful diaries stop re-entering the queue.
- Diaries owned by a legacy splitter (`has_timeline_split` or active non-V2 split children) are deliberately held for an explicit migration. Automatically splitting them again could duplicate memories.

The resulting write paths are:

1. Formal diary write -> diary-split queue -> dated `timeline_split` children -> five-axis outbox for every active child.
2. Ordinary memory write -> five-axis outbox directly.

## Historical backfill

`POST /v1/debug/x_diary_timeline_backfill` requires `memory:write`.

Dry run:

```json
{"namespace":"default","apply":false,"limit":100}
```

Apply deterministic relationships for complete splits:

```json
{"namespace":"default","apply":true,"limit":100}
```

The apply path only processes diary/date groups with exactly one active `timeline_day` and no undated active split records. It also reconciles the latest previously skipped X run for records that were successfully backfilled.

Rows with `no_split_items`, `missing_timeline_day`, `multiple_timeline_days`, or `undated_items` are reported but not modified. Re-screen those diary IDs separately through the existing bounded diary rescreen API; replacement output stays staged/reviewable.

## Rollback boundary

To remove only this projection, delete rows from `memory_diary_timeline_memberships` and relations whose reason starts with `diary_day:` or `diary_timeline:`. Do not delete generic `temporal_sequence` or `in_episode` relations from other owners.

The automatic split recovery change has no schema migration. Reverting its code restores the previous queue gating; it does not delete or rewrite existing memories.
