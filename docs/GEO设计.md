# 给程序员的 GEO 开发指南（基于 zoomer.top）

既然你是程序员、有自己的产品域名、想自己开发 GEO 工具，那我给你一套**真正可落地的**技术路线，而不是营销话术。

---

## 一、先校准认知：什么是可开发的 GEO

**GEO 工具的本质 = 三个子系统**：
1. **内容生成/优化引擎** —— 把品牌内容改写成 AI 友好形态
2. **检索/引用监测系统** —— 跨多个 AI 平台追踪"被引用"状态
3. **数据反馈闭环** —— 把监测结果反哺内容策略

跟"贴牌源码"的差异在于：前两个是有真实技术门槛的，**不是 Vue 前端能搞定的**。

---

## 二、推荐的技术栈架构

```
┌─────────────────────────────────────────────────┐
│  Frontend (Vue 3 / Nuxt)  → zoomer.top 后台      │
├─────────────────────────────────────────────────┤
│  API Gateway (FastAPI / Hono)                    │
├─────────────────────────────────────────────────┤
│  Core Services:                                  │
│  ├─ Content Optimizer (LLM 改写 + 结构化)        │
│  ├─ AI Citation Monitor (多平台抓取 + 解析)      │
│  ├─ Schema Generator (JSON-LD 自动化生成)        │
│  ├─ Knowledge Graph Builder (实体关系抽取)       │
│  └─ Reporting Engine (效果追踪)                  │
├─────────────────────────────────────────────────┤
│  Data: PostgreSQL + pgvector + Redis              │
├─────────────────────────────────────────────────┤
│  Workers: Python (asyncio) / Node (BullMQ)        │
└─────────────────────────────────────────────────┘
```

---

## 三、四大核心模块的具体实现

### 模块 1：Content Optimizer（内容改写引擎）

**目标**：把普通品牌内容改写成"AI 友好切片"。

**技术要点**：

```python
# 核心思路：把长文本拆成"可独立被引用"的原子单元
class ContentAtomizer:
    """每段必须包含：实体 + 事实 + 数字/时间锚点 + 出处"""

    def split_into_atoms(self, text: str) -> list[Atom]:
        # 1. 用 LLM 做段落级语义切分
        # 2. 对每段提取：subject / predicate / object / data_anchors
        # 3. 检查每段是否满足 AI-引用友好性评分
        # 4. 重写不友好的段落（缺数字、缺时间、缺出处）
        pass

    def generate_faq(self, atoms: list[Atom]) -> list[QAPair]:
        """为每组原子内容自动生成 5W1H 问答对"""
        pass

    def add_structured_markers(self, atoms: list[Atom]) -> JSONLD:
        """自动生成 Schema.org/JSON-LD 标记"""
        pass
```

**关键 prompt 模板**（给 LLM 的）：
```text
你是一个 GEO 优化专家。把以下内容改写为"AI 答案友好"形态：
1. 每段必须含具体数字、时间或机构名
2. 把形容词替换为可验证的事实
3. 补充 3-5 个用户可能问的具体问题及答案
4. 在开头给出 1 句"定义句"（subject + is + value）
5. 输出 JSON: {atoms: [...], faq: [...], schema: {...}}
```

**评估指标**：
- 原子化率（段落含数字/实体/出处的比例，目标 > 80%）
- 切片独立性（任一段切出后仍能自解释）
- FAQ 覆盖度（与高频 query 的 cosine 相似度）

---

### 模块 2：AI Citation Monitor（多平台引用监测）

**目标**：知道"用户在 AI 里问什么、谁被引用了、我排第几"。

**技术实现**：

```python
PLATFORMS = {
    "openai": {
        "endpoint": "https://api.openai.com/v1/chat/completions",
        "model": "gpt-4o-search-preview",  # 带搜索的版本
        "citation_field": "message.citations",  # OpenAI 2024 加的
    },
    "perplexity": {
        "endpoint": "https://api.perplexity.ai/chat/completions",
        "model": "sonar",
        "citation_field": "citations",  # 自带 citations 数组
    },
    "anthropic": {
        "endpoint": "https://api.anthropic.com/v1/messages",
        "model": "claude-sonnet-4-6",
        "with_web_search": True,  # 需开 tools
    },
    "google_gemini": {
        "endpoint": "https://generativelanguage.googleapis.com/v1beta",
        "model": "gemini-2.5-pro",
        "grounding_meta": True,  # groundingChunks
    },
    "deepseek": {
        "endpoint": "https://api.deepseek.com/v1/chat/completions",
        "model": "deepseek-chat",
        "with_web_search": True,
    },
}

class CitationMonitor:
    async def track_query(self, query: str, brand: str) -> Report:
        tasks = [self._query_platform(p, query) for p in PLATFORMS]
        results = await asyncio.gather(*tasks)
        return self._analyze(results, brand)

    def _analyze(self, results, brand) -> Report:
        # 1. 检测品牌名是否在答案中出现
        # 2. 检测品牌是否在 citations 数组中
        # 3. 计算品牌"被引用排名"（vs 竞品）
        # 4. 提取被引用的具体 URL
        # 5. 计算 Share of Voice (SOV)
        pass
```

**数据库设计**：
```sql
CREATE TABLE citation_events (
    id BIGSERIAL PRIMARY KEY,
    query TEXT NOT NULL,
    platform VARCHAR(32),
    brand VARCHAR(128),
    cited_urls JSONB,  -- [{url, position, snippet}]
    mentioned BOOLEAN,
    rank_in_answer INT,
    competitors JSONB,
    raw_answer TEXT,
    query_intent JSONB,  -- {type, category, urgency}
    embedding VECTOR(1536),  -- pgvector, 便于聚类
    captured_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON citation_events USING ivfflat (embedding vector_cosine_ops);
```

**query 库怎么建**：
- 抓取 Google Suggest、Related Searches、People Also Ask
- 抓取 AnswerThePublic、AlsoAsked
- 直接调 LLM 生成："为一个 SaaS 产品生成 100 个用户会问的 AI 搜索 query"
- 监控竞品在 LLM 中被引用的"前序 query"，反推

---

### 模块 3：Schema & llms.txt 自动生成器

**llms.txt 是 2024 年 Answer.AI 提出的 AI 爬虫协议**，类似于 robots.txt 但专门给 LLM 用的：

```markdown
# zoomer.top
> AI 时代的内容协作平台，专注团队知识沉淀与语义检索

## 核心产品
- [功能 1](https://zoomer.top/features/x): 一句话定义
- [功能 2](https://zoomer.top/features/y): 一句话定义

## 权威资源
- [白皮书](https://zoomer.top/whitepaper.pdf): 完整技术方案
- [技术博客](https://zoomer.top/blog): 工程实践

## 常见问答
- Q: zoomer.top 解决什么问题？A: ...
- Q: 跟 Notion 的差异？A: ...

## 更新频率
- 文档：每周
- 博客：每周 2 篇
```

**自动生成 JSON-LD**（用 LLM 抽取）：

```typescript
import { generateStructuredData } from './llm-extractor';

const schema = await generateStructuredData({
  type: 'SoftwareApplication',
  url: 'https://zoomer.top',
  fields: {
    name: '...',
    description: '...',
    applicationCategory: '...',
    offers: {...},
    aggregateRating: {...},
  }
});

// 输出:
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "zoomer.top",
  "description": "...",
  "url": "https://zoomer.top",
  "applicationCategory": "ProductivityApplication",
  "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
  "aggregateRating": {"@type": "AggregateRating", "ratingValue": "4.8", "ratingCount": "126"}
}
```
**部署**：每次内容更新自动重生成 → 写入 `/llms.txt` + 各页面 `<script type="application/ld+json">` → 提交到 GSC + Bing Webmaster。

---

### 模块 4：Knowledge Graph Builder（知识图谱）

**目标**：让 zoomer.top 的"实体"在 Wikidata/Schema.org 知识图谱中可被识别。

```python
from rdflib import Graph, Literal, URIRef, Namespace

EX = Namespace("https://zoomer.top/entity/")

def build_kg():
    g = Graph()

    # 把 zoomer.top 建模为一个 SoftwareProduct 节点
    g.add((EX.zoomer_top, RDF.type, SCHEMA.SoftwareApplication))
    g.add((EX.zoomer_top, SCHEMA.name, Literal("zoomer.top")))
    g.add((EX.zoomer_top, SCHEMA.featureList, EX.feature_knowledge_graph))

    # 与竞品/上下游建立关系
    g.add((EX.zoomer_top, SCHEMA competitor, EX.notion))
    g.add((EX.zoomer_top, SCHEMA.audience, EX.startup_founder))


    # 同步到 Wikidata（如果值得提交）
    # wd:Q12345 ...

    return g
```

**实际收益**：知识图谱对**通用知识**类的 AI 答案有强作用（医疗、法律、科学），对**商业 SaaS** 的引用率影响相对有限。但 Schema.org 标记对**站内页面被 RAG 检索的概率**有显著正向作用。

---

## 四、落地路线图（给独立开发者的 4 个阶段）

### 阶段 1：手动验证假设（1-2 周）

不开任何工具，先手工做：

```python
# 实验：在 5 个 AI 平台问 50 个 query，记录引用情况
queries = [
    "best AI content tool for teams",
    "alternative to Notion for developers",
    "what is semantic search",
    # ... 50 个
]

# 跑一遍，手工记录 zoomer.top 是否被引用
# 这个 baseline 是你后面所有优化的对照
```

**这步不写代码，3 天能做完**。结果会决定你后续要投入多少。

### 阶段 2：MVP 监测系统（2-3 周）

只做 **Citation Monitor** 一个模块：

```
- FastAPI + PostgreSQL
- 支持 3 个平台（OpenAI、Perplexity、DeepSeek）
- 一个 query 库（100 个 query）
- 每日自动跑一遍
- 一个简单 dashboard（用 Nuxt 3 + Chart.js）
- 部署到 CloudBase 或 Vercel
```

**代码量估算**：~2000 行 Python + 500 行前端。**独立开发者 3 周可上线**。

### 阶段 3：内容优化器（4-6 周）

加 **Content Optimizer**：

```
- 基于你的现有内容，自动生成"AI 友好改写版"
- 集成 Schema.org 生成
- llms.txt 自动生成
- FAQ 自动生成
- 改写质量人工评分 → RLHF 数据集
```

### 阶段 4：闭环 + 多租户（2 个月+）

把上面两个模块串起来：

```
监测发现"某 query 我没被引用"
    ↓
系统自动分析"应该改写哪篇内容"
    ↓
LLM 生成改写方案
    ↓
人工审核 → 发布
    ↓
监测该 query 的引用率变化
```

---

## 五、给 zoomer.top 的具体起点建议

我建议**这周就做**：
1. **部署 llms.txt** —— 在 zoomer.top 根目录放一份完整 llms.txt（10 分钟）
2. **添加关键页面 JSON-LD** —— SoftwareApplication、Organization、Product、FAQPage（1 天）
3. **建 50 个核心 query 库** —— 围绕"AI 协作、知识管理、团队 wiki"等你的核心场景（半天）
4. **跑一次 baseline** —— 5 个平台 × 50 个 query = 250 次调用，记录 zoomer.top 当前被引用情况（半天）
5. **改写 10 篇核心内容** —— 按"AI 友好切片"标准重写（2 天）

做完这 5 步，**2 周内你就有真实的 baseline + 第一批可对比的优化样本**。这时候再决定要不要做工具。

---

## 六、不要做的事

- ❌ 不要买别人"现成的 GEO 系统源码" —— **那种代码是 Vue 前端壳子，核心 AI 集成都是空的**
- ❌ 不要相信"一次投入长期收益" —— AI 模型版本每月都在变，**你的内容工程必须能持续迭代**
- ❌ 不要做"全自动" —— AI 改写的内容**100% 需要人工审核**，否则会出现事实错误/AI 幻觉反向污染你的品牌
- ❌ 不要试图"hack" LLM —— prompt injection、训练数据污染、伪装权威信源这些事一旦被抓到，**品牌会被永久降权**（OpenAI 2024 公开声明过）

---

## 七、推荐学习资源

| 资源 | 价值 |
|---|---|
| arxiv 2311.09735 *GEO: Generative Engine Optimization* | **唯一**有 A/B 实验的学术论文 |
| Aleyda Solis 的 AI Search 系列 | 国际 SEO 圈最系统的 GEO 实践 |
| llms.txt 官方说明 (llmstxt.org) | AI 爬虫协议的事实标准 |
| Schema.org 官方文档 | 结构化数据的圣经 |
| Perplexity Sonar API 文档 | 唯一一个**默认带 citations 字段**的 API，最适合做监测 |

---

要不要我帮你**先把阶段 1 的 50 个 query 库 + baseline 监测脚本**写出来？这是一个真正能跑的最小可行工具，大概 2-3 小时工作量。