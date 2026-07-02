# 交接：五维 Dream 夜间整理管线接入

日期：2026-06-25
分支：main（本地 D:\glm5.2\kld，已与 origin/main 同步）
状态：**代码完成，未部署。默认 OFF + dry-run ON，等部署后跑 dry-run review 再开 apply。**

## 做了什么

从 fork `wusaki0723/Aelios` 的 `lmc5-xyzem-memory` 分支搬来五维记忆闭环的"代谢侧"——之前 kld 只有召回侧五维（三层级联 + Y 2-hop + rerank），代谢侧（夜间整理 + Z 审计 + Y 建关系 + M 巡逻）完全是空的。这次把代谢侧补上。

## 新增文件（5 个）

| 文件 | 作用 |
|---|---|
| `migrations/20260625_dream_vector_sync_status.sql` | 加 `vector_sync_status` 三态列（synced/failed/pending/deleted），根据现有 `vector_synced` 回填 |
| `src/db/memoryEvents.ts` | `createMemoryEvent` 函数（kld 之前 memory_events 表只 DELETE 从没 INSERT） |
| `src/memory/state.ts` | 记忆同步层：createSyncedMemory / patchSyncedMemory / deleteSyncedMemory / markMemoryReviewSynced / supersedeSyncedMemory / retryStaleVectorSyncs |
| `src/memory/xyzem.ts` | 夜间维护三件套：runZAudit（同 fact_key 留最佳，弱者 review）/ runMetabolismPatrol（发现过期/待审）/ runRelationBuild（建 temporal_sequence / same_topic 安全关系） |
| `src/memory/dailyDigest.ts` | Dream 主体：按时间窗取当天聊天 → LLM 整理 → 产出带 XYZEM 坐标的 add/update/delete 计划 → 执行。**加了 DREAM_DRY_RUN 模式**（fork 没有）：dry-run 只跑 LLM 出建议写 memory_events，不真改 memories/relations |

## 改的文件（5 个）

| 文件 | 改了什么 |
|---|---|
| `src/index.ts` | 加 `scheduled` handler（调 runDreamBatches + runXyzemNightlyMaintenance + runMemoryRetention + retryStaleVectorSyncs）+ `/v1/debug/dream_dry_run` 路由 |
| `wrangler.toml` | 加 `[triggers] crons = ["10 20 * * *"]`（UTC 20:10 = Asia/Shanghai 04:10）+ ENABLE_DREAM/DREAM_DRY_RUN/DREAM_MODEL 等 `[vars]` |
| `src/types.ts` | Env 加 Dream 相关字段；MemoryRecord 加 `vector_sync_status` 可选字段 |
| `src/db/messages.ts` | 加 `listMessagesByNamespaceInRange`（按时间窗取消息，Dream 用） |
| `src/db/memories.ts` | 加 `listFactKeyConflicts`（Z audit 用）+ `listMemoriesSince`（Y relation build 用）+ UpdateMemoryInput 加 `vectorSyncStatus` + updateMemory 支持 vector_sync_status 写入 |
| `src/memory/coordinates.ts` | 加 `normalizeFactKey`（fork 有 kld 没有） |
| `src/memory/extract.ts` | ExtractedMemory 接口加 fact_key/thread/risk_level/urgency_level/tension_score/response_posture 可选字段 |
| `src/api/debug.ts` | 加 `handleDreamDryRun` 端点 |

## 配置（wrangler.toml，默认安全）

```toml
[triggers]
crons = ["10 20 * * *"]   # UTC 20:10 = Asia/Shanghai 04:10

[vars]
ENABLE_DREAM = "false"           # 默认关，先 dry-run 验证再开
DREAM_DRY_RUN = "true"           # 先只出建议不改记录
DREAM_MODEL = "deepseek/deepseek-v4-pro"
DREAM_TIME_ZONE = "Asia/Shanghai"
DREAM_MAX_MESSAGES = "40"
DREAM_MAX_RUNS = "5"
DREAM_MAX_TOKENS = "3000"
DREAM_MEMORY_CONTEXT_LIMIT = "40"
DREAM_EXCERPT_LIMIT = "8"
```

## 验证

- `npm run typecheck` ✅ 过
- `node scripts/verify-assembler.mjs` ✅ 199/199 全过（没破坏任何现有合约）
- `npm run test:recall-regression` ⚠️ 需要线上 API key，本地跑不了，**部署后必须跑一次**确认召回没退化

## 下一步（部署顺序）

1. `npm run db:migrate:remote` — 应用 vector_sync_status migration
2. `npm run deploy:cloudflare` — 部署（ENABLE_DREAM=false 所以 cron 不会真跑 Dream，scheduled handler 会跑 retention + retryStaleVectorSyncs，这是安全的）
3. 手动触发 dry-run：
   ```bash
   curl -X POST "https://<worker>/v1/debug/dream_dry_run" \
     -H "Authorization: Bearer <DEBUG_API_KEY>" \
     -H "content-type: application/json" \
     -d '{"dateLabel":"2026-06-24","force":true}'
   ```
   （dateLabel 用昨天的日期，因为 Dream 默认整理"昨天"。force:true 忽略游标。）
4. **Review dry-run 输出**——看 LLM 要 add/update/delete 哪些记忆，标 review 哪些。确认安全。
5. 看完觉得没问题，把 `ENABLE_DREAM` 改 `true`、`DREAM_DRY_RUN` 改 `false`，重新部署。
6. 跑 `npm run test:recall-regression` 确认召回没退化。
7. 第二天看 Cloudflare 日志确认 cron 跑了 + 看 memory_events 表有没有 dream 事件。

## 为什么 dry-run 默认开

`docs/lmc5-kld-integration-plan.md` 的 "Do Not Borrow Yet" 明确禁止"Automatic Z/M nightly maintenance that mutates records"直接搬。795 条真实数据，blind apply 可能误伤。所以做成可逆：先 dry-run 看建议，确认安全再开 apply。

## 还没做（后续优化）

- E 轴自动化：Dream 现在会产 E 轴字段（prompt 里引导了），但要观察 LLM 产出质量
- heartbeat 检测：完全没做（fork 也没有）
- swap 快照回滚：完全没做（优先级最低）
- 独立召回通道（literal/emotion/spontaneous）：没做
- VPS 上第三人称归纳退役：Dream 上线后可以退役，但要先确认 Dream 产出质量稳定
