# kld 维护记录：2026-06-01

仓库：`layla830/kld`  
Worker：`kld`  
Cloudflare 自动部署：已确认开启，`main` 分支提交后会触发 build/deploy。  
当前线上 `/health`：`ok: true`

## 一、背景

昨天去掉 admin 密码 fallback 后，前端一度登录失败。根因不是 D1，也不是 binding，而是 Cloudflare Worker 环境里缺少 `ADMIN_PASSWORD` secret。后续 secret 已补，前端恢复。

今天主要目标：

1. 避免以后继续部署到旧 Worker 名 `companion-memory-proxy`。
2. 收紧 admin auth，避免三处重复认证逻辑再次被改歪。
3. 清理 books 后端里最明显的重复 schema、N+1 查询和导入写入问题。
4. 增加后台管线可观测性，确认 queue/chunk 当前到底是什么状态。
5. 让 `/health` 输出更诚实，明确说明 chunk generation 是配置关闭，不是故障。

## 二、今天已完成的改动

### 1. Worker 名称修正

提交：

```txt
e6644cd  Set Worker name to kld
```

改动：

```toml
name = "kld"
```

原因：

仓库原本 `wrangler.toml` 里还是：

```toml
name = "companion-memory-proxy"
```

这会导致从 GitHub/main 或本地干净目录部署时，目标 Worker 变成 `companion-memory-proxy`，而不是当前实际使用的 `kld`。

现在已修正为 `kld`，避免继续产生旧 Worker 部署混乱。

### 2. admin auth 去重

提交：

```txt
d7f8a7e  Reuse shared admin auth in maintenance page
bd00535  Reuse shared admin auth in startup pages
```

改动文件：

```txt
src/api/adminMaintenance.ts
src/api/adminStartup.ts
```

效果：

原来 admin 密码校验逻辑重复在三处：

```txt
src/api/adminBoard/auth.ts
src/api/adminMaintenance.ts
src/api/adminStartup.ts
```

现在 `adminMaintenance.ts` 和 `adminStartup.ts` 统一复用：

```ts
import { isAuthorized, unauthorized } from "./adminBoard/auth";
```

admin auth 只保留一份实现，降低后续被改不一致的风险。

### 3. books schema 抽出

提交：

```txt
c9ed9e2  Extract books schema helper
```

新增文件：

```txt
src/db/booksSchema.ts
```

效果：

把 `ensureBooksSchema` 从 `src/api/books.ts` 抽出，避免 API 文件里继续塞建表逻辑。

当前 `books.ts` 改为：

```ts
import { ensureBooksSchema } from "../db/booksSchema";
```

### 4. books 列表 N+1 查询修复

提交：

```txt
3e840b0  Reuse books schema and batch progress loading
```

改动：

原来 `/books/api/list` 是：

```txt
查 books
然后每本书单独查 book_progress
```

现在改为：

```txt
查 books
一次性按 book_id 批量查 book_progress
组装 progressByBook
```

效果：书多时减少数据库查询次数。

### 5. `/admin/maintenance` 增加后台管线状态面板

提交：

```txt
95ac0cc  Show read-only background pipeline status
```

改动文件：

```txt
src/api/adminMaintenance.ts
```

新增只读展示：

```txt
Queue binding
Auto memory
Auto diary / chunk generation
idempotency task status
messages chunk 标记
diary / timeline_day / chunk 产出
```

注意：这个面板只读，不触发 queue，不补跑 chunk，不修改任何业务逻辑。

如果 `messages.chunk_processed_at` 不存在，页面不会崩，会显示 schema 不可用提示。

线上看到的状态：

```txt
Queue binding: enabled
Auto memory: enabled
Auto diary / chunk generation: disabled
task status done: 137
processed messages: 0
unprocessed messages: 5
diary: 73
timeline_day: 66
layla_diary: 9
```

结论：

- Queue binding 是存在的。
- 后台任务表里已经有 done 记录。
- 当前 chunk generation disabled 是配置结果。
- 因为 `AUTO_DIARY_ENABLED=false`，conversation_chunk 不会生成 diary/chunk memory。
- 当前不应误判为 queue 或 chunk 故障。

### 6. books import 改为按书批量写入

提交：

```txt
0d228c7  Batch book import writes per book
```

改动文件：

```txt
src/api/books.ts
```

改动：

新增：

```ts
const D1_BATCH_LIMIT = 50;
chunk();
runBatched();
buildImportStatements();
```

效果：

`importBooks` 现在按每本书组装 SQL statements，再用 `db.batch` 分批执行。

这不是严格事务，但比原来一条条 `await` 更清楚，也减少导入半残窗口。

没有做严格 transaction，因为 D1 transaction 支持和 Workers runtime 行为还需要单独确认，暂时不硬上。

### 7. `/health` 输出更诚实

提交：

```txt
12346a3  Clarify feature status in health response
```

改动文件：

```txt
src/api/health.ts
```

变化：

`service` 从旧名：

```json
"companion-memory-proxy"
```

改成：

```json
"kld"
```

新增 `features`：

```json
{
  "chat_gateway": "disabled_by_config",
  "memory_mcp": "enabled",
  "admin": "enabled",
  "queue": "bound",
  "auto_memory": "enabled",
  "auto_diary": "disabled_by_config",
  "chunk_generation": "disabled_by_config"
}
```

新增 warning：

```txt
AUTO_DIARY_ENABLED=false; conversation_chunk will only mark messages processed and will not generate diary/chunk memories
```

这样以后不会再把“chunk generation 被配置关闭”误解成 queue 故障。

### 8. books 日期解析和 progress 查询加固

提交：

```txt
24f15c4  Harden books date parsing and progress lookup
```

改动文件：

```txt
src/api/books.ts
```

改动：

新增：

```ts
const D1_BIND_LIMIT = 90;
safeIsoDate();
```

效果：

1. `importBooks` 里 `created_at` / comment `time` 遇到坏日期时，不会 `new Date(...).toISOString()` 直接 throw，而是 fallback 到当前 `now`。
2. `readProgressForBooks` 按 `D1_BIND_LIMIT` 分批查，避免书太多时 SQL bind 参数过多。

## 三、今天明确没有动的东西

今天没有改：

```txt
D1 migration
D1 schema
Cloudflare secrets
Cloudflare bindings
queue consumer 逻辑
chunk 生成逻辑
recall/search ranking
memory extract / merge 算法
聊天网关逻辑
books UI
readingMcp 核心逻辑
```

尤其没有打开：

```txt
AUTO_DIARY_ENABLED
ENABLE_CHAT_GATEWAY
```

## 四、当前线上验证结果

Cloudflare 自动部署已确认生效。

`/health` 当前为：

```json
{
  "ok": true,
  "service": "kld",
  "mode": {
    "chat_gateway": false,
    "memory_mcp": true,
    "admin": true,
    "auto_memory": true,
    "auto_diary": false
  },
  "features": {
    "chat_gateway": "disabled_by_config",
    "memory_mcp": "enabled",
    "admin": "enabled",
    "queue": "bound",
    "auto_memory": "enabled",
    "auto_diary": "disabled_by_config",
    "chunk_generation": "disabled_by_config"
  },
  "missing_text_vars": [],
  "missing_upstream_vars": [],
  "warnings": [
    "AUTO_DIARY_ENABLED=false; conversation_chunk will only mark messages processed and will not generate diary/chunk memories"
  ],
  "bindings": {
    "ai": true,
    "d1": true,
    "vectorize": true,
    "queue": true
  }
}
```

这是预期状态。

`/admin/maintenance` 已确认能打开，并显示后台管线状态。

## 五、当前重要结论

### 1. 线上不是 D1/binding 故障

当前：

```txt
ADMIN_PASSWORD 生效
MEMORY_MCP_API_KEY 生效
D1 binding 正常
Vectorize binding 正常
Queue binding 正常
AI binding 正常
```

不要再因为 admin 登录或 health 输出去重建 D1、重绑资源、乱动 secret。

### 2. 当前没有 chunk 产出是预期

因为：

```txt
AUTO_DIARY_ENABLED=false
```

所以：

```txt
conversation_chunk 只会标记 processed
不会生成 diary/chunk memory
```

现在不应该改 chunk 逻辑，也不应该打开 AUTO_DIARY_ENABLED。原因是当前还没有整理好原始记录和 chunk 设计。

### 3. `companion-memory-proxy` 是旧 Worker 名遗留

仓库以前 `wrangler.toml` 写的是：

```toml
name = "companion-memory-proxy"
```

现在已改为：

```toml
name = "kld"
```

Cloudflare 里的旧 `companion-memory-proxy` Worker 先不要急着删。先确认没有旧客户端、书签、MCP 配置还在访问它，再考虑停用或删除。

## 六、之后要做什么

### P0：处理 D1 schema 可复现问题

这是当前最重要的剩余问题。

代码在用这些列：

```txt
messages.chunk_processed_at
usage_logs.client_system_hash
usage_logs.cache_anchor_block
```

但 `migrations/0001_init.sql` 里可能没有这些列。

需要先查线上 D1：

```sql
PRAGMA table_info(messages);
PRAGMA table_info(usage_logs);
```

确认线上是否已有：

```txt
messages.chunk_processed_at
usage_logs.client_system_hash
usage_logs.cache_anchor_block
```

如果线上有，仓库 migration 需要补齐，保证新库可复现。

如果线上没有，不能直接乱跑 migration，要先做安全补列方案。

建议新增 migration，方向大概是：

```sql
ALTER TABLE messages ADD COLUMN chunk_processed_at TEXT;

ALTER TABLE usage_logs ADD COLUMN client_system_hash TEXT;
ALTER TABLE usage_logs ADD COLUMN cache_anchor_block TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_chunk_processed
ON messages(namespace, conversation_id, chunk_processed_at);
```

注意：SQLite/D1 对 `ADD COLUMN` 没有通用 `IF NOT EXISTS`，线上执行前必须先查表结构，避免重复列报错。

### P1：Queue idempotency key 改成确定性

当前 queue producer 里 idempotency key 仍可能是随机生成。

理想改成确定性 key，例如：

```txt
memory_maintenance:<namespace>:<conversationId>:<fromMessageId>:<toMessageId>
conversation_chunk:<namespace>:<conversationId>:<source>
retention:<namespace>
```

目的：防止同一业务任务重复入队时无法识别。

这项不改变 chunk 产出逻辑，也不打开 AUTO_DIARY_ENABLED，但会影响后台任务去重，需要谨慎小改。

### P1：补 Cloudflare 配置文档

建议新增：

```txt
docs/cloudflare-config.md
```

内容包括：

```txt
Required secrets
Required plaintext vars
Optional chat gateway vars
Bindings
当前故意关闭的功能
companion-memory-proxy 遗留说明
```

目标是避免以后 Codex/DS 又把登录问题、D1、binding、secret 混在一起乱修。

### P2：admin 页面公共布局抽出

当前 admin auth 已去重，但 HTML layout / nav / escape / style 仍散在多个 admin 文件里。

可后续抽：

```txt
src/api/adminBoard/layout.ts
```

不是紧急问题。

### P2：books import 严格事务化

今天只改成按书 `db.batch`，不是严格 transaction。

后续如果确认 D1 transaction 能在当前 Workers runtime 里稳定使用，再考虑把每本书导入改成真正事务。

### 暂时不要做

暂时不要动：

```txt
recall ranking
chunk 生成逻辑
memory merge/extract 算法
AUTO_DIARY_ENABLED
ENABLE_CHAT_GATEWAY
Cloudflare binding / secret
```

这些要等 D1 schema 和原始记录整理完之后再看。

## 七、给之后维护者的提醒

当前仓库 `main` 是线上自动部署源。直接 push/main commit 会触发 Cloudflare build。

每次改动后至少检查：

```txt
Cloudflare build 是否成功
/health 是否 ok:true
/admin/maintenance 是否能打开
books 页面是否能 list/page/progress/comment
```

不要把 `/health` 的 `AUTO_DIARY_ENABLED=false` warning 当成故障。它只是说明当前 chunk generation 按配置关闭。
