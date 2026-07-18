# Formal diary to X-axis closure

Formal `diary` and `layla_diary` records remain source documents and are not projected directly into five-axis memory. Their active `timeline_split` children are projected.

## Runtime ownership

- `timeline_day` is the durable anchor for one diary date.
- Other active split records for the same `origin:<diary_id>` and `date:<yyyy-mm-dd>` join that anchor through X-owned `in_episode` relations.
- Canonical day anchors are connected by X-owned adjacent `temporal_sequence` relations in either `diary:kld` or `diary:layla`.
- These relations use `diary_day:*` and `diary_timeline:*` reasons. Reconciliation replaces only edges with the exact owned reason.
- Diary items do not receive synthetic `fact_key` values; Z-axis fact semantics remain separate.

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
