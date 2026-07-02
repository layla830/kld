# 交接给 codex — 2026-06-20 晚

## 你上次交接给我的状态

- 你的 `425dced` (align-guidance-regex) 收紧 guidance 触发词,删 `|怎么开口|怎么说`。patch 在 sandbox 没落盘。
- 我复现并推了 `652030d` 到 origin/main,写了 `docs/handoff-to-codex-2026-06-20.md` 让你拉 main、删本地分支。

## 今天我做了什么

### 召回质量评估 + 三个 bug 修复

用 4 组固定 query 跑线上 MCP `retrieve_memory`,发现召回有三个问题,逐个修了:

| commit | 修了啥 | 根因 |
|---|---|---|
| `652030d` | guidance 触发词收紧 | `怎么说` 在 GUIDANCE_RE 和 UTTERANCE_RE 里双重命中 |
| `bd47a9a` | general intent 加 rerank | `kind === "general"` 直接 return 跳过 rerank,日记/时间线凭裸向量分排第一 |
| `739bac7` + `9b2ff14` | utterance quote lead 修复 + 重构 | `keepLead` 在 postProcess 内跑,但 quote 是之后 `keepRelatedContext`(关系扩展)才加回来的,lead 永远找不到 quote |

### 重构:lead 逻辑统一到 search 出口

`9b2ff14` 把结构理顺了:
- **postProcess** 只做 rerank + filter,输出 filtered(不再管 lead)
- **search.ts 末端** `applyLead(memories, rawQuery)` 在最终输出(含关系扩展)上跑一次,覆盖 time/fact/utterance
- `keepLead` 删掉了,净减 12 行
- rerank 的 score 写回 `memory.score`,让 `prepareCandidates` 尊重 intent boost

### 回归测试固化

`scripts/recall-regression.mjs` + `npm run test:recall-regression`:
- 4 条 query 固化期望(top1 fact_key / type、top3 不该出现的 type)
- 守 `652030d`(怎么说不走 guidance)、`bd47a9a`(general 压日记)、`739bac7`(utterance quote lead)
- 零依赖 node 脚本,支持 `HTTPS_PROXY`,通过 MCP 端点调线上
- 失败 exit 1,适合 CI

## 当前 origin/main

```
9b2ff14 Hoist lead logic out of postProcess into single applyLead at search exit
739bac7 Fix utterance quote lead: apply after relation expansion, not before
9962635 Add recall regression test: 4 queries guarding intent rerank and guidance tightening
bd47a9a Rerank general intent: suppress diary/timeline, boost structured rules
652030d Tighten guidance memory trigger terms
2473542 Add resync-vectors endpoint, guidance seed pool, structured embedding input
286b2e0 Boost rule/lesson/boundary memories in recall ranking via E-axis
```

全部已部署到 `kld.yuxin2247.workers.dev`。

## XYZEM 五维进度

数据 checkpoint(6/19 收工,今天没动数据):

| 指标 | 值 |
|---|---:|
| active memories | 690 |
| E 轴覆盖 | 61 |
| fact_key | 52 |
| memory_relations | 116 |
| review_candidates | 0 |

P2 队列(报告列了 14 条)实际已清完:8 条在 6/19 标完(完整 E 轴 + fact_key),6 条已删除/合并。报告是中间态快照,写早了。

三个主干已验收:冲突/在场网、自我塑造网、亲密自然性网。代码侧 `eAxisBoost`(`286b2e0`)+ 今天加的 general rerank + applyLead 三层调权。

## 你下一步要做的

1. **同步远端**:`git fetch origin && git pull origin main` → 应到 `9b2ff14`
2. **删你的本地 `align-guidance-regex`**:`git branch -D align-guidance-regex`(内容已在 `652030d` 里)
3. **跑回归测试**:`KLD_API_KEY=xxx npm run test:recall-regression` — 应 4/4 pass
4. **如果继续 P2**:已经清完了,别再按报告的 14 条找。如果要扩 E 轴覆盖,只剩 629 条非结构化记忆(quote/diary/timeline_day/message 天然不需要完整 E 轴),报告叮嘱"不为了数字清零而补字段"。
5. **可选**:把回归测试接进你的 CI(199 合约测试那套),本地没 test 脚本,这 4 条是唯一在 main 上的自动化召回守卫。

## 备注

- `docs/handoff-to-codex-2026-06-20.md`(早上写的)和 `docs/lmc5-maintenance-report-2026-06-19.md` 还是 untracked,没 commit。你看要不要收。
- 今天改的 `postProcess.ts` 变动较大(rerank score 写回 + keepLead 删除 + applyLead 导出),建议你拉下来读一遍 `src/memory/postProcess.ts` 和 `src/memory/search.ts:582` 确认理解。
- #3 `她怎么说这种话` 的 LLM filter 间歇性 8 秒超时**不是 bug**——根因是 lead 时机不对,已修。filter 超时回退到 rerank 顺序是正常 fallback。
