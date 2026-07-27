# Spec: Diary origin 失效时的 timeline 生命周期收口

- 日期：2026-07-28
- 作者：Claude Code 会话
- 状态：待 Codex review；不含任何代码改动
- 上游定性：2026-07-27 复审报告（4 条 diary invalid origin = origin 当天 re-type diary→note 后无人清理，P1 missing-lifecycle）
- 关联：`docs/relation-provenance-snapshot-design-2026-07-27.md` §8（本问题独立处理）、`docs/stale-axis-run-supersession-spec-2026-07-27.md`（同一"在线转移 + 有界 repair"模式）

---

## 1. 验证基线

生产只读查询（两条，均 SELECT only）：

```text
changed_db = false
rows_written = 0
```

查询 1：membership origin 状态分布（namespace='default'，共 122 条 membership）：

| origin 状态 | memberships | distinct origins |
|---|---|---|
| valid（active 且 type='diary'） | 118 | 47 |
| wrong_type（re-type） | 4 | 1 |
| not_active / missing | 0 | 0 |

查询 2：被遗弃 day node `mem_723e535ea6ba455c83cab02b8de401d9`（event_date 2026-07-27，origin `mem_12fbe7dbeaa846c68964490a9bed8452`）的关系残留：

| relation_type | reason | n |
|---|---|---|
| in_episode | `diary_day:mem_12fbe7…:2026-07-27` | 3 |
| temporal_sequence | `diary_timeline:diary:kld` | 1 |
| derived_from | LLM 自由文本（470/1373 人群，**不属本 spec**） | 1 |

即缺失生命周期的完整残留 = **4 memberships + 3 in_episode + 1 temporal_sequence = 8 行**。注意：3+1 条关系两端 endpoint 均 eligible 且 reason 是 deterministic 前缀——新 provenance 分类器把它们归为 `deterministic_rebuildable`（归因正确），**任何 audit 都不把它们计为 drift**；它们只能由本生命周期清除。

## 2. 现状机制与根因

### 2.1 机制表（代码实证）

| 机制 | 位置 | 行为 |
|---|---|---|
| membership 唯一写入者 | `diaryTimeline.ts` `reconcileDiaryDayGroup`（:144） | upsert 组内 membership + 替换 owned `in_episode`（reason `diary_day:{origin}:{date}`） |
| 清理能力**已存在** | `clearDiaryDayGroup`（:128） | 删组 membership + owned in_episode；`reconcileDiaryDayGroup:149` 在 `timelineKeyForOrigin` 为 null 时**会调用它** |
| origin 门 | `timelineKeyForOrigin`（:68） | origin 必须 `status='active' AND type='diary'`；记录级等价谓词 = `diaryPolicy.isActiveDiarySplitSource` |
| reconcile 触发器 | `rebuildDiaryTimelineForMemory`（:247） | **按 member memory 触发**：由 diary split / `diaryTimelineBackfill` / `timelineBackfill` 在 item 上调用 |
| 序列重建 | `rebuildDiaryTimelineSequence`（:215） | 按 timeline_key 从现存 day membership 重算 owned `temporal_sequence`（replace 语义，自动删除失效边） |

### 2.2 根因

清理逻辑不缺，缺的是**触发**：origin 本身不是任何组的 member，re-type/删除 origin 时没有任何路径按"origin → 其所有组"触发 reconcile：

1. origin 的 update 走 `mutateMemoryLifecycle`（state.ts:135），只分类 five-axis eligibility 转移；diary 类型本就 ineligible，re-type diary→note 是 `ineligible_to_eligible`，正常 update，无 diary timeline 善后；
2. `rebuildDiaryTimelineForMemory(origin)` 即使被调也是 no-op（origin 无 membership、无 date:/origin: tags）；
3. `scanDiaryTimelineBackfill`（diaryTimelineBackfill.ts:118）只扫 `type='diary'` 的 origin——re-type 后的 origin 永远不再被扫到；
4. 组内 member 不再被触碰 → `reconcileDiaryDayGroup:149` 的清理分支永远到达不了 → membership、owned in_episode、序列 day node 全部永久残留。

这是一个"转移无 owner"缺口，与 stale axis-run 同构：**origin 失效（不再是 active diary）这条状态转移没有 owner**。

## 3. Owner 选择

**`mutateMemoryLifecycle`（src/memory/state.ts）** 拥有转移检测；**`diaryTimeline.ts` 新函数** 拥有清理执行。

理由：

1. 所有可改 `type`/`status` 的入口（MCP `update_memory` mcp.ts:592、admin 编辑 actions.ts:77、OpenAI API PATCH memories.ts:395、`deleteSyncedMemory`）已收口到 `mutateMemoryLifecycle`——它与 `deprojectMemoryFromFiveAxes` 并列的转移分类点就长在这里，符合"一个状态一个 owner"且不制造第二套 lifecycle；
2. 清理逻辑必须复用 diaryTimeline 的既有原语（`clearDiaryDayGroup` / `rebuildDiaryTimelineSequence`），不能在 lifecycle 层重写 SQL——membership 的唯一 owner 仍是 diaryTimeline；
3. 谓词复用 `isActiveDiarySplitSource`（diaryPolicy.ts）+ `applyMemoryEligibilityPatch`（eligibility.ts:30），不手写第三份。

## 4. 建议修改

| 位置 | 修改 |
|---|---|
| `src/memory/diaryTimeline.ts` | 新增 export `clearDiaryTimelineGroupsForOrigin(db, { namespace, originDiaryId })`：① `SELECT DISTINCT event_date, timeline_key FROM memory_diary_timeline_memberships WHERE namespace=? AND origin_diary_id=?`；② 每组调 `clearDiaryDayGroup`；③ 每个 distinct timeline_key 调 `rebuildDiaryTimelineSequence`。全部 keyed DELETE + 确定性重建，幂等，无 check-then-write 依赖 |
| `src/memory/state.ts` `mutateMemoryLifecycle` | 非 deprojection 分支的 `updateMemory` 成功后，若 `isActiveDiarySplitSource(existing)` 且 `!isActiveDiarySplitSource(after)`（after 来自 `applyMemoryEligibilityPatch`），调 `clearDiaryTimelineGroupsForOrigin`。覆盖 re-type 与 status→deleted 两种失效；反向转移（变回 diary）天然无组可清，no-op |
| `scripts/inactive-five-axis-audit.mjs` | `invalid_origin_diary_rows` 谓词对齐运行时门：origin missing **或** `NOT (origin.status='active' AND type IN 原始三类型)`（增加 status 子句；生产已证 0 条 not_active/missing，首跑零变化） |

**原子性权衡（明确知情）**：`updateMemory` 是单语句 guarded store 函数，清理是后续多语句 batch，两者不在同一事务。崩溃窗口 → drift 重现 → 由 §5 的有界 repair 收口（与 supersession 的"在线转移 + 离线 repair"同一形状）。考虑过把 update+cleanup 塞进一个 batch（deprojection 的 prepare 模式），但需要重构 `updateMemory` 签名，对本问题过度——拒绝。

## 5. 历史 8 行的收口（需用户另行授权）

残留分两类，收口方式不同：

1. **4 memberships + 3 owned in_episode**：有界 repair 脚本（新 `scripts/diary-origin-timeline-repair.mjs`，沿用 inactive-five-axis-repair.mjs 的 dry-run/`--apply --confirm`/`--limit`/无循环形态）：
   - selector = audit `invalid_origin` 谓词选 distinct (origin_diary_id)；
   - apply = 对每个 origin 执行 `DELETE memberships WHERE origin_diary_id=?` + `DELETE memory_relations WHERE reason LIKE 'diary_day:{origin}:%'`——reason 前缀即 owner 证明，selector 可证明、有界；
2. **1 temporal_sequence 序列边**：**不写 SQL 重建**（避免在脚本里复制 `rebuildDiaryTimelineSequence` 逻辑）。membership 清除后，下一次任何 `diary:kld` 组 reconcile（日常 diary split 即触发）会以 replace 语义自动删除失效序列边；如用户想立即闭环，可对现有 `scanDiaryTimelineBackfill` 先 dry-run 再单次 apply（既有代码，零新增），它会顺带重建 `diary:kld` 序列。
3. 复跑 audit：`invalid_origin_diary_rows = 0`、`diary_drift_rows = 0`；provenance 分类器中被删的 4 条 deterministic 关系同步消失，其余计数不变。

**relation DELETE 先例说明**：这是 PR #96"relation 只审计不删除"之后第一个 relation DELETE。它与 470/1373 人群严格区分：这 4 条是 **deterministic owner 前缀可证明的派生投影**，其源 memory 仍在（可重放性 = 派生状态随生命周期消亡，与在线 `clearDiaryDayGroup` 语义逐字一致——在线路径删同类边本就无 snapshot）。470/1373 的删除仍走 provenance/snapshot 阶梯，不因本 spec 松动。

## 6. 明确不修改的范围

- 不动 diary split、reconcile、backfill 主体；不动 membership 表结构；不加字段/表/migration。
- 不顺手处理 origin missing（生产 0 条，audit 谓词对齐后未来可见即可，不加新清理路径——`clearDiaryTimelineGroupsForOrigin` 对 missing origin 同样适用，自然覆盖）。
- 不动该 day node 上那条 `derived_from` 自由文本关系（属 470/1373 人群）。
- 不做 ineligible→eligible reprojection；re-type 成 note 的 origin 走既有 trigger→outbox→projection，本 spec 不干预。
- 不授权 `--apply`、部署、PR。

## 7. 测试清单

单测 / worker 集成（真实 D1，仿 e-axis-and-run-guards 模式）：

1. diary origin（含 split items、membership、in_episode、序列边）经 `patchSyncedMemory` re-type diary→note → memberships=0、owned in_episode=0、`diary:kld` 序列不再含该 day node、origin 本身正常成为 eligible note；
2. origin `deleteSyncedMemory`（status→deleted，type 仍 diary）→ 同样全清（覆盖 status 失效分支）；
3. 普通 note 编辑（非 origin）→ 不触发清理（回归：只在 origin 门失效时触发）；
4. re-type 后再次 split 新 diary、再 reconcile → `diary:kld` 序列正确接续（replace 语义回归）；
5. `clearDiaryTimelineGroupsForOrigin` 幂等：连调两次结果一致；
6. repair 脚本 dry-run 在种子数据上选中且仅选中 invalid-origin 组；apply 后 audit 计数归零；valid 组（47 origins/118 memberships 形态）毫发无损；
7. audit 新 status 子句：构造 origin status='deleted' + type='diary' 的 membership → 计入 `invalid_origin_diary_rows`。

验证命令：`npm run typecheck`、`npm run types:check`、`npm run test:unit`、`npm run test:worker`，报告实际输出。

## 8. 生产动作

- 本 spec 阶段：无（已报告两次只读查询 changed_db=false / rows_written=0）。
- 实现合并后：复跑只读 audit，预期 `invalid_origin_diary_rows` 仍为 4（在线转移只防新漏）；历史 8 行的 repair apply 需用户明确授权后单次执行，再复跑 audit 验证归零。

## 9. 与任务书/惯例不同的判断

1. **清理靠触发而非新逻辑**：`clearDiaryDayGroup` 的清理分支早已存在（diaryTimeline.ts:149），本 spec 大部分是在 lifecycle owner 上接一个触发器——缺口定性为"missing transition owner"而不是"missing cleanup"。
2. **序列边不随 repair 写 SQL**：坚持确定性重建只有一个实现（`rebuildDiaryTimelineSequence`），接受"序列边延迟到下一次 reconcile 消失"或"复用既有 backfill apply"，都不在 repair 脚本里复制序列逻辑。
3. **audit 谓词加 status 子句**：生产证明首跑零变化，但运行时门本来就含 status——audit 与运行时门应共享同一事实来源，不为"零变化"而保持已知偏差。
4. **窄开 relation DELETE 先例**：§5 的 4 条关系删除是 PR #96 禁令后的首次，理由是 owner 前缀可证明 + 与在线生命周期语义逐字一致；这不构成对 470/1373 的任何先例。

---

## 回报（按任务书 §12 模板）

- 我检查了：`diaryTimeline.ts`（全文）、`diaryPolicy.ts`、`state.ts`（mutateMemoryLifecycle/patchSyncedMemory/deleteSyncedMemory）、`eligibility.ts`（classifier/patch）、`mcp.ts`、`adminBoard/actions.ts`、`api/memories.ts`、`diaryTimelineBackfill.ts`、`timelineBackfill.ts`、`inactive-five-axis-audit.mjs` + 生产只读查询 ×3
- 当前 owner：membership 写/清 = diaryTimeline（按 member 触发）；memory 突变 = mutateMemoryLifecycle；**origin 失效转移 = 无 owner（缺口）**
- 根因：re-type/status 失效后 origin 不再被任何 reconcile 触发路径触及，组清理分支永久不可达（§2.2）
- 最小状态转移：`isActiveDiarySplitSource(existing) ∧ ¬isActiveDiarySplitSource(after)` → `clearDiaryTimelineGroupsForOrigin`（§4）
- 并发 guard：update 走既有 guarded 单语句；清理全部 keyed DELETE + replace 语义，幂等，无 check-then-write
- 不会修改：见 §6
- 需要补的测试：见 §7，共 7 项
- 生产动作：无（repair apply 需用户另行授权）
- 与说明书不同的判断：见 §9，共 4 条
