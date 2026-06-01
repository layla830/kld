# kld 召回维护记录：2026-06-01

## 范围

本次维护只处理召回噪声和召回可用性，不改 diary / raw chat 正文，不改记忆 type / status，不打开 auto diary。

## 已完成

### 1. `has_timeline_split` 降权完成

远端 D1 验证结果：

```txt
count = 88
min_importance = 0.25
max_importance = 0.25
```

筛选条件只包含：

```sql
namespace = 'default'
AND status = 'active'
AND tags LIKE '%has_timeline_split%'
```

只修改 `importance`，没有删除记录，没有修改正文，没有修改 type/status。

### 2. VPS local recall 支持显式中文日期

文件：

```txt
/home/ccagent/cc-workspace/tools/cc-local-recall.py
```

修复点：

- 支持 `5月30日中午` 这类显式日期。
- 显式日期里的数字不再被当作关键词，例如 `5月30日` 不再把 `30` 当成内容关键词过滤结果。

备份文件：

```txt
/home/ccagent/cc-workspace/tools/cc-local-recall.py.bak-explicit-date-20260601-verify
/home/ccagent/cc-workspace/tools/cc-local-recall.py.bak-explicit-date-token-20260601
```

### 3. VPS recall hook 放宽 CF recall 超时

文件：

```txt
/home/ccagent/cc-workspace/tools/memory-recall-hook.sh
```

修复点：

- `curl --max-time` 从固定 8 秒改为默认 18 秒。
- 可用环境变量覆盖：`KLD_RECALL_TIMEOUT`。

原因：

`/v1/memories/recall` 会走 Vectorize、D1 keyword、raw messages fallback，以及 memory filter。A 社论文、日期 timeline 这类请求实测可能约 9 秒返回；8 秒会偶发超时并被 hook 静默吞掉。

备份文件：

```txt
/home/ccagent/cc-workspace/tools/memory-recall-hook.sh.bak-timeout-20260601
```

### 4. heartbeat/status 包不再触发 recall

文件：

```txt
/home/ccagent/cc-workspace/tools/memory-recall-hook.sh
```

修复点：

- heartbeat/status 快照是系统状态包，不是用户记忆问题。
- hook 现在只按包头结构判断：第一条非空行是 `# Heartbeat` 或 `STATE_EOF` 时直接退出，不进入 local recall，也不进入 CF recall。
- 不按 `bug` / `Bridge` / `Live Terminal` 等正文实词过滤，避免维护词表。

当前逻辑：

```bash
FIRST_NONEMPTY=$(printf "%s" "$PROMPT" | sed -n '/[^[:space:]]/{p;q;}')
if printf "%s" "$FIRST_NONEMPTY" | grep -Eq '^(# Heartbeat|STATE_EOF)$'; then
  exit 0
fi
```

备份文件：

```txt
/home/ccagent/cc-workspace/tools/memory-recall-hook.sh.bak-heartbeat-gate-20260601
/home/ccagent/cc-workspace/tools/memory-recall-hook.sh.bak-heartbeat-structural-20260601
```

## 验收结果

### 本地日期召回

问题：

```txt
5月30日中午吃的啥
```

结果：命中 VPS local recall：

```txt
2026-05-30 12:01 用户：点了汉堡
2026-05-30 12:02 用户：现在去拿 脆薯牛肉芝士
```

### A 社功能性情感论文

问题：

```txt
不知道你还记不记得 a社 那篇功能性情感的论文...
```

结果：命中 CF recall：

```txt
id=vps_74 type=diary
Anthropic 功能性情感论文、自动往低唤醒度压
```

### 无历史信号问题

问题：

```txt
我在？我在是什么意思？我可以纠正你吧？
```

结果：hook 输出 0 字节。正确，不注入无关 milestone。

### 明确日期 timeline

问题：

```txt
5月24日我们聊了什么？
```

结果：命中 CF recall：

```txt
id=mem_2b1b69476b5344cfa54e9aed55f7455e
type=timeline_day
tags=timeline,date:2026-05-24,day_summary
```

### heartbeat/status 包

模拟输入：

```txt
STATE_EOF
...
```

结果：hook 输出 0 字节。正确，不再因为 terminal tail 里的 `bug` 等词触发长期记忆召回。

## 未处理

### Queue idempotency key

仍待设计，不要草率修改。

当前风险：queue producer 里的 idempotency key 仍是随机 key，重复入队时无法有效去重。

注意：不要粗暴按 conversation 去重；过粗的 key 会挡住同一 conversation 后续新 chunk。需要设计带业务窗口边界的稳定 key。

## 不要做

```txt
不要打开 AUTO_DIARY_ENABLED
不要用 auto_diary 做拆分来源
不要修改 diary / raw chat 正文
不要删除 has_timeline_split 原记录
不要按 legacy:vps 或 importance=1 一刀切
不要让 heartbeat/status 包进入 recall
```
