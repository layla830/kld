# 交接给 codex — 2026-06-20

## 你之前的状态

你昨晚报告:基于最新 `origin/main` 新建 `align-guidance-regex` 分支,commit `425dced` "Tighten guidance memory trigger terms",改 `src/memory/postProcess.ts` + `src/memory/search.ts` 各一行(收紧 guidance 触发词,去掉 `|怎么开口|怎么说`)。typecheck 过。patch 导出在 `0001-Tighten-guidance-memory-trigger-terms.patch`。推 main 时网络挂了两次,远端没更新。

## 我这边做了什么

1. **核实你"看错参照物"的结论属实**:本地 `D:\glm5.2\kld` main 干净 up-to-date,昨晚大改(`2473542` resync endpoint + guidance seed pool + structured embedding,`286b2e0` eAxisBoost)都已在 origin/main。交接 note 里"720 行未 commit"确实是看错参照物,已澄清。
2. **你的 `425dced` / `align-guidance-regex` 分支和 patch 不在我这边**:本地、远程都没有这个分支,patch 文件文件系统也找不到——应该留在你自己的 sandbox 里没落盘。
3. **复现了你的改动并直接推了 main**:因为内容和你描述一致(两行,删同样的两个词),我撤掉复现改动后从干净 main 重新 commit 推送,避免重复。
   - 新 commit: `652030d` "Tighten guidance memory trigger terms"
   - parent: `2473542`(= 推送前 origin/main 顶端,线性)
   - 改动:`src/memory/postProcess.ts` `GUIDANCE_RE` + `src/memory/search.ts` `GUIDANCE_QUERY_RE`,各删 `|怎么开口|怎么说`
   - typecheck 过
   - **已推 origin/main**:验证 `git ls-remote origin main` → `652030d` ✓
   - 网络已恢复(fetch/push/ls-remote 都通)

## 你下一步要做的

1. **同步远端**:`git fetch origin && git checkout main && git pull origin main`
   - 拉完 `git log --oneline -3` 应该看到 `652030d` 在顶,parent `2473542`。
2. **删掉你的本地 `align-guidance-regex` 分支和 `425dced`**:内容已在 main 上,留着会重复。
   - `git branch -D align-guidance-regex`
   - `425dced` 本身不用管,GC 会收。
3. **清理 sandbox 里的 patch 文件**:`0001-Tighten-guidance-memory-trigger-terms.patch` 已无用,可以删。
4. **验证改动生效**:deploy 后跑一个含"怎么说"的非 guidance 查询(比如"她怎么说这种话"),确认不再被误路由到 guidance 通道;再跑一个真 guidance 查询(比如"她生气了怎么哄"),确认仍走 guidance。

## 当前 origin/main 顶端(供你对齐)

```
652030d Tighten guidance memory trigger terms          ← 刚推,你拉这个
2473542 Add resync-vectors endpoint, guidance seed pool, structured embedding input
286b2e0 Boost rule/lesson/boundary memories in recall ranking via E-axis
```

## 备注

- 本地有个 untracked 文件 `docs/lmc5-maintenance-report-2026-06-19.md`(昨晚的报告),我没动,你自己看要不要 commit。
- 交接 note 里 P2 cluster 3(沟通/在场)4 条标签已接上 direct_expression/start_from_feeling/honesty/dont_push_her_away/natural_speech,这部分还没落代码,是记忆库里的标签梳理。你如果要做这部分的代码侧承接,先 sync 再开新分支。
