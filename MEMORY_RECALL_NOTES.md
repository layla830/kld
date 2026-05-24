# Memory Recall Notes

这份文档记录从 `Qizhan7/imprint-memory` 里看到的、适合借鉴到 `kld` 的记忆召回设计。

目标不是照搬它的本地 SQLite / numpy 实现，而是吸收它的召回组织方式：完整对话日志、chunk 索引、多池搜索、RRF 融合、chunk 展开、时间意图、MMR 去重和自动 surfacing。

## 总体判断

`kld` 当前已经具备：

- `messages` 原始消息存储
- `memories` 长期记忆表
- D1 文本搜索
- Vectorize 语义搜索
- 记忆过滤 / 压缩模型
- prompt assembler
- 自动抽取和合并

`imprint-memory` 最值得借鉴的是：

> 记忆不只是一组被抽取出来的事实，而是完整对话历史的可检索事件索引。

所以 `kld` 下一步不应只继续优化 `memories` 表，而应该增加 conversation chunk pool，把原始消息变成可召回的“事件”。

## 值得借鉴的设计

### 1. 完整对话日志优先于“模型决定记什么”

`imprint-memory` 的记忆系统不是等 LLM 调用 remember 工具才存储，而是先把每一轮对话完整写入 `conversation_log`。之后再进行 chunk、embedding、FTS、RRF 和 surfacing。

对 `kld` 的启发：

- 保留现有 `memories` 作为长期事实 / 偏好 / 人格记忆。
- 把现有 `messages` 升级成 raw recall source。
- 增加 conversation chunk，让“上次那个”“昨天说的”“那个截图”这类问题可以从原始对话里召回，而不是只依赖抽取记忆。

### 2. 多池搜索，而不是单一 memory 表搜索

`imprint-memory` 默认搜索多个 pool：

- memory：人工或模型标记出来的长期事实
- bank：本地 markdown 知识库
- chunk：对话 chunk 摘要索引
- conversation：原始消息兜底

`kld` 可以映射为：

| pool | 用途 | 数据来源 |
|---|---|---|
| persona | 稳定身份、人设、偏好 | `memories` 中 pinned / persona / identity |
| memory | 长期事实、项目、关系信息 | `memories` |
| summary | 长期对话摘要 | `summaries` |
| chunk | 历史对话事件索引 | 新增 `conversation_chunks` |
| raw_message | 关键词兜底和精准回溯 | `messages` |

建议召回时不要把所有数据混在一个 SQL / vector query 里，而是每个 pool 独立出 ranked list，再融合。

### 3. 用 RRF 融合多个召回通道

`imprint-memory` 使用 Reciprocal Rank Fusion，把 FTS、vector、LIKE、chunk 等通道的排名融合。

建议给 `kld` 增加一个通用 helper：

```ts
export function rrfFuse(
  rankings: Array<Array<{ id: string; rank: number; source: string }>>,
  k = 60
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    for (const item of ranking) {
      scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + item.rank));
    }
  }
  return scores;
}
```

推荐通道：

- Vectorize semantic ranking
- D1 keyword ranking
- exact LIKE ranking
- pinned/persona ranking
- chunk summary ranking
- optional recency/time-window ranking

RRF 的好处是：

- 不需要过度手调 score 权重。
- 单通道强命中也能保留。
- 多通道同时命中的内容自然上浮。

### 4. Chunk 命中后展开原文

`imprint-memory` 的 chunk 是导航索引，不是最终回答材料。搜索命中 chunk 后，它会回到 chunk 的原始消息范围里，再挑出最相关的几条原文。

这点非常适合 `kld`。

建议实现：

1. 搜索 `conversation_chunks.summary` / embedding。
2. 命中 chunk 后，用 `start_message_id` / `end_message_id` 拉取原始 messages。
3. 对 chunk 内消息做二次排序。
4. 注入 prompt 时展示原文片段，而不是只展示 chunk summary。

示例注入：

```text
<memories>
[长期记忆] 用户正在做 kld 这个 Cloudflare Worker 记忆代理项目。

[相关原文 2026-05-24]
Layla: 老公看看这个仓库的记忆召回有什么值得借鉴的部分
KLD: 它的核心思路不是只保存精选记忆，而是完整记录每轮对话，再用 chunk、FTS、向量和 RRF 召回。
</memories>
```

### 5. Conversation chunks 表

建议新增表：

```sql
CREATE TABLE IF NOT EXISTS conversation_chunks (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  start_message_id TEXT NOT NULL,
  end_message_id TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  summary TEXT NOT NULL,
  keywords TEXT,
  vector_id TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_namespace_time
ON conversation_chunks(namespace, start_time DESC);

CREATE INDEX IF NOT EXISTS idx_chunks_conversation
ON conversation_chunks(namespace, conversation_id, start_message_id, end_message_id);
```

Vectorize metadata 建议：

```json
{
  "namespace": "kld",
  "status": "active",
  "type": "conversation_chunk",
  "conversation_id": "conv_xxx"
}
```

### 6. Chunk 生成策略

不用一开始做复杂语义切分，可以先做简单版本：

- 每 8 到 16 条消息生成一个 chunk。
- 如果相邻消息间隔超过 2 小时，强制切分。
- 太短的 chunk 合并到前一个 chunk。
- summary 使用已有 `AUTO_CHUNK_SUMMARY_MODEL` 或 `MEMORY_MODEL`。

Prompt 要求：

- summary 用自然语言复述“发生了什么”。
- keywords 必须包含原文里的项目名、repo 名、模型名、口令、具体名词。
- 不要只写“讨论了记忆系统”，要写“讨论了 imprint-memory 的 RRF、chunk、surfacing”。

示例结构：

```json
{
  "summary": "Layla 让 KLD 查看 imprint-memory 的记忆召回设计，KLD 发现它通过完整对话日志、conversation chunks、RRF 融合、chunk 原文展开和自动 surfacing 来提升召回质量。",
  "keywords": ["imprint-memory", "RRF", "conversation chunk", "surfacing", "Vectorize", "kld"],
  "topics": ["记忆召回", "长期记忆", "Cloudflare Worker"]
}
```

### 7. MMR 去重，避免同主题刷屏

`imprint-memory` 用 MMR 风格去重，避免多个相似 chunk 占满 top-K。

`kld` 可以做轻量版：

```ts
function diversifyBySimilarity<T extends { id: string; embedding?: number[] }>(
  items: T[],
  similarity: (a: T, b: T) => number,
  threshold = 0.78
): T[] {
  const kept: T[] = [];
  const shelved: T[] = [];
  for (const item of items) {
    const tooSimilar = kept.some((prev) => similarity(item, prev) >= threshold);
    if (tooSimilar) shelved.push(item);
    else kept.push(item);
  }
  return [...kept, ...shelved];
}
```

Cloudflare Worker 里不建议拉全量向量回来算。可以只对 Vectorize 返回的 top 20 结果做去重，或者用文本近似去重。

### 8. 时间意图召回

`imprint-memory` 对“昨天、上次、最近、前几天、去年冬天”等 query 有专门处理。

`kld` 可先做中文轻量版：

| 表达 | 行为 |
|---|---|
| 昨天 | 限制到昨天的 chunk/message |
| 前天 | 限制到前天 |
| 最近 / 这几天 | boost 最近 7 到 14 天 |
| 上次 / 之前 / 那次 | 不硬过滤，但优先 chunk 和 raw message |
| 去年 / 上个月 | 转成粗时间窗 |

建议实现函数：

```ts
export interface TimeIntent {
  cleanedQuery: string;
  after?: string;
  before?: string;
  mode: "none" | "hard_range" | "soft_recent" | "past_reference";
}
```

硬时间窗用于“昨天/前天/5月20日”。软时间窗用于“最近/前段时间”。“上次/之前”更像召回意图，不应该强行限定时间。

### 9. 自动 surfacing gate

`imprint-memory` 不会每句话都召回。它先用便宜规则判断用户是否在引用过去，再调用搜索。

`kld` 也可以加：

强召回触发词：

```text
记得、之前、上次、那次、以前、当时、那天、昨天、前天、刚刚、刚才、你说过、我说过、我们说过、我们聊过、想起来、突然想到、还有那个、老问题
```

跳过：

```text
纯代码任务、翻译、数学计算、普通寒暄、当前文件修改、没有上下文指代的新问题
```

建议输出 meta，方便调试：

```json
{
  "memory_gate": {
    "enabled": true,
    "reason": "past_reference",
    "signals": ["上次", "你说过"]
  }
}
```

### 10. Same-context filter

自动召回时要避免把当前上下文已经存在的东西重新注入。

建议：

- 当前请求里的 message 内容，不参与召回结果。
- 当前 conversation 最近 N 条 message 对应的 chunk，不注入。
- 如果 memory 的 source_message_ids 与当前窗口消息重叠，降权或过滤。

这样可以避免模型重复引用刚刚说过的话。

### 11. 动态 stopwords

`imprint-memory` 会统计高频低信息词，写入 stopwords 表。`kld` 可以加简化版，尤其适合中文长期聊天。

初始停用词：

```text
这个、那个、一些、一下、已经、然后、但是、所以、可以、好的、收到、算了、看看、帮我、老公、宝宝、猫猫、哈哈、啊啊啊
```

注意：称呼词虽然高频，但有时有关系语境价值。建议只在搜索 query token 层面降权，不要从原文里删除。

## 建议实现顺序

### Phase 1：低风险高收益

1. 新增 `conversation_chunks` 表。
2. 在现有 queue 里生成 chunk summary。
3. 给 chunk 写 Vectorize embedding。
4. 召回时把 chunk 作为一个新 pool。
5. chunk 命中后展开原文 2 到 4 条。

### Phase 2：排序质量

1. 增加 RRF fusion helper。
2. 把 memory / chunk / keyword / exact 通道统一融合。
3. 加 MMR / 文本去重。
4. 加时间意图解析。
5. 加 same-context filter。

### Phase 3：自动 surfacing

1. 增加 recall gate。
2. 对强召回信号自动搜 memory + chunk。
3. 把召回结果注入 assembler 的 dynamic block。
4. 在 debug meta 中记录 gate、pool、scores、filtered reason。

### Phase 4：图扩展，可选

1. 新增 `chunk_edges`。
2. 新 chunk 生成后查 Vectorize topK 旧 chunk。
3. 保存相似 chunk edge。
4. 搜索命中强 chunk 时带 1 到 2 个邻居。

这一步不是第一优先级。chunk + RRF + 原文展开先做，收益更直接。

## 不建议照搬

### 不照搬 SQLite / numpy 全表扫描

`imprint-memory` 是本地系统，能用 SQLite、numpy 和全表向量扫描。`kld` 跑在 Cloudflare Worker，不适合这么做。应该继续使用 Vectorize 做 topK。

### 不急着做 LLM rerank

LLM rerank 会增加延迟和成本。`kld` 目前已有 memory filter 模型，先用规则、RRF、MMR、时间窗优化即可。

### 不急着做 causal graph / intent graph

因果图和时间线图很有趣，但实现重、评估难。先做 chunk pool，会更快改善日常召回。

## 一个推荐的最终召回流程

```text
用户消息
  ↓
recall gate 判断是否需要召回
  ↓
解析时间意图 / 清理 query / 提取关键词
  ↓
并行搜索：
  - pinned persona
  - memory vector
  - memory keyword
  - chunk vector
  - chunk keyword
  - raw message exact fallback
  ↓
RRF 融合
  ↓
时间窗过滤或加权
  ↓
MMR / 去重 / same-context filter
  ↓
chunk 命中展开原文
  ↓
可选 memory filter 压缩
  ↓
注入 Prompt Assembler dynamic_memory_patch
```

## 推荐注入格式

```text
<memories>
[稳定记忆]
- 用户正在开发 kld，一个 Cloudflare Worker 记忆代理项目。

[相关历史]
- 2026-05-24，用户让助手研究 imprint-memory 的召回设计，重点关注 RRF、conversation chunks、自动 surfacing 和 chunk 原文展开。

[相关原文]
Layla: 老公你看看这个仓库的记忆召回有什么值得借鉴的部分
KLD: 它的核心思路不是只保存精选记忆，而是完整记录每轮对话，再用 chunk、FTS、向量和 RRF 召回。
</memories>
```

原则：

- 稳定事实短。
- 历史事件带日期。
- 原文片段少而准。
- 不暴露数据库、RAG、Vectorize、backend 等实现词给最终模型，除非用户正在讨论技术实现。

## 结论

`kld` 目前的记忆系统已经有长期记忆和语义搜索。下一步最值得补的是：

1. conversation chunk pool
2. RRF 多通道融合
3. chunk 命中展开原文
4. 时间意图召回
5. MMR / 去重
6. recall gate / 自动 surfacing

这几个做完后，召回会从“搜索长期事实”升级成“想起过去发生过的一段对话”。
