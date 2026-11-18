# GEO 体检

一次体检回答一个问题：这个品牌现在被 AI 回答引擎引用的机会有多大，先改哪几件事？

控制台入口是 **GEO 体检**（`/console/w/:workspaceId/geo-health`）。新工作区的概览在还没有查询、也没有采样时会提示先做体检。接口是工作区 tRPC 的 `geoHealth.start` / `get` / `list` / `trend`，另外有 `saveQueries`（把这次的问题写入查询库）、`export`（Markdown、JSON 或 PDF），以及 `schedules` / `saveSchedule` / `setScheduleEnabled` / `removeSchedule`。SDK 自动带上同名方法。打开页面时会展开最近一份已经完成的报告。

任务走三条 pg-boss 队列：`geo-health-dispatch`（拆开支柱）、`geo-health-pillar`（跑其中一根）、`geo-health-finalize`（汇成一份报告）。另外有一条每分钟的 `geo-health-schedule`，只负责到点的定时复跑。每根支柱的状态写在 `progress` 里，控制台按这个显示进度。某一根失败或跳过，其它的照常收尾，整份检查记为 `PARTIAL`，不会因为一步出错就丢掉已经跑完的结果。

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

类型在 `src/modules/geo-health/types.ts`。导出 Markdown 用中文，JSON 是这份对象本身。

PDF 用 pdfkit 在进程里画，不装 Chromium。中文来自随仓库分发的 Noto Sans SC Regular（`assets/fonts/NotoSansSC-Regular.otf`，约 8 MB，OFL，见同目录的 `SOURCE.txt`）。pdfkit 只把这份报告用到的字形嵌进文件，单份 PDF 通常远小于 1 MB。运行镜像多这一份字体和 pdfkit，不装系统 CJK 包。缺字体时可以设 `GEO_CJK_FONT` 指向另一个 TTF/OTF。`export` 的 PDF 以 base64 放在 `content` 里，`encoding` 是 `base64`；Markdown 和 JSON 的 `encoding` 是 `utf8`。

封面有品牌、站点、日期、总分和字母档。后面是四根支柱、本品对竞品的声量条、Agent 就绪摘要、行动表（影响、工作量、做法、如何验证），以及问题和跳过引擎的附录。

## 定时复跑

一个工作区里，同一个品牌加同一个站点只有一份计划。节奏是每天 04:00、每周一 04:00、每月 1 日 04:00，或一段 5 字段 cron。时区和监测一样，是 Asia/Shanghai。两次触发至少间隔 1 小时，所以 `* * * * *` 会被拒绝。

pg-boss 上有一条每分钟的 `geo-health-schedule`。它只看 `nextRunAt` 已经到了、而且启用着的计划。计划上如果还有一次 `QUEUED` 或 `RUNNING` 的体检，这次就跳过，不并行开第二份。任务体只有 check id。引擎凭证在支柱里按这条体检的 `workspaceId` 现查，暂停的工作区不会被拉起来跑。

每次跑完都是历史里的一份新报告，`trigger` 为 `SCHEDULED`。和上一次同一品牌、同一站点的已完成报告比，`get` 会带上 `diff`：总分增减、每根支柱的增减、新出现的行动、上次有而这次没有的行动、影响变高的行动，以及分数下降的支柱。

## 趋势

体检收尾时，只要引用快照里有样本，就写一条 `CitationRun`，`trigger` 是 `HEALTH_CHECK`，`slotKey` 是 `health:<checkId>`。已有的问题按原文复用；库里没有的问题记成 `PAUSED`、`scheduled = false`、来源 `HEALTH_CHECK`，定时监测不会去跑它们。失败样本不进趋势指标。监测趋势图上这些点是蓝菱形，提示里写明来自 GEO 体检。引用报告的来源列显示「体检」。

体检页和概览上另有一条 GEO 分数趋势：总分加四根支柱，一个点是一次完成的体检。概览在还没有完成的体检时不显示这张图。

## 安全边界

官网沿用 Agent 就绪的地址检查：只有 http/https，拒绝内网、本机和云元数据地址。抓页面和站点地图走同一套 `safeFetch`。引擎凭证不写进报告；失败原因会抹掉看起来像密钥的片段。

## English

A GEO health check is the onboarding run: brand name, official URL, and optionally industry, competitors, and a few questions. One click produces a single report.

The console page is **GEO 体检**. New workspaces see it on the dashboard empty state. The workspace API is `geoHealth.start`, `get`, `list`, `trend`, `saveQueries`, `export`, `schedules`, `saveSchedule`, `setScheduleEnabled`, and `removeSchedule`. The typed SDK picks those up. Opening the page shows the newest finished report.

pg-boss queues are `geo-health-dispatch`, `geo-health-pillar`, `geo-health-finalize`, and a minute tick `geo-health-schedule`. Pillar progress is stored so the UI can poll. One pillar failing or being skipped does not fail the others; the check is then `PARTIAL`.

Empty questions are filled by the existing LLM (5–8 brand, category / "best X", and comparison questions). A response that is not usable JSON falls back to built-in templates. Language is `zh`, `en`, or `auto` (CJK in the brand or industry, or a `.cn` / `.tw` / `.hk` / `.com.cn` host).

Weights: agent readiness 30%, citation snapshot 35%, citability 20%, structured signals 15%. Pillars with no score are dropped and the rest are scaled to 100%. Letter grades match Agent Readiness. The readiness pillar embeds `AgentReadinessReport` version 1 rather than copying fields. Unconfigured engines are skipped and named. Schema.org and llms.txt status come from that embedded audit. The llms.txt and JSON-LD downloads are produced by the existing generators and do not add points.

`saveQueries` writes the run's questions into the Query Library. `export` returns Markdown, JSON, or PDF. PDF `content` is base64 (`encoding: 'base64'`). Markdown and JSON stay utf-8. The PDF is drawn with pdfkit and the bundled Noto Sans SC Regular face (`assets/fonts/`, about 8 MB, OFL). pdfkit subsets the glyphs, so a report is far smaller than the font file. The image does not add Chromium or a system CJK package. Set `GEO_CJK_FONT` to point at another TTF/OTF. The cover has the brand, site, date, score, and grade. Later pages have pillar bars, share of voice against competitors, the readiness summary, the action table, and an appendix of questions and skipped engines.

A workspace has one schedule per brand and site: daily, weekly, or monthly at 04:00 Asia/Shanghai, or a 5-field cron. Runs must be at least an hour apart. A `geo-health-schedule` tick each minute starts due, enabled schedules. A schedule that still has a `QUEUED` or `RUNNING` check does not start a second one. The job payload is only the check id. Engine credentials are resolved for that check's workspace. A suspended workspace is skipped. Each run is a new report with `trigger: SCHEDULED`. `get` includes a `diff` against the previous finished report for the same brand and site: score and pillar deltas, new actions, actions that disappeared, actions whose impact went up, and pillars whose score fell.

When the citation pillar has samples, finalize writes a `CitationRun` with `trigger: HEALTH_CHECK` and slot key `health:<checkId>`. Existing questions are reused by text. New questions are stored `PAUSED`, `scheduled: false`, source `HEALTH_CHECK`, so the citation cron does not run them. The share-of-voice chart marks these points with a blue diamond and says they came from a health check. The health page and the dashboard also chart the GEO score (overall and the four pillars) across finished checks.
