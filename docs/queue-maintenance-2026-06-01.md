# kld Queue 维护记录：2026-06-01

## 范围

本次只修改 queue producer 的 idempotency key 生成方式，不改 consumer，不改 chunk 生成逻辑，不改 D1 schema。

文件：

```txt
src/queue/producer.ts
```

提交：

```txt
466bee7 Use deterministic queue idempotency keys
c66d7b9 Harden chunk idempotency window sizing
```

## 修复内容

### memory_maintenance

原来：

```txt
idempotencyKey = random idem id
```

现在：

```txt
memory_maintenance:<namespace>:<conversationId>:<fromMessageId>:<toMessageId>
```

效果：同一对 user/assistant message 触发的重复维护任务会被 `idempotency_keys` 表挡住。

### conversation_chunk

原来：

```txt
idempotencyKey = random idem id
```

现在入队前先读取当前 unprocessed message 窗口，使用窗口边界生成 key：

```txt
conversation_chunk:<namespace>:<conversationId>:<source>:<firstMessageId>:<lastMessageId>:<count>
```

效果：

- 同一个未处理窗口重复入队，会被挡住。
- 同一个 conversation 后续新消息进入后，窗口边界或 count 会变化，不会被旧 key 挡住。
- 没有粗暴按 conversation 去重。

### 配置兜底

`AUTO_CHUNK_MIN_MESSAGES` / `AUTO_CHUNK_MAX_MESSAGES` 会被解析为正整数；无效时使用默认值，避免把 `NaN` 传给 D1 `LIMIT`。

## 没有处理

`retention` 任务仍未接入 idempotency key。当前本次先不改 consumer，也不扩大范围；后续如果 retention 重复执行造成明显成本或日志噪声，再单独处理。

## 注意

当前 `AUTO_DIARY_ENABLED=false` 时，conversation_chunk consumer 仍会把候选 messages 标记为 processed，但不会生成 diary/chunk memory。这是既有行为，本次没有改变。
