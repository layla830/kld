# Code Review Notes

本文件记录对当前仓库的一轮快速 review。重点按“目前不使用 Cloudflare AI Gateway”的部署方式来检查。

## 总体结论

项目结构已经比较完整，主链路包含 OpenAI-compatible 聊天代理、长期记忆、MCP、管理页、导盲犬 API、队列维护和 Vectorize 检索。当前最大的问题不是功能缺失，而是部分配置仍强绑定 Cloudflare AI Gateway，以及少数权限边界需要收紧。

## P0：不用网关时必须处理

### 1. OpenAI-compatible 上游仍强依赖 AI Gateway 路径

位置：`src/proxy/openaiAdapter.ts`

当前请求会拼到：

```ts
${AI_GATEWAY_BASE_URL}/compat/chat/completions
${AI_GATEWAY_BASE_URL}/compat/embeddings
```

并且鉴权使用：

```ts
cf-aig-authorization: Bearer <CF_AIG_TOKEN>
```

如果直接接 OpenAI、DeepSeek、OpenRouter、Gemini 兼容接口，这个路径和 header 都不对。

建议新增通用变量：

```env
UPSTREAM_BASE_URL=https://api.example.com/v1
UPSTREAM_API_KEY=sk-xxx
```

并让普通 OpenAI-compatible 请求走：

```http
POST ${UPSTREAM_BASE_URL}/chat/completions
Authorization: Bearer ${UPSTREAM_API_KEY}
```

embedding 走：

```http
POST ${UPSTREAM_BASE_URL}/embeddings
Authorization: Bearer ${UPSTREAM_API_KEY}
```

保留 `AI_GATEWAY_BASE_URL + CF_AIG_TOKEN` 作为 Cloudflare AI Gateway 兼容模式即可。

### 2. `/health` 仍把 AI Gateway 变量当必填

位置：`src/api/health.ts`

当前 `AI_GATEWAY_BASE_URL`、`CF_AIG_TOKEN` 被放进必填检查。若不用网关，即使普通上游配置正确，health 也会显示不健康。

建议 health 改成二选一：

- 普通上游模式：`UPSTREAM_BASE_URL + UPSTREAM_API_KEY + CHATBOX_API_KEY`
- Cloudflare AI Gateway 模式：`AI_GATEWAY_BASE_URL + CF_AIG_TOKEN + CHATBOX_API_KEY`

## P1：安全和权限边界

### 3. URL token 目前对所有接口都可用

位置：`src/auth/apiKey.ts`

`authenticate()` 会从 URL `?token=` 读取 token。这个对 MCP 很方便，但如果所有 API 都支持 URL token，密钥容易进入浏览器历史、日志和 Referer。

建议：只有 `/mcp` 或 `/memory-mcp` 允许 URL token；其他接口只接受：

```http
Authorization: Bearer xxx
```

或：

```http
x-api-key: xxx
```

### 4. Cache namespace 隔离过宽

位置：`src/api/cache.ts`

`canAccessNamespace()` 里只要 profile 有 `cache:read` scope，就能访问任意 namespace。chatbox / im 本身就有 `cache:read`，这会导致 namespace 隔离失效。

建议改成：

```ts
return profile.debug || namespace === profile.namespace;
```

若确实需要跨 namespace，再新增单独的 `cache:admin` scope。

### 5. 管理后台不建议 fallback 到 MEMORY_MCP_API_KEY

位置：`src/api/adminBoard/auth.ts`

当前后台密码来源是：

```ts
ADMIN_PASSWORD || MEMORY_MCP_API_KEY
```

MCP key 可能配置在客户端或 URL 中，暴露面比后台密码大。建议后台只接受独立的 `ADMIN_PASSWORD`。没有该变量时禁用管理后台。

## P1：功能一致性

### 6. 图片请求 + Anthropic native 目前不是真正的视觉转换

位置：

- `src/api/chatCompletions.ts`
- `src/assembler/toAnthropic.ts`

图片请求会切到 `VISION_MODEL`，但 Anthropic native 转换目前会把结构化 `image_url` 直接 JSON.stringify 成文本。OpenAI-compatible 多模态可以保留 image_url，但 Anthropic native 不能正确表达图片。

建议：

- 要么图片请求强制走 OpenAI-compatible 视觉模型；
- 要么实现 Anthropic native image block 转换。

### 7. Queue fallback 在生产环境可能拖慢请求

位置：`src/queue/producer.ts`

没有 `MEMORY_QUEUE` binding 时，会直接同步调用 `handleQueueMessage()`。本地开发很好，但生产环境若 Queue 配错，可能导致请求链路同步跑记忆抽取、摘要或 retention。

建议：

- 本地开发允许 fallback；
- 生产环境缺 Queue 时只记录错误，不同步执行重任务。

## P2：文档和维护性

### 8. README 与实际默认配置不一致

README 里说记忆筛选默认走 Workers AI，但 `wrangler.toml` 当前默认是：

```toml
MEMORY_FILTER_PROVIDER = "openai-compatible"
```

建议统一文档和默认值，避免部署者误判需要配置哪些 key。

### 9. Prompt Assembler 注释有过期内容

位置：

- `src/assembler/assemble.ts`
- `src/assembler/toOpenAI.ts`
- `src/assembler/toAnthropic.ts`

部分注释还写着“未接入 / later phase”，但主聊天链路已经在使用 assembler。建议清理过期注释，避免后续维护误解。

## 建议修改顺序

1. 先增加 `UPSTREAM_BASE_URL` / `UPSTREAM_API_KEY`，解除网关强绑定。
2. 修改 `/health`，支持普通上游模式。
3. 限制 URL token 只用于 MCP。
4. 收紧 cache namespace 和 admin password。
5. 处理图片 + Anthropic native 的一致性问题。
6. 最后清理 README 和过期注释。

## 备注

本 review 只基于静态阅读，没有运行 `npm run typecheck` 或部署验证。改完上游配置后，建议至少跑：

```bash
npm run typecheck
npm run dev
```

并用非流式、流式、记忆搜索、MCP、图片请求各测一遍。
