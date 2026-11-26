---
name: geo-audit
description: Audit one public URL for AI crawler readiness and report the score plus the highest-impact fixes.
version: 1.0.0
author: GeoCiteOps
---

# AI 抓取就绪审计

用户问某个 URL 能不能被 AI 爬虫读取时使用。

## 可用工具

### run_agent_readiness_audit - 审计 URL

会抓取该站点。带 API 令牌时写入一条审计任务。不是付费模型调用。HTTP 上需要 `run-checks`。DEMO_MODE 下不可用。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| url | string | 是 | 公开的 http(s) URL |
| waitMs | number | - | 远程模式的轮询毫秒数 |

### get_agent_readiness_report - 读取已存审计

只读。本地审计不会入库。需要 `read`。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | string | 是 | 审计 id |

## 步骤

1. 调用 `run_agent_readiness_audit`。
2. 若只有任务 id、没有分数，再调用 `get_agent_readiness_report`。
3. 先说分数和等级，再说影响最大的修复和每条怎么验证。不要补充工具没返回的爬虫或结论。
