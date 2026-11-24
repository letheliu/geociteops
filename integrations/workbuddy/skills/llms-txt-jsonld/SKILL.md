---
name: llms-txt-jsonld
display_name: llms.txt 与 JSON-LD
display_name_en: llms.txt and JSON-LD
description: 当用户要生成或校验 llms.txt，或要 Schema.org JSON-LD 时使用。调用 generate_llms_txt 或 generate_schema。
description_zh: 生成或校验 llms.txt，并生成 Schema.org JSON-LD。只读令牌不会把文件写入工作区。
description_en: Generate or validate llms.txt and build Schema.org JSON-LD. A read token does not store the file.
examples_zh:
  - "为 Acme Draw 写一份 llms.txt"
  - "校验 https://acmedraw.example/llms.txt"
  - "给这个品牌生成 Organization JSON-LD"
examples_en:
  - "Write an llms.txt for Acme Draw"
  - "Validate https://acmedraw.example/llms.txt"
  - "Generate Organization JSON-LD for this brand"
version: 1.0.0
author: GeoCiteOps
---

# llms.txt 与 JSON-LD

需要 GeoCiteOps 连接器。生成和校验不是付费模型调用。

1. 写新的 llms.txt：向用户要品牌、一句话介绍和链接列表，调用 `generate_llms_txt`。不要编造链接。
2. 校验已有文件：用 `text`，或用 `url` 抓取线上文件。DEMO_MODE 不允许抓取。
3. 写 JSON-LD：确认类型后调用 `generate_schema`。缺字段按工具报错补齐。不要编造价格、评分或评价。
4. `read` 令牌只生成、不入库。入库需要 `run-checks` 和 `pageUrl`。
5. 告诉用户主流 AI 搜索并未确认会消费 `/llms.txt`。这是可选交付，不是排名承诺。
6. `persisted: false` 表示没有写入工作区。令牌不要出现在回复里。
