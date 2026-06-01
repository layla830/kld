# kld 维护补记：2026-06-01 follow-up

仓库：`layla830/kld`  
Worker：`kld`

## 已确认

### D1 schema P0 已解除

远端 D1 已通过只读查询确认存在以下列：

```txt
messages.chunk_processed_at
usage_logs.client_system_hash
usage_logs.cache_anchor_block
```

仓库 migration 中也已经覆盖这些列：

```txt
migrations/20260520_auto_conversation_chunks.sql
migrations/0002_v4_assembler_cache.sql
```

因此不要再为这三列新增重复 migration，也不要直接执行补列 SQL。

### admin browse tab 已修

提交：`2f2cce1 Keep admin browse chronological and hide timeline splits`

修复点：

1. `browse` tab keyword 查询排除 `source = 'timeline_split'`，并保留 `source IS NULL` 的普通旧记录。
2. `browse` tab 默认改回按 `created_at DESC, updated_at DESC` 排序，避免被 `pinned` / `updated_at` 打乱时间顺序。
3. semantic 搜索结果也排除 `timeline_split`，避免绕过 SQL filter。

注意：分段日记仍在 D1 中，不删除；只是 admin browse 普通浏览不展示，避免干扰人工整理。

## 暂时不要做

```txt
不要补 D1 schema 三列
不要打开 AUTO_DIARY_ENABLED
不要改 diary/raw 正文
不要把 timeline_split 删除
不要按 legacy:vps 或 importance=1 一刀切
```

## 仍待处理

Queue idempotency key 仍是随机 key，但不要草率改成只按 conversation 去重；过粗的 key 会挡住同一 conversation 后续新 chunk。需要单独设计稳定且带窗口边界的 key。
