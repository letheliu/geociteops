---
name: geo-llms-schema
description: Generate or validate llms.txt, and generate Schema.org JSON-LD. A read token does not store the file.
version: 1.0.0
author: GeoCiteOps
---

# llms.txt 与 JSON-LD

用户要 llms.txt 或结构化数据时使用。不要编造评分、价格或用户没给的链接。

## 可用工具

### generate_llms_txt - 生成或校验 llms.txt

不是付费模型调用。`read` 令牌只在本地生成，不入库。入库需要 `run-checks`。传入 `url` 会抓取该地址，DEMO_MODE 下不允许。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| brandName | string | 生成时 | 品牌名 |
| tagline | string | 生成时 | 一句话介绍 |
| sections | array | 生成时 | `{ title, items: [{ label, url, description }] }` |
| text | string | 校验时 | 已有的 llms.txt 正文 |
| url | string | 校验时 | 站点或 llms.txt 地址 |
| pageUrl | string | - | 入库时的页面 URL |

### generate_schema - 生成 JSON-LD

不是付费模型调用。校验 Schema.org 文档。`read` 不入库。Organization、SoftwareApplication、Product、FAQPage、Article、BreadcrumbList 在有 `pageUrl` 且令牌含 `run-checks` 时才会保存。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| schemaType | string | 是 | Schema.org 类型 |
| fields | object | 是 | 该类型的字段 |
| pageUrl | string | 入库时 | 页面 URL |

## 步骤

1. 生成 llms.txt 时向用户要品牌、一句话介绍和链接列表，然后调用 `generate_llms_txt`。
2. 校验线上文件时把 `url` 设为站点或 `/llms.txt`。
3. 生成 JSON-LD 时先确认类型，再调用 `generate_schema`。缺字段时按工具报错补，不要猜。
4. 说明主流 AI 搜索并未确认会消费 `/llms.txt`。把它当成可选交付，而不是排名承诺。
5. 结果里 `persisted: false` 表示没有写入工作区。
