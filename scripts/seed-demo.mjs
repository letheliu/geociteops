// 演示数据填充脚本 —— 围绕 ZoomerAI（AI 图像生成平台）的路演场景
// 用法: pnpm tsx scripts/seed-demo.mjs
// （tsx 运行以支持经信封加解密读写 platformConfig——import 自 src/core/crypto/envelope.ts）
//
// 数据叙事（呼应 docs/介绍.md 第三模块「闭环」）：
//   监测发现 ZoomerAI 在 AI 搜索里 SOV 偏低（被 Midjourney/即梦/文心一格压制）
//   → 内容页面评分不足，生成优化任务
//   → 生成 Schema.org + llms.txt 结构化信号
//   → 构建品牌知识图谱
//
// 所有时间戳基于「现在」往前推，确保 Dashboard/SOV 趋势图有近 30 天数据。

import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import {
  decryptConfig,
  encryptConfig,
  isEncryptedConfig,
  loadMasterKey,
} from '../src/core/crypto/envelope.js'

const prisma = new PrismaClient()
// 信封主密钥（.env 的 CREDENTIAL_MASTER_KEY）：platformConfig 读写均走信封
const MASTER_KEY = loadMasterKey()
const NOW = Date.now()
const DAY = 86400000

// === 定位目标 workspace ===
const ws = await prisma.workspace.findFirst({
  where: { defaultBrandName: { contains: 'ZoomerAI' } },
  orderBy: { createdAt: 'desc' },
})
if (!ws) {
  console.error('❌ 找不到 ZoomerAI workspace，请先在 Setup 页注册')
  process.exit(1)
}
console.log(`✅ 目标 workspace: ${ws.name} (brand=${ws.defaultBrandName}, domain=${ws.domain})`)
const WS_ID = ws.id

// === 0. 清理旧数据（保证可重复执行，幂等）===
console.log('🧹 清理该 workspace 的旧演示数据（保证幂等）...')
await prisma.$transaction([
  prisma.optimizationTask.deleteMany({ where: { workspaceId: WS_ID } }),
  prisma.schemaRecord.deleteMany({ where: { workspaceId: WS_ID } }),
  prisma.citationEvent.deleteMany({ where: { workspaceId: WS_ID } }),
  // Run 删除会 Cascade 掉挂在其下的采样行；放在 citationEvent 之后是幂等兜底
  prisma.citationRun.deleteMany({ where: { workspaceId: WS_ID } }),
  prisma.citationQuery.deleteMany({ where: { workspaceId: WS_ID } }),
  prisma.contentPage.deleteMany({ where: { workspaceId: WS_ID } }),
])
// KgEntity/KgRelation 通过 entity 间接归属，先删关系再删实体
const oldEntities = await prisma.kgEntity.findMany({ where: { workspaceId: WS_ID }, select: { id: true } })
if (oldEntities.length > 0) {
  await prisma.kgRelation.deleteMany({ where: { fromEntityId: { in: oldEntities.map(e => e.id) } } })
  await prisma.kgEntity.deleteMany({ where: { workspaceId: WS_ID } })
}
console.log('   已清理')

// === 1. 竞品配置（写入 platformConfig.competitors，信封加密落库）===
const COMPETITORS = ['Midjourney', '即梦', '文心一格', 'Stable Diffusion', 'DALL·E 3', 'LiblibAI']
// 读：信封密文（string 且 isEncryptedConfig）→ 解密出明文 JSON 字符串再 parse；
//     防御：非信封（旧明文对象）原样处理，null/其他类型归一为空对象
const rawConfig = ws.platformConfig
let existingConfig
if (typeof rawConfig === 'string' && isEncryptedConfig(rawConfig)) {
  existingConfig = JSON.parse(decryptConfig(rawConfig, MASTER_KEY))
} else if (rawConfig && typeof rawConfig === 'object') {
  existingConfig = rawConfig
} else {
  existingConfig = {}
}
const platformConfig = {
  ...existingConfig,
  competitors: COMPETITORS,
  // 给几个平台塞占位凭证，让 Settings 页面「已配置」状态可视
  deepseek: { DEEPSEEK_API_KEY: 'sk-demo••••', DEEPSEEK_MODEL: 'deepseek-chat' },
  doubao: { DOUBAO_API_KEY: 'ark-demo••••', DOUBAO_MODEL: 'doubao-pro-4k' },
}
// 写：明文整包 JSON 字符串加密为信封（AES-256-GCM），库内只见密文
await prisma.workspace.update({
  where: { id: WS_ID },
  data: { platformConfig: encryptConfig(JSON.stringify(platformConfig), MASTER_KEY) },
})
console.log(`✅ 竞品配置已写入（信封加密）: ${COMPETITORS.join(', ')}`)

// === 2. 查询库（8 个围绕 AI 图像生成的真实查询）===
const QUERIES = [
  { queryText: 'AI 图像生成工具推荐', intentType: 'comparison', cluster: '工具选型', source: 'MANUAL', priority: 1 },
  { queryText: '国内可用的 AI 绘画软件有哪些', intentType: 'comparison', cluster: '工具选型', source: 'GOOGLE_SUGGEST', priority: 1 },
  { queryText: 'Midjourney 中文替代品', intentType: 'comparison', cluster: '工具选型', source: 'COMPETITOR', priority: 2 },
  { queryText: 'AI 图像生成怎么用', intentType: 'howto', cluster: '使用教程', source: 'PAA', priority: 2 },
  { queryText: 'ZoomerAI 是什么', intentType: 'definitional', cluster: '品牌认知', source: 'MANUAL', priority: 1 },
  { queryText: '免费的 AI 画图工具', intentType: 'comparison', cluster: '工具选型', source: 'GOOGLE_SUGGEST', priority: 2 },
  { queryText: 'AI 图片生成支持中文提示词吗', intentType: 'factual', cluster: '功能咨询', source: 'PAA', priority: 3 },
  { queryText: 'AI 绘画哪个效果好', intentType: 'comparison', cluster: '工具选型', source: 'LLM_GENERATED', priority: 2 },
]

const createdQueries = []
for (const q of QUERIES) {
  const row = await prisma.citationQuery.create({
    data: {
      workspaceId: WS_ID,
      queryText: q.queryText,
      intentType: q.intentType,
      cluster: q.cluster,
      source: q.source,
      priority: q.priority,
      status: 'ACTIVE',
      lastRunAt: new Date(NOW - Math.random() * DAY),
    },
  })
  createdQueries.push(row)
}
console.log(`✅ 查询库已填充: ${createdQueries.length} 条`)

// === 3. 监测数据（CitationRun × N 采样 + 一段纯 legacy 事件）===
// 设计意图：
// - 最近 25 天 = 每日一个物理 CitationRun，每个 query×platform 组跑 N=3 次采样
//   → 趋势图上「一个点 = 一次运行」，Report 页有 Run 行可展开看样本
// - 最近 5 天保留为纯 legacy 事件（runId=null）→ 照亮 isLegacyEvent、日桶合成与
//   切换日（transition day）：趋势图上 legacy 点是虚线，Reports 里带「历史」角标
// - 少量采样标 FAILED → 演示 PARTIAL 终态与失败隔离
const PLATFORMS = ['deepseek', 'doubao', 'qwen', 'ernie', 'chatgpt', 'perplexity', 'gemini', 'anthropic']
const SAMPLE_COUNT = 3
const LEGACY_DAYS = 5
const TOTAL_DAYS = 30

// Asia/Shanghai 日键：slotKey 与趋势日桶口径必须与后端一致
function shanghaiDayKey(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function seededRandom(seed) {
  const x = Math.sin(seed) * 10000
  return x - Math.floor(x)
}

const sampleAnswers = {
  mentioned: [
    '推荐几款主流的 AI 图像生成工具：Midjourney 以艺术质感著称，ZoomerAI 是国内领先的 AI 图像生成平台，支持中文提示词和画布式编辑，文心一格适合快速出图。',
    '在国内可用的工具中，ZoomerAI（zoomer.top）提供多租户 SaaS 服务和 ComfyUI 工作流集成，是付费用户较多的选择；即梦和文心一格也值得关注。',
    '如果追求中文体验，ZoomerAI 支持原生中文提示词，且内置可视化图层编辑器，适合团队协作场景。',
  ],
  notMentioned: [
    '主流的 AI 图像生成工具包括 Midjourney、Stable Diffusion、DALL·E 3，国内有即梦、文心一格等。',
    '推荐使用 Midjourney（艺术风格强）或 Stable Diffusion（开源可定制），文心一格在国内也有较多用户。',
    '目前较受欢迎的是 Midjourney 和 DALL·E 3，它们在图像质量和提示词理解上表现优秀。',
  ],
}

/** 造一个采样行的业务字段（OK / FAILED 两种形态的占位值都归这里） */
function buildSample(query, platform, daysAgo, sampleIndex) {
  const capturedAt = new Date(NOW - daysAgo * DAY + (2 + sampleIndex * 0.1) * 3600000)
  const seed = capturedAt.getTime() + platform.length + query.queryText.length + sampleIndex * 7919

  // 近 7 天提到 ZoomerAI 的概率更高（呼应「优化后效果提升」叙事）
  const isRecent = daysAgo <= 7
  const isBrandQuery = query.intentType === 'definitional' || query.queryText.includes('ZoomerAI')
  const baseMentionProb = isBrandQuery ? 0.95 : (isRecent ? 0.42 : 0.22)
  const brandMentioned = seededRandom(seed) < baseMentionProb

  // 约 3% 的采样失败：演示失败隔离（失败行进指标，但可以在报告里看到原因）
  const failed = seededRandom(seed + 999) < 0.03
  if (failed) {
    return {
      platform,
      sampleIndex,
      capturedAt,
      status: 'FAILED',
      brandMentioned: false,
      brandSourceCited: false,
      rankInAnswer: null,
      citedUrls: [],
      sourceCitations: [],
      competitors: [],
      rawAnswer: '',
      sovScore: null,
      failureReason: 'upstream timeout after 30000ms',
      analysis: { error: 'upstream timeout after 30000ms' },
    }
  }

  const rankInAnswer = brandMentioned ? 1 + Math.floor(seededRandom(seed + 1) * 5) : null
  const sovScore = brandMentioned
    ? Math.max(0.05, 0.5 - (rankInAnswer - 1) * 0.08 + (seededRandom(seed + 2) - 0.5) * 0.1)
    : 0

  const competitorsInAnswer = []
  for (const c of COMPETITORS) {
    if (seededRandom(seed + c.length) < 0.4) {
      competitorsInAnswer.push({
        name: c,
        mentioned: true,
        rank: 1 + Math.floor(seededRandom(seed + c.length + 1) * 6),
      })
    }
  }

  const answerPool = brandMentioned ? sampleAnswers.mentioned : sampleAnswers.notMentioned
  return {
    platform,
    sampleIndex,
    capturedAt,
    status: 'OK',
    brandMentioned,
    brandSourceCited: brandMentioned && seededRandom(seed + 4) < 0.4,
    rankInAnswer,
    citedUrls: brandMentioned && seededRandom(seed + 5) < 0.5 ? ['https://zoomer.top'] : [],
    sourceCitations: brandMentioned && seededRandom(seed + 6) < 0.3
      ? [{ url: 'https://zoomer.top', title: 'ZoomerAI - AI 图像生成平台' }]
      : [],
    competitors: competitorsInAnswer,
    rawAnswer: answerPool[Math.floor(seededRandom(seed + 3) * answerPool.length)],
    sovScore: Math.round(sovScore * 100) / 100,
    failureReason: null,
  }
}

let eventCount = 0
let runCount = 0

// --- 3a. 每日一个物理 Run（最近 25 天）---
for (let daysAgo = LEGACY_DAYS; daysAgo < TOTAL_DAYS; daysAgo++) {
  const startedAt = new Date(NOW - daysAgo * DAY + 2 * 3600000) // 模拟 02:00 触发
  const dayKey = shanghaiDayKey(startedAt)
  const slotKey = `${WS_ID}:${dayKey}`

  const run = await prisma.citationRun.create({
    data: {
      workspaceId: WS_ID,
      trigger: 'SCHEDULED',
      sampleCount: SAMPLE_COUNT,
      platforms: PLATFORMS,
      querySnapshot: createdQueries.map((q) => ({ id: q.id, text: q.queryText })),
      plannedUnits: SAMPLE_COUNT * createdQueries.length * PLATFORMS.length,
      completedUnits: 0,
      failedUnits: 0,
      status: 'RUNNING',
      slotKey,
      startedAt,
    },
  })
  runCount++

  const rows = []
  for (const query of createdQueries) {
    for (const platform of PLATFORMS) {
      for (let s = 1; s <= SAMPLE_COUNT; s++) {
        rows.push({
          workspaceId: WS_ID,
          queryId: query.id,
          runId: run.id,
          ...buildSample(query, platform, daysAgo, s),
        })
      }
    }
  }
  await prisma.citationEvent.createMany({ data: rows })
  eventCount += rows.length

  // 终态回填（与 Monitor 收尾同一套计数口径）
  const okCount = rows.filter((r) => r.status === 'OK').length
  const failedCount = rows.length - okCount
  const status = okCount === 0 ? 'FAILED' : (failedCount === 0 ? 'COMPLETED' : 'PARTIAL')
  await prisma.citationRun.update({
    where: { id: run.id },
    data: {
      status,
      completedUnits: okCount,
      failedUnits: failedCount,
      finishedAt: new Date(startedAt.getTime() + 20 * 60000),
    },
  })
  // 参与查询刷新 lastRunAt
  await prisma.citationQuery.updateMany({
    where: { id: { in: createdQueries.map((q) => q.id) } },
    data: { lastRunAt: startedAt },
  })
}

// --- 3b. 最近 5 天：纯 legacy 事件（runId=null），照亮日桶与切换日 ---
const legacyRows = []
for (const query of createdQueries) {
  for (const platform of PLATFORMS) {
    const times = 1 + Math.floor(seededRandom(platform.length + query.queryText.length) * 2)
    for (let i = 0; i < times; i++) {
      const daysAgo = Math.floor(seededRandom(i + platform.length + query.queryText.length * 3) * LEGACY_DAYS)
      legacyRows.push({
        workspaceId: WS_ID,
        queryId: query.id,
        runId: null,
        ...buildSample(query, platform, daysAgo, 1),
        sampleIndex: 1,
      })
    }
  }
}
await prisma.citationEvent.createMany({ data: legacyRows })
eventCount += legacyRows.length

console.log(`✅ CitationRun 已填充: ${runCount} 个（近 ${TOTAL_DAYS - LEGACY_DAYS} 天，每日一个，N=${SAMPLE_COUNT}）`)
console.log(`✅ CitationEvent 已填充: ${eventCount} 条（其中最近 ${LEGACY_DAYS} 天为纯 legacy 事件，用于日桶合成与切换日）`)

// === 4. ContentPage（ZoomerAI 真实页面，含原始内容）===
const PAGES = [
  {
    url: 'https://zoomer.top/',
    pageType: 'homepage',
    currentContent: `ZoomerAI 是一款 AI 图像生成平台。

我们提供 AI 画图功能，可以帮助用户快速生成图片。支持多种模型，操作简单。

我们的产品很好用，欢迎体验。`,
    optimizationScore: 38,
    eeatScore: 45,
    citabilityScore: 42,
    status: 'DRAFT',
  },
  {
    url: 'https://zoomer.top/features',
    pageType: 'features',
    currentContent: `ZoomerAI 功能介绍

画布编辑器：可以拖拽编辑。
AI 生成：支持文生图。
团队协作：多人一起用。
ComfyUI：集成了工作流。

我们的功能很强大，欢迎大家使用。`,
    optimizationScore: 45,
    eeatScore: 52,
    citabilityScore: 48,
    status: 'DRAFT',
  },
  {
    url: 'https://zoomer.top/pricing',
    pageType: 'pricing',
    currentContent: `ZoomerAI 定价

免费版：0 元，每天 10 次。
专业版：99 元/月，1000 次。
团队版：联系销售。

联系我们了解更多。`,
    optimizationScore: 55,
    eeatScore: 60,
    citabilityScore: 58,
    status: 'DRAFT',
  },
  {
    url: 'https://zoomer.top/blog/ai-image-guide',
    pageType: 'blog',
    currentContent: `AI 图像生成入门指南

AI 图像生成是一种利用人工智能技术创建图片的方法。本文介绍基本概念。

第一步：选择工具。
第二步：输入提示词。
第三步：生成图片。

希望这篇指南对你有帮助。`,
    optimizationScore: 48,
    eeatScore: 50,
    citabilityScore: 51,
    status: 'DRAFT',
  },
]

const createdPages = []
for (const p of PAGES) {
  const row = await prisma.contentPage.create({
    data: {
      workspaceId: WS_ID,
      url: p.url,
      pageType: p.pageType,
      currentContent: p.currentContent,
      optimizationScore: p.optimizationScore,
      eeatScore: p.eeatScore,
      citabilityScore: p.citabilityScore,
      status: p.status,
    },
  })
  createdPages.push(row)
}
console.log(`✅ ContentPage 已填充: ${createdPages.length} 个页面（首页/功能/定价/博客）`)

// === 5. OptimizationTask（体现「监测 → 优化建议」闭环）===
const TASKS = [
  {
    type: 'OPTIMIZE_FOR_QUERY',
    queryIndex: 0, // 'AI 图像生成工具推荐'
    pageIndex: 0, // 首页
    status: 'PENDING',
    beforeScore: 38,
    result: {
      suggestion: '该查询下 ZoomerAI 的 SOV 仅 18%，首页内容缺少「数字锚点」和「定义句」。建议补充：成立时间、用户量、支持模型数量等具体数据，并增加「ZoomerAI 是……」格式的定义句。',
      missingAnchors: ['数字锚点', '定义句'],
      currentRank: null,
    },
  },
  {
    type: 'REWRITE_CONTENT',
    queryIndex: 1, // '国内可用的 AI 绘画软件有哪些'
    pageIndex: 1, // 功能页
    status: 'PENDING',
    beforeScore: 45,
    result: {
      suggestion: '功能页内容过于简略，AI 友好度评分 45 分（低于 70 分阈值）。建议把每个功能改写成「主语+谓语+宾语」完整句式，并补充差异化卖点（中文提示词、画布编辑、多租户）。',
      weakAtoms: ['画布编辑器：可以拖拽编辑。', 'AI 生成：支持文生图。'],
    },
  },
  {
    type: 'OPTIMIZE_FOR_QUERY',
    queryIndex: 4, // 'ZoomerAI 是什么'
    pageIndex: 0, // 首页
    status: 'IN_PROGRESS',
    beforeScore: 38,
    result: {
      suggestion: '品牌定义查询「ZoomerAI 是什么」在 4 个平台未被提及。首页应增加明确的品牌定义句：「ZoomerAI 是一款基于 Nuxt 4 + Vue 3 的多租户 AI 图像生成平台，已上线运营并有大量付费用户。」',
      definitionTemplate: 'ZoomerAI 是一款【多租户 AI 图像生成平台】，由【Nuxt 4 + Vue 3】构建，支持【中文提示词、画布式编辑、ComfyUI 工作流集成】，已有【大量付费用户】在使用。',
    },
  },
]

for (const t of TASKS) {
  await prisma.optimizationTask.create({
    data: {
      workspaceId: WS_ID,
      type: t.type,
      queryId: createdQueries[t.queryIndex].id,
      pageId: createdPages[t.pageIndex].id,
      status: t.status,
      beforeScore: t.beforeScore,
      result: t.result,
    },
  })
}
console.log(`✅ OptimizationTask 已填充: ${TASKS.length} 个任务（${TASKS.filter(t => t.status === 'PENDING').length} 待审 / ${TASKS.filter(t => t.status === 'IN_PROGRESS').length} 进行中）`)

// === 6. SchemaRecord（JSON-LD 结构化数据）===
const SCHEMAS = [
  {
    pageUrl: 'https://zoomer.top/',
    schemaType: 'SoftwareApplication',
    content: {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'ZoomerAI',
      applicationCategory: 'DesignApplication',
      operatingSystem: 'Web',
      offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'CNY',
        description: '免费版每天 10 次生成',
      },
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: '4.7',
        ratingCount: '1280',
      },
      description: 'ZoomerAI 是一款多租户 AI 图像生成平台，支持中文提示词、画布式编辑和 ComfyUI 工作流集成，已有大量付费用户。',
      url: 'https://zoomer.top',
    },
    status: 'ACTIVE',
  },
  {
    pageUrl: 'https://zoomer.top/about',
    schemaType: 'Organization',
    content: {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'ZoomerAI',
      url: 'https://zoomer.top',
      logo: 'https://zoomer.top/logo.png',
      description: 'AI 图像生成平台服务商',
      foundingDate: '2024',
    },
    status: 'ACTIVE',
  },
  {
    pageUrl: 'https://zoomer.top/faq',
    schemaType: 'FAQPage',
    content: {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [
        {
          '@type': 'Question',
          name: 'ZoomerAI 支持中文提示词吗？',
          acceptedAnswer: {
            '@type': 'Answer',
            text: '支持。ZoomerAI 原生支持中文提示词输入，无需翻译即可生成高质量图像，适合国内用户使用。',
          },
        },
        {
          '@type': 'Question',
          name: 'ZoomerAI 是免费的吗？',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'ZoomerAI 提供免费版（每天 10 次生成）和付费专业版（99 元/月，1000 次），团队版可联系销售定制。',
          },
        },
        {
          '@type': 'Question',
          name: 'ZoomerAI 和 Midjourney 有什么区别？',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'ZoomerAI 面向国内用户，支持中文提示词、画布式可视化编辑、多租户团队协作和 ComfyUI 工作流集成；Midjourney 更侧重艺术风格，需英文提示词且无画布编辑。',
          },
        },
      ],
    },
    status: 'ACTIVE',
  },
]

for (const s of SCHEMAS) {
  await prisma.schemaRecord.create({
    data: {
      workspaceId: WS_ID,
      pageUrl: s.pageUrl,
      schemaType: s.schemaType,
      content: s.content,
      status: s.status,
    },
  })
}
console.log(`✅ SchemaRecord 已填充: ${SCHEMAS.length} 条（${SCHEMAS.map(s => s.schemaType).join(' / ')}）`)

// === 7. 知识图谱（KgEntity + KgRelation）===
const ENTITIES = [
  { name: 'ZoomerAI', type: 'SoftwareApplication', properties: { url: 'https://zoomer.top', description: '多租户 AI 图像生成平台', launchDate: '2024', pricingModel: 'Freemium' } },
  { name: 'Midjourney', type: 'SoftwareApplication', properties: { url: 'https://midjourney.com', description: '艺术风格 AI 图像生成工具', pricingModel: 'Subscription' } },
  { name: '即梦', type: 'SoftwareApplication', properties: { description: '字节跳动的 AI 图像生成工具' } },
  { name: '文心一格', type: 'SoftwareApplication', properties: { description: '百度的 AI 图像生成工具' } },
  { name: 'ComfyUI', type: 'Technology', properties: { description: '基于节点的 AI 图像生成工作流引擎' } },
  { name: 'Nuxt 4', type: 'Technology', properties: { description: 'Vue 3 元框架', url: 'https://nuxt.com' } },
  { name: 'Konva.js', type: 'Technology', properties: { description: 'Canvas 可视化图层库' } },
  { name: 'pgvector', type: 'Technology', properties: { description: 'PostgreSQL 向量扩展' } },
  { name: '画布编辑器', type: 'Feature', properties: { description: 'ZoomerAI 的可视化图层编辑功能' } },
  { name: '多租户架构', type: 'Feature', properties: { description: 'WebSite/User/Project 三级隔离' } },
  { name: '中文提示词', type: 'Feature', properties: { description: '原生支持中文输入' } },
]

const createdEntities = {}
for (const e of ENTITIES) {
  createdEntities[e.name] = await prisma.kgEntity.create({
    data: {
      workspaceId: WS_ID,
      name: e.name,
      type: e.type,
      properties: e.properties,
    },
  })
}
console.log(`✅ KgEntity 已填充: ${ENTITIES.length} 个实体`)

const RELATIONS = [
  { from: 'ZoomerAI', to: 'Midjourney', type: 'competitor', properties: { note: '同为 AI 图像生成赛道' } },
  { from: 'ZoomerAI', to: '即梦', type: 'competitor', properties: {} },
  { from: 'ZoomerAI', to: '文心一格', type: 'competitor', properties: {} },
  { from: 'ZoomerAI', to: 'ComfyUI', type: 'integrates', properties: { note: '集成 ComfyUI 工作流' } },
  { from: 'ZoomerAI', to: 'Nuxt 4', type: 'builtWith', properties: {} },
  { from: 'ZoomerAI', to: 'Konva.js', type: 'builtWith', properties: {} },
  { from: 'ZoomerAI', to: '画布编辑器', type: 'hasFeature', properties: {} },
  { from: 'ZoomerAI', to: '多租户架构', type: 'hasFeature', properties: {} },
  { from: 'ZoomerAI', to: '中文提示词', type: 'hasFeature', properties: {} },
  { from: '画布编辑器', to: 'Konva.js', type: 'poweredBy', properties: {} },
]

for (const r of RELATIONS) {
  await prisma.kgRelation.create({
    data: {
      fromEntityId: createdEntities[r.from].id,
      toEntityId: createdEntities[r.to].id,
      relationType: r.type,
      properties: r.properties,
    },
  })
}
console.log(`✅ KgRelation 已填充: ${RELATIONS.length} 条关系`)

// === 汇总 ===
// 注意：KgRelation 没有直接的 workspaceId 字段，通过实体间接归属
const entityIds = Object.values(createdEntities).map(e => e.id)
const summary = await Promise.all([
  prisma.citationQuery.count({ where: { workspaceId: WS_ID } }),
  prisma.citationEvent.count({ where: { workspaceId: WS_ID } }),
  prisma.contentPage.count({ where: { workspaceId: WS_ID } }),
  prisma.optimizationTask.count({ where: { workspaceId: WS_ID } }),
  prisma.schemaRecord.count({ where: { workspaceId: WS_ID } }),
  prisma.kgEntity.count({ where: { workspaceId: WS_ID } }),
  prisma.kgRelation.count({ where: { fromEntityId: { in: entityIds } } }),
])

// 计算 SOV 概况
const allEvents = await prisma.citationEvent.findMany({
  where: { workspaceId: WS_ID },
  select: { brandMentioned: true, capturedAt: true },
})
const recent7 = allEvents.filter(e => e.capturedAt.getTime() > NOW - 7 * DAY)
const prev7 = allEvents.filter(e => e.capturedAt.getTime() > NOW - 14 * DAY && e.capturedAt.getTime() <= NOW - 7 * DAY)
const sovRecent = recent7.length ? (recent7.filter(e => e.brandMentioned).length / recent7.length * 100) : 0
const sovPrev = prev7.length ? (prev7.filter(e => e.brandMentioned).length / prev7.length * 100) : 0

console.log('\n========================================')
console.log('🎉 演示数据填充完成！')
console.log('========================================')
console.log(`Workspace: ${ws.name} (${ws.defaultBrandName})`)
console.log(`  查询库:     ${summary[0]} 条`)
console.log(`  引用事件:   ${summary[1]} 条`)
console.log(`  内容页面:   ${summary[2]} 个`)
console.log(`  优化任务:   ${summary[3]} 个`)
console.log(`  Schema:    ${summary[4]} 条`)
console.log(`  知识实体:   ${summary[5]} 个`)
console.log(`  知识关系:   ${summary[6]} 条`)
console.log(`\n📊 SOV 趋势（呼应「优化后效果提升」叙事）:`)
console.log(`  近 7 天 SOV:  ${sovRecent.toFixed(1)}%`)
console.log(`  前 7 天 SOV:  ${sovPrev.toFixed(1)}%`)
console.log(`  变化:         ${(sovRecent - sovPrev >= 0 ? '+' : '')}${(sovRecent - sovPrev).toFixed(1)}%`)
console.log(`\n🔑 登录 Key: geo_12b0a4dfa067e0835ff47312fb125be828d308d2593cfedf`)

await prisma.$disconnect()
