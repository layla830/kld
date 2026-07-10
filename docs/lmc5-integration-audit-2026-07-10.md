# LMC-5 / KLD 闭环差分审计（2026-07-10）

## 结论

KLD 已经是 Worker-native 的 LMC-5 实现，不应把上游 Python 后端整体移植进来。当前正确边界是：

- Worker / D1 / Vectorize 负责长期记忆、XYZEM 元数据、召回、审核、回滚与管理页。
- VPS 只从原始 chunk 生成带证据的候选，并同步到 Worker 的 `memory_candidates` 审核队列。
- 模型不得直接更新、删除或 supersede 正式记忆。

本轮仓库改动封闭了四个缺口：全新迁移恢复、Memory API 未捕获异常、ActiveRecall 两级工具、E 轴回应姿态的可验证接线。

## 已验证基线

- 基线提交：`09874b7 Worker dream: explicit fallback only; fix m-review approved re-bubbling`
- `node scripts/lmc5-circuit-audit.mjs`：本轮实测改动前 40/40，通过；改动后 45/45，通过（7 月 10 日旧交接写的 41 条与实际脚本计数相差 1，以本轮程序计数为准）。
- `npx tsc --noEmit`：通过。
- 从空目录执行全部 D1 migrations：修复前在 `20260704_candidate_result_link.sql` 失败；修复后 12/12 通过。
- Wrangler dry-run 在当前受限 Windows sandbox 中因无法读取父目录而失败；这是本地权限边界，不是 TypeScript 或 migration 错误，需在正常用户会话或 CI 再跑一次。

## 五维与三条链路状态

| 维度/链路 | 当前状态 | 证据与剩余项 |
|---|---|---|
| X Timeline | 已闭环 | chunk 确定性 thread、日期审核、分页 cursor、narrative/timeline sweep 均有 audit。 |
| Y Relations | 代码闭环，运营补边继续 | safe types、2-hop、强度阈值、live endpoints、review-only 排除均已实现；全库补边仍应小批量 dry-run 后审核。 |
| Z Fact Evolution | 已闭环 | mutation review-first、fact group、supersede approve/reject/rollback 完整。 |
| E Experience | 已闭环到召回姿态 | shadow gate 控制排名；`recallFormat` 已输出 `response_posture`；startup 明确 E 轴只调语气、不改事实。 |
| M Metabolism | 已闭环 | read-only patrol、candidate queue、snapshot、approve/reject/rollback、保护类型、关系端点展示均有 audit。 |
| Write Path | Worker 侧闭环；VPS 当前断 | Worker 只保留 explicit fallback；VPS 定时任务被失效 HTTP 代理 407 阻断，且 live shadow 脚本尚缺 evidence/min-length/self-loop 硬闸。 |
| Night Path | Worker 元数据维护闭环；VPS 候选生成未闭环 | 实际 unit 运行 `kld_candidate_pipeline.py`，不是 `/home/ubuntu/kld_dream_candidates_v2.py`。后者的新增闸没有接入生产。 |
| Recall Path | Worker 代码闭环；部署/宿主接线待验 | `memory_search` 精确检索、`memory_recall` 深度召回、旧 `retrieve_memory` 兼容；startup 指令要求不确定先查。需部署后验证 MCP `tools/list` 与 cc-connect 实际调用。 |

## 本轮仓库改动

1. `migrations/20260704_candidate_result_link.sql`
   - 在 `ALTER TABLE` 前兼容性创建 `memory_candidates`。
   - 保留历史 migration 文件名，避免线上已登记 migration 被重复执行。

2. `src/api/memories.ts`
   - Memory API 路由增加显式错误边界。
   - 未捕获异常记录结构化 `request_id`、method、path、错误类型与 stack。
   - 客户端收到 JSON 500 和 `x-request-id`，不再退化成 Cloudflare 1101 HTML。
   - 不记录请求 body，避免记忆正文进入日志。

3. `src/api/mcp.ts`
   - 暴露 `memory_search`：专名、日期、代号、引用和精确词的 lexical 搜索。
   - 暴露 `memory_recall`：语义、文字、关系图合并后的深度召回。
   - 保留 `retrieve_memory` 作为兼容别名。

4. `src/memory/startupContext.ts`
   - 增加 ActiveRecall 硬准则：人名、日期、过去事件、旧约定和不确定事实必须先检索。
   - 明确空结果不得用想象补齐。
   - 明确当前用户陈述优先于旧记忆，E 轴只影响回应姿态。

5. `scripts/lmc5-circuit-audit.mjs`
   - 新增 fresh migration、Memory API 错误边界、两级 ActiveRecall、startup directive、E posture 五条断言。

## 线上实际断点

### 1. Dream 定时任务被 407 阻断

实际 unit：`kld-dream.service`。

实际入口：

```text
/home/ccagent/cc-workspace/tools/kld_candidate_pipeline.py
  -> kld_dream_candidate_shadow.py --candidate-only
  -> kld_candidate_sync.py
```

`EnvironmentFile=/home/ccagent/.cc-connect/secrets/env` 同时注入了 HTTP/HTTPS proxy。验证结果：

- 继承 service proxy 请求 DeepSeek：`407 Proxy Authentication Required`
- 去掉 proxy 直连 DeepSeek：`401`（网络路径正常，只有匿名请求缺认证）

结构修复应让 Dream 使用独立、最小的 secret 环境，或至少在 unit 最终环境中 unset `HTTP_PROXY/HTTPS_PROXY/http_proxy/https_proxy/ALL_PROXY/all_proxy`。不要修改全局 cc-connect 代理来迁就 Dream。

### 2. 修改过的 v2 脚本没有进入生产链

`/home/ubuntu/kld_dream_candidates_v2.py` 已有：

- `content >= 30`
- relation self-loop 过滤
- relations `[:12]`

但 systemd 不执行它。live `kld_dream_candidate_shadow.py` 仍 import 旧 `kld_dream.py`，只保留 prompt 约束，没有上述 parse 硬闸，也没有 evidence 铁律。

正确做法不是把 v2 的 direct-apply 路径直接改成生产入口，而是把这些硬闸迁入 candidate-only 的 live shadow 脚本，继续只写本地候选并同步审核队列。

### 3. 历史 1101 与当前 407 是两件事

- 历史 `kld-dream.jsonl` 确有 `/v1/memories POST` 的 1101。
- 当前 nightly 在调用 DeepSeek 时先被 407 阻断，尚未走到 Worker。
- 本轮已让 Memory API 将未来同类异常变成带 request ID 的 JSON 500。
- 精确的历史 stack 仍需 Cloudflare tail / Observability；本机无 `CLOUDFLARE_API_TOKEN` 且 Wrangler 未登录。

## 可交给其他 AI 的机械任务包

### A. VPS Dream 运行时修复

1. 备份 `/etc/systemd/system/kld-dream.service`。
2. 为 Dream 建独立最小 env，或在 unit 最终阶段 unset 六个 proxy 变量。
3. `systemctl daemon-reload`。
4. 先运行：

```bash
sudo -u ccagent env -u ALL_PROXY -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u http_proxy -u https_proxy \
  /usr/bin/python3 /home/ccagent/cc-workspace/tools/kld_candidate_pipeline.py --date 2026-07-09 --force
```

5. 验收：service 成功；本地候选有 provenance；Worker sync 返回 202；admin review 新增对应日期候选；正式 memories 不被自动修改。

### B. Live candidate evidence 硬闸

修改 `/home/ccagent/cc-workspace/tools/kld_dream_candidate_shadow.py`，不是切换到 direct-apply v2：

- prompt 要求每个候选含 `evidence`，必须是输入 source chunk 的逐字引用，最多 80 字。
- parse 层再次验证 evidence 非空、确实存在于引用 chunk 原文中，否则丢弃或标记 `needs_subject_review`。
- `content` 少于 30 个中文字符时丢弃。
- relation `source_memory_id == target_memory_id` 时丢弃。
- relation 最多 12 条，代码层截断。
- `{"candidates": []}` 是合法输出，不得当失败。
- `py_compile` 后只跑 candidate-only 样本；不 direct apply。

### C. Cloudflare / 发布验收

1. 不要在聊天中粘贴 Token；在正常用户环境本地设置 `CLOUDFLARE_API_TOKEN`。
2. 先运行 `wrangler tail kld --status error --format json`，保留 stack 和 request ID，不保留记忆正文。
3. 在正常会话或 CI 运行 `npx wrangler deploy --dry-run --keep-vars`。
4. 仅提交本轮明确文件，保留现有未跟踪 handoff/backup 文件。
5. 推 `main` 即由 Cloudflare 自动部署；不要额外手动 deploy。
6. 部署后 MCP `tools/list` 必须看到 `memory_search`、`memory_recall`、`retrieve_memory`。
7. 精确词用 `memory_search` 验证；过去事件问题用 `memory_recall` 验证；当前用户新陈述必须覆盖旧记忆。

## 验收命令

```text
node scripts/lmc5-circuit-audit.mjs
npx tsc --noEmit
npx wrangler deploy --dry-run --keep-vars
```

从零 migration 验收必须使用新的 `--persist-to` 目录，不能复用已有本地状态。
