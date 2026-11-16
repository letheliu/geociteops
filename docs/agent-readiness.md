# Agent Readiness

An Agent Readiness audit answers one question: if an AI crawler or answer engine fetched this URL today, what would get in the way?

The console page is **Agent 就绪** (`/console/w/:workspaceId/agent-readiness`). The API is `agentReadiness.start`, `agentReadiness.get`, and `agentReadiness.list` on the workspace tRPC router, so the typed SDK exposes the same methods.

The audit runs as a pg-boss job (`agent-readiness-audit`). Results are stored on `AgentReadinessAudit` and can be reopened from the history list.

## What it checks

Each check is `pass`, `warn`, or `fail`, and carries a weight, an explanation, a concrete fix, and a "how to verify" note. The strings are stored in English and Simplified Chinese.

| Check | What “good” looks like |
| --- | --- |
| `robots.reachable` | `/robots.txt` is HTTP 200 and plain text. A missing file warns (crawlers default to allow). |
| `robots.answer-bots` | Answer crawlers are allowed: OAI-SearchBot, ChatGPT-User, Claude-User, Claude-SearchBot, PerplexityBot, Perplexity-User, Amazonbot. |
| `robots.search-bots` | Googlebot and Bingbot are allowed. Baiduspider, YisouSpider (神马), Sogou web spider, and 360Spider are reported too. Blocking only a Chinese engine warns; blocking Googlebot or Bingbot fails. |
| `llms.txt` | H1 title, a blockquote summary, and at least one H2 section of markdown links ([llmstxt.org](https://llmstxt.org)). A missing file warns: major answer engines have not confirmed they consume it. |
| `llms-full.txt` | Optional companion file. Missing warns and does not fail the audit. |
| `llms.links` | A sample of up to five links from `llms.txt` returns HTTP 2xx/3xx. |
| `sitemap` | Found via a `Sitemap:` directive or `/sitemap.xml` / `/sitemap_index.xml`, and it parses. A sitemap index also samples the first child. |
| `page.jsonld` | Raw HTML contains `application/ld+json`. Types are labeled with the existing schema registry (supported vs deprecated). |
| `page.meta-description` | Present, roughly 50–160 characters. |
| `page.canonical` | One `rel=canonical`. |
| `page.lang` | `<html lang>`. |
| `page.open-graph` | `og:title` and `og:description`. |
| `page.ssr-text` | Visible text in the raw HTML (scripts and styles removed). A short shell looks JavaScript-only. |
| `page.robots-directives` | No `noindex` in the meta robots tag or `X-Robots-Tag`. `nosnippet` warns. |
| `markdown` | `Accept: text/markdown` or a sibling `.md` URL returns markdown. Missing warns. |
| `access.http` | Browser fetch ends on HTTP 200, without a long redirect chain or a multi-second wait. |
| `access.bot-ua` | The same URL fetched as GPTBot and ClaudeBot does not come back 401/403/429/503 while the browser gets 200. |

Training crawlers (GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, CCBot, Bytespider, Meta-ExternalAgent) are listed on the bot table. Blocking them does **not** fail the score. Add a row to `src/modules/agent-readiness/bots.ts` to extend the catalog; the checks and the console table both read that file.

## Score

Applicable checks only. `pass` earns the full weight, `warn` earns half, `fail` earns nothing. The published score is that ratio as 0–100.

| Grade | Score |
| --- | --- |
| A | 90–100 |
| B | 75–89 |
| C | 60–74 |
| D | 40–59 |
| F | 0–39 |

`fixes` is the warn/fail checks, sorted by impact (`weight ×` how far the check is from a pass).

## Report shape

`report.version` is `1`. A later GEO health check should embed the object rather than copy fields:

```ts
interface GeoHealthCheck {
  agentReadiness: AgentReadinessReport | null
  // citation monitoring joins here in step 2
}
```

`AgentReadinessReport` lives in `src/modules/agent-readiness/types.ts`.

## Safety limits

- Only `http` and `https`, ports 80 and 443, no userinfo in the URL.
- Hostnames are resolved before connect. Loopback, private, link-local, CGNAT, and cloud-metadata addresses are rejected. The socket connects to the address that was checked.
- Each request times out (8s) and the whole audit has a 25s budget. Bodies are capped (HTML 1.5 MB, text files 512 KB).
- A target that resolves to a private address fails the audit. It is not given a low score.

## 简体中文

Agent 就绪审计回答一个问题：如果 AI 爬虫或回答引擎今天来抓这个 URL，会卡在哪里？

控制台入口是 **Agent 就绪**。接口是工作区 tRPC 的 `agentReadiness.start` / `get` / `list`，SDK 自动带上同名方法。任务走 pg-boss 队列 `agent-readiness-audit`，结果存在 `AgentReadinessAudit`，历史列表可以重新打开。

检查项、权重和上面的英文表是同一套。报告里的说明、修复和验证步骤同时有英文和简体中文。控制台目前没有独立的 i18n 框架，页面其它文案与控制台一样使用简体中文，展示报告时取 `zh` 字段。

训练爬虫被禁止不会拉低分数。要增加爬虫，只改 `src/modules/agent-readiness/bots.ts`。

评分只统计 `applicable` 的检查：通过拿满权重，警告拿一半，未通过拿 0，再归一化到 0–100。`fixes` 按影响度从高到低排列。

后续的「GEO 健康检查」应整包嵌入 `AgentReadinessReport`（`version: 1`），不要把字段拆开重做。
