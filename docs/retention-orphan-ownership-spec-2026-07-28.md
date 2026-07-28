# Spec: Retention orphan ownership — 硬删的从表归属与 drift/historical 互斥定义

- 日期：2026-07-28
- 作者：Claude Code 会话（应 Codex Bridge 请求，基于其未提交 F1 diff 的独立复核）
- 状态：Codex 已按裁决调整实现，待最终交叉复审；本文档不包含生产动作
- 依据：Codex 未提交工作区（`src/db/retention.ts` +196、`src/memory/retention.ts` +21、`scripts/inactive-five-axis-audit.mjs` +218、测试 +125）+ 生产只读实测（2026-07-28，180 条 orphan 构成复核）
- 关联：`docs/spec-b-diary-lifecycle-bypasses-2026-07-28.md`（diary 前置不变量来自 B2）；Codex 全仓 review F1

---

## 1. 问题与生产实测结论

`hardDeleteMemoriesBatch`（committed `src/db/retention.ts:129`）只 `DELETE FROM memories`，不处理任何引用表。生产首测（Codex 未提交 audit section）出 180 行 orphan，复核修正后的精确构成：

| 人群 | 行数 | 实质 |
|---|---|---|
| `result_memory_id` 悬空的 approved candidates | 83（77 m_relation_cleanup + 6 y_relation_review） | 终态历史 |
| payload-only 引用、被候选计数器漏掉的 candidates（经 orphan deps 反查） | 52（候选级漏报 38%；生产复跑确认真实候选级 orphan = 135，非 83） | 终态历史 |
| orphan candidate_dependencies（45 source + 46 target） | 91（全部 memory_missing 臂；candidate_missing = 0） | 终态 candidate 的规范化引用行 |
| `y_relation_approved` events | 6（与 6 条 y_relation_review 一一对应） | 审计历史 |

**关键事实：pending orphan = 0。** 91 条 dep 中仅 4 条属非 approved candidate，且为 07-11 已 rejected（终态）。13/16 子计数器为 0——lifecycle/deprojection 管理的表全部干净，积累 orphan 的恰好是三张无生命周期 hook 的历史表。存量按用户裁定**不在本 spec 处理**。

## 2. 不变量与 owner

- **I1（不造新 orphan）**：memory 硬删时，其全部**结构性引用行**（§3 标 delete 的表）必须在同一事务内删除；硬删完成后这些表对该 memory 的引用为 0。
- **I2（pending 阻止硬删）**：被 `pending` / `needs_subject_review` / `deferred_relation` candidate 引用的 memory 不得硬删。引用判定两臂：deps join（规范臂）+ `target_id`/`result_memory_id` 列（列臂）。
- **I2 前置不变量（deps 完整性）**：所有 candidate 创建路径必须把 memory 引用（含 payload 内引用）规范化为 `memory_candidate_dependencies` 行。`target_id` / `result_memory_id` 仍是 schema 中的一等直接引用；payload-only 引用只以 deps 表为规范来源。硬删门和 audit 统一取“两列 + deps”的集合，任何运行时代码不得再解析 `payload_json` 取引用（迁移回填是一次性历史动作，不算）。
- **I3（资格事务内重验）**：硬删资格在删除事务内重新解析（CTE 重算），不用事务外快照——关闭 list→delete 的 TOCTOU 窗口。
- **I4（diary 前置不变量）**：所有进入 terminal 状态（`deleted`/`superseded`/`expired`）的路径必经 deprojection/lifecycle（membership 清除 + B2 组重建已在该处完成）。因此 memory 到达硬删时**不存在** diary membership。若仍存在，retention 必须阻止硬删，让 `diary_*_drift` 明确暴露 owner 失守；不得用防御性 DELETE 把组重建缺口隐藏掉。
- **Owner**：`hardDeleteMemoriesBatch` 是 memory 行及其结构从表的唯一删除 owner；`retention_orphans` audit section 只读拥有度量。历史表（§3 标 retain 的表）的生命周期归各自家族，不由 memory 硬删抢先删除。

## 3. 逐表 delete / retain 裁决

原则（与 Codex 倾向一致）：**runtime 派生/结构性状态随 parent 删除；有自身生命周期的历史记录不由 memory 硬删删除。**

| 表 | 裁决 | 理由 |
|---|---|---|
| `memory_relations` | **delete** | 结构边；parent 不在则边无意义（当前 orphan=0，防御+守 I1） |
| `memory_timeline_memberships` | **delete** | 结构隶属 |
| `memory_diary_timeline_memberships` | **block parent delete** | diary 组由 deprojection/B2 独占；remaining membership 是生命周期异常，retention 不越权清理 |
| `memory_five_axis_outbox` / `memory_five_axis_runs` | **delete** | runtime 队列/运行记录 |
| `memory_candidate_axis_runs` | **delete** | runtime 链接 |
| `memory_candidate_dependencies` | **delete（按 memory_id 臂）** | 规范化 runtime 链接；删除后不影响历史 candidate 的自包含 payload |
| `memory_metabolism_signal_state` | **delete** | 派生状态 |
| `memory_recall_daily` / `memory_recall_receipts` | **delete** | 派生分析数据 |
| `memory_events` | **retain** | 审计链：硬删后它是事发唯一记录（`y_relation_approved` 曾被用于 provenance 归因）；删除是不可逆信息损失 |
| `memory_candidates`（非 pending） | **retain** | 决策记录（payload `before` 快照自包含）；其自身生命周期（如终态 candidate 过期清理）另立家族，不在本 spec |
| `memory_deprojections`（已完成） | **retain** | 操作记录 = 幂等键 + snapshot；未完成（`completed_at IS NULL`）的不是删除对象而是 **I2 同款阻止条件** |
| `memory_deprojections`（未完成） | **阻止 parent 硬删** | 已在 Codex 资格 SQL 中，保留 |

与 Codex 未提交实现的三处差异（必须修改）：

1. **从 batch 移除 `memory_events` DELETE**（retain 裁决）；
2. **从 batch 移除非 pending `memory_candidates` DELETE**（retain 裁决）。其实现谓词（全部引用都在 targets 才删）逻辑自洽，但方向与历史保留冲突；
3. **从 batch 移除 `memory_deprojections` DELETE**（retain 裁决）。

其余 DELETE（结构表）与 Codex 实现一致，包括 deps 按 `memory_id IN targets` 删除；diary membership 从 DELETE 列表移入资格阻断条件。

## 4. Actionable drift 与 historical diagnostic 的互斥定义

分类按**引用行自身所属实体的终态性**，与被引 memory 的状态无关；同一行永不同时属于两类。

**Actionable drift（计入 `drift_count`，repair 对象）**：

- 结构表（§3 全部 delete 表）中的任何 orphan 行——owner 失守，永不应存在；
- **pending** candidate 的悬空引用（deps 臂或列臂）——审批路径会踩空，是真正的可操作 drift；
- pending candidate 拥有的 orphan deps；
- 未完成 deprojection 指向缺失 memory（仅在 I2 被 bug 绕过时可能出现）。

**Historical diagnostic（报告但不计 `drift_count`，无 repair）**：

- `memory_events` 指向缺失 memory（retain 裁决的必然结果）；
- 非 pending candidate 的悬空 `target_id`/`result_memory_id`；
- 非 pending candidate 拥有的 orphan deps（若选择保留 deps 作历史）；
- 已完成 deprojection 指向缺失 memory（retain 裁决的必然结果）。

实现要求：

- audit 报告两个并列计数组（如 `retention_orphans.actionable_rows` / `retention_orphans.historical_rows`），只有前者进 `drift_count`；
- 候选级 orphan 判定统一合并 direct columns 与 deps，解决 payload-only 漏报（83 vs 135）；同时报告 distinct candidates 与物理行数，区分“候选数”与“引用行数”；
- diary 家族归类调整（Codex 已实现）保持：NULL-join（行缺失）归 orphan 家族、inactive 归 diary_drift，两家族不重复计数。

## 5. 建议修改（相对 Codex 未提交 diff）

| 位置 | 修改 |
|---|---|
| `src/db/retention.ts` `hardDeleteMemoriesBatch` | 移除 events / candidates / deprojections 三条 DELETE；其余保留 |
| `src/db/retention.ts` `hardDeleteEligibilitySql` | terminal + cutoff + 无未完成 deprojection + 无 pending 引用双臂 + 无 diary membership |
| `scripts/inactive-five-axis-audit.mjs` | `retention_orphans` section 拆 actionable / historical 两组计数，仅 actionable 进 driftFields；候选级判定改走 deps；加 `distinct_orphan_candidates` |
| `src/memory/retention.ts` | `hardCutoff` 透传保留 |
| 全过程 | `sqlStringList` 仅限常量状态值，禁止用于外部输入（spec 注明） |

## 6. 最小测试矩阵

Worker 集成（真实 D1）：

1. **I2 三臂**：pending candidate 经 deps 引用 / 经 `target_id` / 经 `result_memory_id` 各挡住一次硬删；candidate 转终态后放行；
2. **I2 前置**：未完成 deprojection（`completed_at IS NULL`）的 memory 不删；
3. **I3 TOCTOU**：`listHardDeletableMemories` 之后、batch 之前把 memory 改回 active → 删除 0 行；
4. **I1 同事务**：硬删后该 memory 在全部由 retention 清理的结构表（relations/outbox/runs/timeline memberships/deps/axis links/signal/recall）引用为 0；
5. **retain 裁决**：硬删后 events / 非 pending candidates / 已完成 deprojections **仍在**，且不计入 `drift_count`（historical 组可见）;
6. **互斥归类**：terminal-candidate orphan 出现在 historical 不出现在 actionable；pending-candidate orphan 反之；
7. **候选级引用并集**：payload-only 引用（target_id 为空）的 terminal candidate 在 historical 候选级计数中可见（生产回归 135 vs 83 漏报）；
8. **I4 回归**：terminal memory 仍被 diary membership 引用时不进入 hard-delete selection，直接 apply 也删除 0 行；membership 和组结构保持可审计。

单测：

9. audit SQL 保持只读断言（既有模式）+ 新 section 的 driftFields 只含 actionable 字段；
10. `sqlStringList` 转义（单引号）。

## 7. 明确不做

- **不动 180 条存量**（用户裁定）；其重分类（→historical diagnostic）随 audit 改造自然生效，不需要数据动作。
- 不立"终态 candidate/events 自身过期清理"家族——那是历史表自身生命周期，另棒。
- 不处理 pending candidate 引用**已 terminal 但未硬删** memory 的情形——属 stale candidate 家族（全仓 review F5），另棒。
- 不在 retention 侧做 diary 组重建（I4 断言 + audit 守卫代替）；不加 scanner；不加表/列/migration。
- 生产动作：无。

## 8. 验证命令

`npm run typecheck`、`npm run types:check`、`npm run test:unit`、`npm run test:worker`，报告实际输出；合并部署后复跑只读 audit，预期 `drift_count` 回到 1839（180 移入 historical）且 actionable orphan 恒 0。

## 9. 与 Codex 未提交实现的差异说明

1. 级联范围：Codex 把审计表纳入删除，本 spec 裁决 retain——依据是项目审计链文化（provenance 归因曾实际消费 events）与删除不可逆；若产品上确需"随 memory 抹除"，需用户显式裁决后改回，不在工程默认。
2. 候选级 orphan 从“两列谓词”改为 direct columns 与 deps 的统一集合，修正 38% 漏报；
3. drift_count 语义从"全部 orphan 行"收窄为"actionable 行"，180 存量随之转为 diagnostic 而非 drift。
