# Spec: Generic stale axis-run supersession

- 日期：2026-07-27
- 作者：新 AI 同事（Claude Code 会话）
- 状态：待 review；不含任何代码改动
- 依据任务书：`docs/kld-lmc5-ai-colleague-onboarding-2026-07-27.md` 第 10 节
- 验证基线：本地 `main` = `9ea2e8d`（与 origin 同步）；`npm run typecheck` 通过；`npm run test:unit` = 156/156 通过，但 `tests/inactive-five-axis-repair.test.ts`、`tests/inactive-vector-repair.test.ts` 两个 suite 在 import 阶段报 `SyntaxError`——已定位为**本地环境 artifact**：这两个测试 import 的脚本带 shebang，而本机 `core.autocrlf=true` 把工作区检出为 CRLF，shebang+CRLF 触发 vitest transform 失败（index 中为 LF，非仓库回归，Linux/CI 不受影响）；`npm run test:worker` = 19 文件全过，128 通过 / 6 skipped

---

## 1. 当前状态机表

### 1.1 axis run（`memory_five_axis_runs`）

主键：`namespace + memory_id + memory_revision + axis`。
状态集合（CHECK 约束）：`running / applied / pending_review / skipped / failed`。

| 转移 | owner（函数） | guard | 备注 |
|---|---|---|---|
| （无行）→ `running` | `claimFiveAxisRun` | INSERT…SELECT 要求 memory 存在、eligible、revision 相等 | attempts=1 |
| `running/failed(expired)` → `running` | `claimFiveAxisRun` ON CONFLICT | `status='failed'` 或（`running` 且 lease 缺失/过期），`attempts < 5` | 换 claim_token |
| `running` → `applied/pending_review/skipped` | `completeFiveAxisRun` | `status='running'` + claim_token + **revision 相等且 eligible** | pending_review 附带 candidate link 写入 |
| `running` → `failed` | `failFiveAxisRun` | `status='running'` + claim_token；**无 revision guard** | 不对称点，见 §2.3 |
| `running/failed/pending_review` → `skipped` | `prepareMemoryDeprojection` cleanup | operation scope（eligible→ineligible 专用） | 已有先例：store 层拥有 run 终结 |
| `failed/running` → `failed`（attempts=0） | `retryFiveAxisDeadLetter` | dead_letter outbox 存在且同 revision | 管理页手动重试 |
| `pending_review/applied/skipped` → candidate 复核结果 | `prepareCandidateAxisRunReconciliation*` | candidate link 存在 | 不属本 spec |

**缺失的转移**：`running` 且 `run.memory_revision < memory.five_axis_revision` → 没有任何 owner 负责终结。run 永远等不到：（a）claim 要求 revision 相等，不会再被领取；（b）complete 的 revision guard 拒绝写入；（c）deprojection 只在 ineligible 时触发。结果：lease 过期后成为永久 stale running。

### 1.2 outbox（对照，不修改）

outbox 侧已有完整语义：`claimFiveAxisOutboxForExecution` 的 `stale_revision` 拒绝 + `skipRejectedFiveAxisDelivery` 终结；`completeFiveAxisOutboxExecution`/`failFiveAxisOutboxClaim` 内的 `CASE WHEN revision 相等` 降级为 `skipped`。axis run 缺的就是这一层。

## 2. 根因与 owner 选择

### 2.1 根因（代码实证）

E 写坐标（`runCoordinateBackfill`，projection.ts:98-108 的 `projectCoordinates`）→ UPDATE `memories.thread` → trigger `trg_memories_five_axis_after_material_update`（migrations/20260719_five_axis_outbox_status_check.sql:56-86）推进 `five_axis_revision` 并插入新 revision outbox → 旧 run 的 `completeFiveAxisRun` 被 currentMemoryGuard（memoryFiveAxisRuns.ts:173-186）拒绝 → orchestrator 把该 axis 记为 `deferred`（projection.ts:159-169）→ 旧 run 行永远停留在 `running` 直到 lease 过期。

功能不卡住是因为新 revision outbox 由 scanner 正常消费；烂尾的只是旧 revision 的 run 行。

### 2.2 owner 选择：**DB store（`memoryFiveAxisRuns.ts`）**

在 `completeFiveAxisRun` / `failFiveAxisRun` 的 guarded write 未命中时，由同一函数执行第二条**单语句 guarded** supersession UPDATE。

理由：

1. **唯一 owner 原则**：claim/complete/fail 的并发 guard 本来就全部在 store 层；orchestrator 或 consumer 若拥有终结权，必须"先查再写"，违背任务书 8.1。
2. **先例一致**：deprojection 的 run 终结（memoryDeprojection.ts:422-445）同样在 store 层以单语句 guarded UPDATE 完成。
3. **调用方零成本继承**：projection 的 E 路径、未来任何 axis、任何 late delivery，全部自动获得同一语义，不会出现 E 专用分支。
4. consumer 不合适：run 的 claim 发生在 projection 内，consumer 崩溃时根本不在场（见 §3 问题 5）。

### 2.3 根因之外的关联缺陷（本 spec 一并定义，不扩大实现范围）

- `failFiveAxisRun` 没有 revision guard（memoryFiveAxisRuns.ts:264-289）。late `fail` 会把旧 revision 行写成 `failed`——一个 revision 相等才能被领取、因而永远不能再被领取的 `failed` 行，构成与 stale running 同类的永久 drift。supersession 语义必须对 `complete` 和 `fail` 对称。
- `projection.ts:240` 内部错误串 `superseded_by_revision:${n}` 与生产已使用的稳定 reason `superseded_by_newer_memory_revision`（scripts/inactive-five-axis-repair.mjs:73）不一致。持久化 `result_json` 一律用后者；orchestrator 的内存态 outcome 复用已有的 `AxisProjectionOutcome.status = "superseded"` 与 `supersededByRevision` 字段，不再编造错误串。

## 3. 任务书六个问题的回答

**Q1：`completeFiveAxisRun()` 返回 `false` 目前可能表示哪些竞争结果？**

1. run 行不存在（从未 claim 成功）；
2. run 已 terminal（`applied/skipped` —— 另一个 completion 获胜）或已 `failed`；
3. run 是 `pending_review` 且已被 candidate 复核改写；
4. claim_token 不匹配（lease 过期后被新 owner 以同 revision 重新 claim）；
5. **memory revision 已推进（superseded）**——本次要分离出来的情况；
6. memory missing；
7. memory ineligible（deprojected 或其他路径）；
8. `pending_review` 但 candidate keys 为空的输入校验早退。

当前一个 boolean 掩盖了全部 8 种，这正是任务书 8.1 反对的。

**Q2：revision 推进后谁拥有 terminalization？**

DB store。理由见 §2.2。orchestrator/consumer 都拥有"是否继续流程"的判断权，但不拥有旧 run 行的写回权。

**Q3：如何保证不覆盖并发获胜者？**

supersession 是一条单语句 UPDATE，全部谓词写在 WHERE 里，无任何先查：

```sql
UPDATE memory_five_axis_runs
SET status = 'skipped',
    result_json = json_object(
      'reason', 'superseded_by_newer_memory_revision',
      'previous_revision', memory_revision,
      'current_revision', (SELECT memory.five_axis_revision FROM memories AS memory
                           WHERE memory.namespace = memory_five_axis_runs.namespace
                             AND memory.id = memory_five_axis_runs.memory_id)),
    last_error = NULL,
    claim_token = NULL, lease_expires_at = NULL,
    completed_at = ?, updated_at = ?
WHERE namespace = ? AND memory_id = ? AND memory_revision = ? AND axis = ?
  AND status = 'running'           -- terminal 行天然免疫（不覆盖获胜者）
  AND claim_token = ?              -- token 已易主则免疫（lease 过期被重新 claim）
  AND EXISTS (SELECT 1 FROM memories AS memory
              WHERE memory.namespace = memory_five_axis_runs.namespace
                AND memory.id = memory_five_axis_runs.memory_id
                AND memory.five_axis_revision > memory_five_axis_runs.memory_revision)
```

三一道防线：`status='running'` 排除 terminal；`claim_token` 排除新 owner；revision **严格大于**排除同 revision 竞争与 future-revision 异常。与生产 repair SQL（inactive-five-axis-repair.mjs:70-89）形态完全一致——这不是新语义，是把已验证的 repair 语义前移为在线状态转移。

**Q4：E 写入 `thread` 推进 revision 后旧 E run 如何结束？**

E 的 `store.complete(rev1)` 未命中 → 同函数内执行 §3-Q3 的 supersession → rev1 行变为 `skipped`（reason/previous/current 稳定）→ complete 返回 `superseded` outcome → orchestrator 将 E 的 outcome 记为 `superseded`（不是 `deferred`），重读 memory 后走已有的 `supersededByRevision` 分支（projection.ts:239-250）返回 → consumer 用现有逻辑把旧 outbox 标 `skipped`（consumer.ts:132-139），不抛 `five_axis_stages_incomplete`。新 revision outbox 由 trigger 已生成、scanner 正常消费，旧函数内零递归、零重跑。

**Q5：consumer 在 side effect 后崩溃、旧 lease 过期时谁收口？**

分两类：

- **revision 未推进**：现有 ON CONFLICT reclaim（expired lease 可被同 revision 重新 claim）已覆盖，不改。
- **revision 已推进且旧 owner 永不返回**（崩溃进程不会再调用 complete/fail）：下一次当前 revision claim 同一 axis 时，由 DB store 在同一 batch 中先 guarded terminalize 更旧的完整 ownership `running` run 和无 ownership residue 的 `failed` run，再领取当前 revision。两步复用同一 supersession reason；不增加在线 worker、不递归重试，也不长期依赖人工 repair。

**Q6：历史 3 条如何复用同一语义收口？**

现有 repair 选择器（inactive-five-axis-repair.mjs:8-40）与 3 条 E stale run 的形状**逐字匹配**，唯一差别是 `run.axis = 'Y'`。把 axis 限定从 `'Y'` 放宽为全部五轴（`IN ('X','Y','Z','E','M')` 或直接去掉 axis 谓词），apply SQL 一字不改。审计脚本对应的 `staleFailedRepairable` / `staleExpiredRunningRepairable` 计数器同步放宽（inactive-five-axis-audit.mjs:174-192）。不新建脚本、不加 E 分支、不加新状态。

## 4. 建议修改的函数和 SQL guard

| 位置 | 修改 |
|---|---|
| `src/db/memoryFiveAxisRuns.ts` `claimFiveAxisRun` | 领取当前 revision 前，在同一 D1 batch 内 terminalize 同 memory、同 axis 的严格旧 revision `running/failed` run；malformed ownership 和 candidate-linked run 不处理 |
| `src/db/memoryFiveAxisRuns.ts` `completeFiveAxisRun` | guarded write 未命中时执行 §3-Q3 supersession；返回值从 `boolean` 改为可区分 outcome（建议 `'completed' \| 'superseded' \| 'not_owned'`，pending_review 分支同构） |
| `src/db/memoryFiveAxisRuns.ts` `failFiveAxisRun` | 同上对称处理，返回 `'failed' \| 'superseded' \| 'not_owned'` |
| `src/memory/fiveAxis/projection.ts` `AxisRunStore` 接口 + `runAxisStage` | 适配新返回类型；`superseded` 映射为已有 outcome status `"superseded"`（不再落入 `deferred`）；删除/替换内部错误串 `superseded_by_revision:${n}` |
| `scripts/inactive-five-axis-repair.mjs` | 选择器 axis 谓词放宽（Y → 全五轴），其余不动 |
| `scripts/inactive-five-axis-audit.mjs` | `staleFailedRepairable`/`staleExpiredRunningRepairable` 计数器同步放宽 |

行为变化（有意）：E 应用坐标后 consumer 不再记录 `five_axis_stages_incomplete:deferred=...` 伪失败，outbox 直接 `skipped`；正常返回时旧 run 即时 terminal，崩溃遗留由下一次同 axis current-revision claim 在线收口。

## 5. 明确不修改的范围

- 不增加新 run status（复用 `skipped`）；不加表字段；不加 migration。
- 不把旧 run 标成 `applied`/`failed`；不覆盖 terminal run；不覆盖 claim_token 已变化的行。
- `pending_review` 及 candidate-linked run 完全不受 supersession 影响（谓词 `status='running'` 天然排除）。
- memory ineligible/missing 不属于本转移：ineligible 由 deprojection 收口，missing 暂由审计观察，均不在此引入 catch-all。
- 不递归重跑；新 revision 由既有 trigger→outbox→scanner 接管。
- 不动 relation、Vector、reprojection、deprojection 主体；不动 outbox 状态机。
- 不顺手修改 `retryFiveAxisDeadLetter`、candidate reconciliation。
- 生产边界：本 spec 不授权任何 `--apply`、部署或 PR 操作。

## 6. 测试清单

单测（`tests/five-axis-runs.test.ts`，mock D1）：

1. complete 未命中 + revision 严格更大 + token 匹配 + status=running → supersede 成功，返回 `superseded`，result_json 三元组稳定，claim/lease 清空；
2. complete 未命中 + revision 相等 + token 不匹配 → 不 supersede，返回 `not_owned`，行不变；
3. complete 未命中 + run 已 terminal → 不覆盖，返回 `not_owned`；
4. `run.memory_revision > memory.five_axis_revision`（future 异常）→ 不 supersede；
5. fail 路径对称覆盖 1-4；
6. 同 revision 正常 complete/fail → 原行为逐字不变。

Worker 集成（`tests-worker/e-axis-and-run-guards.test.ts` 或新增同目录文件，真实 D1）：

7. E rev1 真实写入 thread → revision 推进 → rev1 run = `skipped`、reason=`superseded_by_newer_memory_revision`、previous/current 正确、claim/lease 为 NULL；rev2 outbox 存在且可正常执行完成；
8. 旧 owner 的 late complete 在新 owner terminal 之后到达 → 不覆盖获胜状态；
9. consumer 路径：superseded 时 outbox = `skipped` 且不抛 `five_axis_stages_incomplete`；
10. 旧 owner 在 side effect 后崩溃，current revision claim 同一 axis → 旧 running run 在线转 `skipped`，当前 run 正常获得新 claim；
11. expired stale running（token/lease 完整、无 candidate link、revision 落后）→ repair dry-run 选中、apply 标 `skipped`、审计归零；
12. running + 缺 token/lease → 只计入 `ownership_anomalies`，在线 claim cleanup 与 repair dry-run 均不选中。

投影单测（`tests/five-axis-projection.test.ts`）：

13. E applied 且 revision 推进 → 结果 `supersededByRevision` 有值、X/Y/Z/M 均为 `superseded`、无 failed/deferred axis；
14. E 无写入且 revision 未变 → 现有断言不变（回归）。

本地验证命令：`npm run typecheck`、`npm run types:check`、`npm run test:unit`、`npm run test:worker`，并报告实际输出而非"全绿"。

## 7. 历史三条的 dry-run / apply 边界

1. **先部署代码、后收口历史**：在线 supersession 生效后，历史 3 条仍是 lease 已过期的 stale running，走离线 repair。
2. dry-run（SELECT only）：`npm run repair:inactive-five-axis-d1 -- --remote --namespace default --json`，预期 `expired_running_rows = 3`（或含其他轴的同类行——以实际输出为准并如实报告，若出现 Y/E 之外的轴需停下来讨论）。
3. apply：单次有界，`--limit 3 --apply --confirm inactive-five-axis-d1`；**需要用户明确授权**，不自动循环，apply 后复跑 dry-run 确认 `remaining = 0`。
4. 收口后跑只读审计 `npm run audit:inactive-five-axis -- --remote --namespace default --json`，预期 axis-run 相关计数归零、`ownership_anomalies = 0`。
5. 若 dry-run 中任何一行不满足"token/lease 完整、无 candidate link、revision 严格落后、memory eligible"，该行不入 apply 范围，只报警。

## 8. 与任务书不同的判断

1. **返回值类型**：任务书边界清单未提签名变化，但它自己的 8.1（"不要用模糊的 boolean 掩盖多个失败原因"）要求把 `false` 拆开。我建议 complete/fail 返回可区分 outcome，这是本 spec 唯一的接口变化，影响面限于 `AxisRunStore` 与其测试替身。
2. **consumer 伪失败**：任务书说"功能没有卡住"，属实但不完整——当前 E 应用坐标的正常路径必然产生一次 `five_axis_stages_incomplete:deferred=...` 错误事件与 outbox fail 记录。supersession 落地后该噪音应消失，我把它列为预期行为变化而非附带损伤。
3. **fail 路径**：任务书第 7 节只描述了 complete 被拒，但 `failFiveAxisRun` 完全没有 revision guard，是同根因的另一半。不一起定义，stale 问题会以 stale failed 的形式残留。
4. **repair 放宽范围**：任务书说"历史三条复用同一语义"，我进一步明确：实现方式就是放宽既有 repair 的 axis 谓词，而不是新增任何代码路径；apply SQL 保持原样。
5. **超出范围但值得 Codex 核实的观察**：trigger 的 `UPDATE OF` 列不含 `active_fact`（20260719 migration），即理论上存在"变 ineligible 但不推进 revision"的写路径，其 run 行既不被本 supersession 覆盖、也不被 deprojection 覆盖（deprojection 自己会推进 revision，但若调用方绕过它直接改 `active_fact` 则无收口）。审计已有 `ineligible_non_terminal` 计数，本 spec 不处理，建议留作后续路线的一项。

---

## 回报（按任务书 §12 模板）

- 我检查了：`memoryFiveAxisRuns.ts`、`memoryFiveAxisOutbox.ts`、`projection.ts`、`consumer.ts`、`memoryDeprojection.ts`、`fiveAxisStatuses.ts`、`coordinateBackfill.ts`（调用关系）、migrations 20260715/20260716/20260719/20260723 的 trigger 定义、`inactive-five-axis-audit.mjs`、`inactive-five-axis-repair.mjs`、`repair-inactive-five-axis-d1.mjs`、`tests/five-axis-runs.test.ts`、`tests-worker/e-axis-and-run-guards.test.ts`
- 当前 owner：claim/complete/fail = DB store；revision 推进 = D1 trigger；新 revision 重做 = outbox/scanner；ineligible 收口 = deprojection；**stale revision 收口 = 无 owner（缺口）**
- 根因：E 写 thread → trigger 推进 revision → complete 的 revision guard 拒绝 → run 行无人终结（§2.1）
- 最小状态转移：`running` 且 `memory.five_axis_revision > run.memory_revision` → `skipped`，reason `superseded_by_newer_memory_revision`（§3-Q3）
- 并发 guard：单语句 UPDATE，`status='running'` + claim_token + 严格 revision 大于，三防线（§3-Q3）
- 不会修改：见 §5
- 需要补的测试：见 §6，共 13 项
- 生产动作：无（apply 需用户另行授权）
- 与说明书不同的判断：见 §8，共 5 条
