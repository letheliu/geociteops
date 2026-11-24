---
name: geo-health
description: Run one GEO health check for a brand and its official URL, then explain the score and the top fixes.
version: 1.0.0
author: GeoCiteOps
---

# GEO 健康检查

用户要一份 GEO 健康报告时使用。品牌名和官网 URL 缺一不可。行业、竞品和问题只有用户提供了才传入。

## 可用工具

### run_geo_health_check - 启动体检

写入工作区任务，并可能调用付费模型。需要令牌范围 `run-checks`。DEMO_MODE 下不可用。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| brandName | string | 是 | 品牌名，例如 Acme Draw |
| siteUrl | string | 是 | 官网 http(s) URL |
| industry | string | - | 行业 |
| competitors | string[] | - | 竞品名，最多 8 个 |
| queries | string[] | - | 要抽样的问题，最多 10 个 |
| language | string | - | zh、en 或 auto |
| waitMs | number | - | 轮询毫秒数，默认 45000，0 表示立刻返回任务 id |

### get_geo_health_report - 读取报告

只读。需要令牌范围 `read`。`run-checks` 已包含读取。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | string | 是 | 任务 id |
| format | string | - | markdown 或 json，导出已存报告 |

## 步骤

1. 调用 `run_geo_health_check`。
2. 若结果仍在跑，保留任务 id，再调用 `get_geo_health_report`。不要再开一份。
3. 先说分数和等级，再说四项支柱和影响最大的修复。只用工具返回的数字和引擎名。跳过的引擎不是 0 分。

## 认证与错误

- 未连接或令牌失效时，工具会失败。请用户在连接器里重新填写令牌，不要把令牌写进对话。
- `read` 令牌调用本检查会得到范围不足。请换一张带 `run-checks` 的令牌。
- DEMO_MODE 只读，不能启动体检。
