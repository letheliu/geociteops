---
name: geo-health-check
display_name: GEO 健康检查
display_name_en: GEO health check
description: 当用户要 GEO 分数、健康检查或「给这个品牌做一次体检」时使用。调用 GeoCiteOps 的 run_geo_health_check。
description_zh: 给品牌官网做一次 GEO 健康检查，返回分数、支柱和优先修复项。
description_en: Run one GEO health check and return the score, pillars, and the fixes to do first.
examples_zh:
  - "给 acmedraw.example 做一次 GEO 健康检查"
  - "Acme Draw 的 GEO 分数是多少"
  - "看看这个官网的引用健康度"
examples_en:
  - "Run a GEO health check for acmedraw.example"
  - "What is the GEO score for Acme Draw"
  - "Check citation health for this official site"
version: 1.0.0
author: GeoCiteOps
---

# GEO 健康检查

需要已连接的 GeoCiteOps 连接器，以及带 `run-checks` 范围的工作区令牌。DEMO_MODE 下此技能不能启动检查。

当用户要做 GEO 健康检查时：

1. 向用户确认品牌名和官网 URL。示例品牌是 Acme Draw，站点是 https://acmedraw.example。
2. 调用 MCP 工具 `run_geo_health_check`。只传入用户提供的行业、竞品和问题。
3. 若结果还在跑，保留任务 id，调用 `get_geo_health_report`。不要再开一份。
4. 先说分数和等级，再说支柱分和影响最大的修复。只用工具返回的数字。跳过的引擎不是 0 分。
5. 令牌失效时，请用户在连接器里重新连接。不要把令牌写进对话或日志。

此工具会写入工作区，并可能调用付费模型。`read` 令牌不够。
