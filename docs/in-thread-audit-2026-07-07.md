# in_thread 旧记忆建边审计（2026-07-07）

范围：远端 D1 `default` namespace，`status=active`、`active_fact!=0`、排除 `dream_review`。本审计按现有回补算法，在每个 thread 内按 `created_at,id` 相邻配对。

## 结论

不允许直接写入全部 `in_thread` 候选。631 条候选中，488 条（77.3%）除了 thread 名称外没有共同事实、共同来源或共同日期；宽 thread 会把数月内无直接关系的内容串成大链。

只保留 47 条具有精确锚点的候选：

- 相同非空 `fact_key`；或
- `source_message_ids` 有交集；或
- 一侧的 `source_message_ids` 直接引用另一侧记忆 ID。

同日期但没有事实/来源锚点的 96 条不自动写入。日期相同只能说明同一天，不能证明应成为高权重图边。

## 全量统计

| 类别 | 边数 |
|---|---:|
| 原始候选 | 631 |
| 相同 fact_key | 4 |
| 共同 source_message_id | 41 |
| 直接来源引用 | 2 |
| 精确锚点并集 | 47 |
| 仅同日期 | 96 |
| 无任何锚点 | 488 |

时间跨度也不能替代来源证据：342 条发生在一小时内，但其中 212 条仍无任何锚点；另有 9 条相邻记录相隔超过 30 天。

## 最大宽线

| thread | 记忆数 | 原始候选边 |
|---|---:|---:|
| `relationship.boundaries` | 232 | 231 |
| `kld` | 201 | 200 |
| `relationship` | 45 | 44 |
| `relationship.intimacy` | 36 | 35 |
| `safety` | 25 | 24 |
| `relationship.communication` | 19 | 18 |
| `intimacy` | 15 | 14 |

前两条宽线就占 431 条原始边。抽样可见，同一宽线的相邻记录可能分别谈承诺、请假邮件、朋友冲突或技术部署，不能仅因 thread 相同而互相扩展召回。

## 落地规则

`src/memory/legacyRelations.ts` 已收紧：

1. 扫描时排除 `active_fact=0`。
2. `in_thread` 只在相邻记忆具有 `same_fact_key`、`shared_source` 或 `direct_source_ref` 时生成。
3. reason 写入具体 anchor，便于审计。
4. `same_date` 不进入自动安全集。

正式执行前仍须在线 dry-run，确认 `in_thread` 约为 47 条且 `inserted=0`，再决定是否 apply。
