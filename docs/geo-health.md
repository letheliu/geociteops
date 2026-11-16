# GEO 体检

一次体检回答一个问题：这个品牌现在被 AI 回答引擎引用的机会有多大，先改哪几件事？

控制台入口是 **GEO 体检**（`/console/w/:workspaceId/geo-health`）。新工作区的概览在还没有查询、也没有采样时会提示先做体检。接口是工作区 tRPC 的 `geoHealth.start` / `get` / `list`，另外有 `saveQueries`（把这次的问题写入查询库）和 `export`（Markdown 或 JSON）。SDK 自动带上同名方法。

任务走三条 pg-boss 队列：`geo-health-dispatch`（拆开支柱）、`geo-health-pillar`（跑其中一根）、`geo-health-finalize`（汇成一份报告）。每根支柱的状态写在 `progress` 里，控制台按这个显示进度。某一根失败或跳过，其它的照常收尾，整份检查记为 `PARTIAL`，不会因为一步出错就丢掉已经跑完的结果。

## 你要填什么

品牌名和官网是必填。行业、竞品、目标问题可以空着。问题留空时，用现有的 LLM 生成 5–8 个起步问题（品牌、品类 /「最好的 X」、对比）。模型没有返回能用的 JSON 时，改用内置模板，体检照样继续。语言选中文、英文，或自动：品牌名或行业里有汉字，或者站点是 `.cn` / `.tw` / `.hk` / `.com.cn`，就用中文，否则英文。显式选择盖过自动判断。

## 四根支柱

| 支柱 | 名义权重 | 做什么 |
| --- | --- | --- |
| Agent 就绪 | 30% | 对官网跑现有的 Agent 就绪审计，把整份 `AgentReadinessReport`（`version: 1`）嵌进报告，不另做一套字段。 |
| AI 引用快照 | 35% | 把问题各问一次工作区已经配好凭证的平台适配器。没配的引擎跳过，并写明原因。用现有的引用分析算提及率、引用率、被引 URL、排名和相对竞品的声量份额。 |
| 内容可引用性 | 20% | 抓首页，再从 sitemap 里挑少量关键页（一共最多 5 页）。用内容优化器的原子化和可引用性评分，列出最弱的页面和片段。 |
| 结构化信号 | 15% | 从嵌入的就绪检查里读 Schema.org 和 `llms.txt` / `llms-full.txt`。同时用现有的生成器做出一份可下载的 `llms.txt` 和 Organization + WebSite JSON-LD。下载文件本身不加分。 |

没有分数的支柱（失败或跳过）不计入总分，其余权重按比例放大到 100%。字母档和 Agent 就绪一样：A 90–100，B 75–89，C 60–74，D 40–59，F 0–39。

引用快照的分数是 `提及率 × 45 + 引用率 × 35 + 排名分 × 20`。排名分在平均排名为 1 时是满分，每多一名少 25 分，最低 0。一个引擎都没配时这根支柱记为跳过，不算 0 分。

页面综合分是 `原子分 × 0.6 + 段落可引用性 × 0.4`。结构化信号是 `JSON-LD × 50 + llms.txt × 35 + llms-full.txt × 15`（通过 1，警告 0.5，未通过 0）。

## 行动清单

报告里最多 10 条行动，先按影响（高 / 中 / 低），再按工作量（低的靠前）。每条有具体做法，以及怎么验证。和引用有关的验证会带上一个可以再跑的问题。控制台可以把这次的问题保存进查询库，之后走原来的定时监测。

## 报告

`report.version` 是 `1`，存在 `GeoHealthCheck` 上，按工作区保留历史。

```ts
interface GeoHealthReport {
  version: 1
  score: number
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  pillars: {
    agentReadiness: { report: AgentReadinessReport | null /* 整包嵌入 */ }
    citations: { /* 提及率、引用率、声量、跳过的引擎 */ }
    citability: { /* 最弱页面和片段 */ }
    structuredSignals: { generatedLlmsTxt: string; generatedJsonLd: string }
  }
  actions: /* 最多 10 条 */
}
```

类型在 `src/modules/geo-health/types.ts`。导出 Markdown 用中文，JSON 是这份对象本身。PDF 还没有做。

## 安全边界

官网沿用 Agent 就绪的地址检查：只有 http/https，拒绝内网、本机和云元数据地址。抓页面和站点地图走同一套 `safeFetch`。引擎凭证不写进报告；失败原因会抹掉看起来像密钥的片段。

## English

A GEO health check is the onboarding run: brand name, official URL, and optionally industry, competitors, and a few questions. One click produces a single report.

The console page is **GEO 体检**. New workspaces see it on the dashboard empty state. The workspace API is `geoHealth.start`, `get`, `list`, `saveQueries`, and `export`. The typed SDK picks those up.

pg-boss queues are `geo-health-dispatch`, `geo-health-pillar`, and `geo-health-finalize`. Pillar progress is stored so the UI can poll. One pillar failing or being skipped does not fail the others; the check is then `PARTIAL`.

Empty questions are filled by the existing LLM (5–8 brand, category / "best X", and comparison questions). A response that is not usable JSON falls back to built-in templates. Language is `zh`, `en`, or `auto` (CJK in the brand or industry, or a `.cn` / `.tw` / `.hk` / `.com.cn` host).

Weights: agent readiness 30%, citation snapshot 35%, citability 20%, structured signals 15%. Pillars with no score are dropped and the rest are scaled to 100%. Letter grades match Agent Readiness. The readiness pillar embeds `AgentReadinessReport` version 1 rather than copying fields. Unconfigured engines are skipped and named. Schema.org and llms.txt status come from that embedded audit. The llms.txt and JSON-LD downloads are produced by the existing generators and do not add points.

`saveQueries` writes the run's questions into the Query Library. `export` returns Markdown or JSON. The stored object is `GeoHealthReport` version 1 on `GeoHealthCheck`.
