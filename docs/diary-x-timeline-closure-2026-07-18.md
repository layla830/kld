# Formal diary to X-axis closure

Formal `diary` records remain source documents and are not themselves recalled as atomic memories. Their active `timeline_split` children are projected through the five-axis pipeline. `layla_diary` remains raw and is not split.

Ordinary memory records are already atomic: they are not diary-split and enter the five-axis outbox directly.

## Runtime ownership

- The splitter creates only durable atomic records such as quotes, events, warmth, insights, milestones, and review-first facts.
- It never creates a date-only record, placeholder, day overview, or `timeline_day` memory.
- For each `origin:<diary_id>` and `date:<yyyy-mm-dd>` group, X deterministically chooses the highest-signal real split item as the internal day anchor.
- Other active split records for that date join the selected real item through X-owned `in_episode` relations.
- Canonical real-item anchors are connected by X-owned adjacent `temporal_sequence` relations in `diary:kld`.
- One source diary may cover multiple dates; each represented date independently selects an anchor from its own real split items.
- These relations use `diary_day:*` and `diary_timeline:*` reasons. Reconciliation replaces only edges with the exact owned reason.
- Diary items do not receive synthetic `fact_key` values; Z-axis fact semantics remain separate.

## Automatic split recovery

- A `diary_split_v2_complete` event is terminal when it records either at least one item or `outcome: no_durable_items`.
- An empty extraction is valid when the diary has no standalone long-term memory; it does not trigger a retry or placeholder.
- An active non-`timeline_day` V2 split child is also durable evidence that the diary was split successfully.
- The missed-job scan runs from the existing five-minute scheduler with a bounded batch. Successful and intentionally empty diaries stop re-entering the queue.
- Diaries owned by a legacy splitter (`has_timeline_split` or active non-V2 split children) are deliberately held for an explicit migration. Automatically splitting them again could duplicate memories.

The resulting write paths are:

1. Formal diary write -> diary-split queue -> zero or more dated atomic `timeline_split` children -> five-axis outbox for every active child.
2. Ordinary memory write -> five-axis outbox directly.

## Historical migration and backfill

`20260720_remove_synthetic_diary_days.sql` retires old active `timeline_day` rows, clears X-owned diary memberships and edges, and requeues active real split items at a new five-axis revision. The old rows are soft-deleted so their history remains auditable.

`POST /v1/debug/x_diary_timeline_backfill` requires `memory:write`.

Dry run:

```json
{"namespace":"default","apply":false,"limit":100}
```

Apply deterministic relationships for dated atomic splits:

```json
{"namespace":"default","apply":true,"limit":100}
```

The apply path retires any remaining legacy day nodes and rebuilds each dated group from its real split items. Groups with no split items or undated items remain visible as low-coverage rows and are not padded with synthetic memories.

## Rollback boundary

To remove only this projection, delete rows from `memory_diary_timeline_memberships` and relations whose reason starts with `diary_day:` or `diary_timeline:`. Do not delete generic `temporal_sequence` or `in_episode` relations from other owners.

Rolling code back does not restore soft-deleted synthetic day rows automatically. Rebuilding the old design would require an explicit data migration and is intentionally unsupported.
