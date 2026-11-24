---
name: agent-readiness-audit
display_name: AI 抓取就绪审计
display_name_en: AI crawler readiness audit
description: 当用户问 AI 爬虫能不能读某个 URL、或要做 Agent Readiness 审计时使用。调用 run_agent_readiness_audit。
description_zh: 审计一个公开 URL 对 AI 爬虫是否就绪，并给出分数和优先修复项。
description_en: Audit one public URL for AI crawler access and return the score plus the first fixes.
examples_zh:
  - "审计 https://acmedraw.example 对 AI 爬虫是否就绪"
  - "这个页面的 robots.txt 会不会挡住 GPTBot"
  - "给官网做一次 Agent Readiness 审计"
examples_en:
  - "Audit https://acmedraw.example for AI crawlers"
  - "Does robots.txt block GPTBot on this page"
  - "Run an agent readiness audit for the official site"
version: 1.0.0
author: GeoCiteOps
---

# AI 抓取就绪审计

需要 GeoCiteOps 连接器。HTTP 上需要 `run-checks`。会抓取用户给出的 URL。不是付费模型调用。DEMO_MODE 下关闭。

1. 取用户消息里的公开 http(s) URL。没有就问。
2. 调用 `run_agent_readiness_audit`。
3. 若只有任务 id，调用 `get_agent_readiness_report`。
4. 先说分数和等级，再说影响最大的修复和验证方法。不要补充工具没返回的检查项。
5. 令牌失效时请用户重新连接，不要复述令牌。
