// Acme Draw（https://acmedraw.example）的虚构体检序列。
// 分数不手写：就绪走 buildReport，结构化信号走 runStructuredSignals，总分和行动走 conclude。
// 竞品只出现在 .example 域名上。

import { buildReport } from '../../src/modules/agent-readiness/score.js'
import { asEvidence, tx } from '../../src/modules/agent-readiness/types.js'
import { CHECK_WEIGHTS } from '../../src/modules/agent-readiness/weights.js'
import { conclude } from '../../src/modules/geo-health/orchestrator.js'
import { QUERY_FALLBACK_NOTE, querySourceOf } from '../../src/modules/geo-health/queries.js'
import { citationPillarScore, pageComposite } from '../../src/modules/geo-health/score.js'
import { runStructuredSignals } from '../../src/modules/geo-health/signals.js'

export const ACME_BRAND = 'Acme Draw'
export const ACME_SITE = 'https://acmedraw.example'
export const ACME_INDUSTRY = '插画生成'

const NOTE_EN = 'Fictional Acme Draw sample for the health-check walkthrough. Not a live fetch and not a live engine response.'
const NOTE_ZH = '这是 Acme Draw 的虚构样本，用来看体检趋势和定时复跑。不是一次真实抓取，也不是引擎的真实返回。'

const QUERIES = [
  { text: 'Acme Draw 是什么', kind: 'brand' },
  { text: '团队用的 AI 插画工具怎么选', kind: 'category' },
  { text: 'Northwind Ink 有没有可自托管的替代', kind: 'comparison' },
  { text: '免费的插画生成软件推荐', kind: 'category' },
]

const COMPETITORS = ['Northwind Ink', 'Lumen Sketch', 'Harbor Paint']

const CANONICAL = [
  row('deepseek', 0, { mentioned: true, cited: true, rank: 2, sov: 0.22, urls: ['https://acmedraw.example', 'https://northwind.example'], comps: { 'Northwind Ink': [1, 0.45], 'Lumen Sketch': [3, 0.18] } }),
  row('doubao', 0, { mentioned: true, cited: false, rank: 4, sov: 0.18, urls: ['https://northwind.example'], comps: { 'Northwind Ink': [1, 0.5], 'Lumen Sketch': [2, 0.32] } }),
  row('deepseek', 1, { mentioned: false, cited: false, rank: null, sov: 0, urls: ['https://lumen.example'], comps: { 'Northwind Ink': [1, 0.4], 'Lumen Sketch': [2, 0.35], 'Harbor Paint': [3, 0.25] } }),
  row('doubao', 1, { mentioned: true, cited: false, rank: 5, sov: 0.12, urls: ['https://northwind.example'], comps: { 'Northwind Ink': [1, 0.48], 'Harbor Paint': [2, 0.22], 'Lumen Sketch': [4, 0.18] } }),
  row('deepseek', 2, { mentioned: false, cited: false, rank: null, sov: 0, urls: ['https://northwind.example'], comps: { 'Northwind Ink': [1, 0.7], 'Lumen Sketch': [2, 0.3] } }),
  row('doubao', 2, { mentioned: false, cited: false, rank: null, sov: 0, urls: [], comps: { 'Northwind Ink': [1, 0.55], 'Lumen Sketch': [2, 0.25], 'Harbor Paint': [3, 0.2] } }),
  row('deepseek', 3, { mentioned: false, cited: false, rank: null, sov: 0, urls: ['https://harbor.example'], comps: { 'Lumen Sketch': [1, 0.4], 'Harbor Paint': [2, 0.35], 'Northwind Ink': [3, 0.25] } }),
  row('doubao', 3, { mentioned: false, cited: false, rank: null, sov: 0, urls: ['https://harbor.example'], comps: { 'Harbor Paint': [1, 0.42], 'Lumen Sketch': [2, 0.33], 'Northwind Ink': [3, 0.25] } }),
]

function row(platform, queryIndex, spec) {
  return { platform, queryIndex, ...spec }
}

function check(id, category, status, titleEn, titleZh, fixEn, fixZh) {
  return {
    id,
    category,
    title: tx(titleEn, titleZh),
    status,
    weight: CHECK_WEIGHTS[id],
    applicable: true,
    explanation: tx(`${ACME_SITE} — ${titleEn}`, `${ACME_SITE} — ${titleZh}`),
    fix: tx(fixEn, fixZh),
    verify: tx(`Re-open ${ACME_SITE} and re-run the audit.`, `重新打开 ${ACME_SITE}，再跑一次审计。`),
    evidence: asEvidence({}),
  }
}

function readinessReport(fetchedAt) {
  const report = buildReport({
    url: ACME_SITE,
    finalUrl: `${ACME_SITE}/`,
    fetchedAt,
    durationMs: 900,
    checks: [
      check('access.http', 'access', 'pass', 'Page responds', '页面可访问', 'No change.', '不用改。'),
      check('access.bot-ua', 'access', 'fail', 'Bot user-agent is blocked', '机器人 User-Agent 被拦', 'Allow GPTBot on the edge.', '在边缘放行 GPTBot。'),
      check('llms.txt', 'llms', 'warn', 'llms.txt is missing', '缺少 llms.txt', 'Publish /llms.txt.', '发布 /llms.txt。'),
      check('llms-full.txt', 'llms', 'warn', 'llms-full.txt is missing', '缺少 llms-full.txt', 'Optional.', '可选。'),
      check('page.jsonld', 'page', 'fail', 'JSON-LD is missing', '缺少 JSON-LD', 'Add Organization JSON-LD.', '加上 Organization JSON-LD。'),
      check('sitemap', 'sitemap', 'pass', 'Sitemap exists', '有站点地图', 'No change.', '不用改。'),
    ],
  })
  report.summary = {
    en: `${report.summary.en} ${NOTE_EN}`,
    zh: `${report.summary.zh}${NOTE_ZH}`,
  }
  return report
}

function silence(sample) {
  return { ...sample, mentioned: false, cited: false, rank: null, sov: 0 }
}

function rowsFor(preset) {
  if (preset === 'sparse') return CANONICAL.map((sample, index) => (index === 0 ? sample : silence(sample)))
  if (preset === 'low') return CANONICAL.map((sample, index) => (index < 2 ? sample : silence(sample)))
  if (preset === 'strong') {
    return CANONICAL.map((sample, index) => {
      if (index >= 5) return sample
      return { ...sample, mentioned: true, cited: index < 2, rank: index < 2 ? 2 : 3, sov: Math.max(sample.sov, 0.2) }
    })
  }
  return CANONICAL
}

function toSamples(queries, preset) {
  return rowsFor(preset).map((sample) => ({
    platform: sample.platform,
    query: queries[sample.queryIndex].text,
    ok: true,
    error: null,
    brandMentioned: sample.mentioned,
    brandCited: sample.cited,
    rankInAnswer: sample.rank,
    sovScore: sample.sov,
    citedUrls: sample.urls,
    competitors: COMPETITORS.map((brand) => {
      const hit = sample.comps[brand]
      return { brand, mentioned: Boolean(hit), rank: hit ? hit[0] : null, shareOfVoice: hit ? hit[1] : 0 }
    }),
  }))
}

function citationPillar(queries, preset) {
  const samples = toSamples(queries, preset)
  const mentionRate = samples.filter((sample) => sample.brandMentioned).length / samples.length
  const citationRate = samples.filter((sample) => sample.brandCited).length / samples.length
  const ranks = samples.map((sample) => sample.rankInAnswer).filter((rank) => rank != null && rank > 0)
  const meanRank = ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length
  const shareOfVoice = samples.reduce((sum, sample) => sum + sample.sovScore, 0) / samples.length
  const skipped = ['qwen', 'ernie', 'perplexity'].map((platform) => ({
    platform,
    reason: tx('No credentials configured for this engine.', '这个引擎还没有配置凭证。'),
  }))
  const ok = samples.filter((sample) => sample.ok)
  return {
    status: 'SUCCEEDED',
    score: citationPillarScore({ mentionRate, citationRate, meanRank }),
    queries: queries.map((query) => {
      const mine = ok.filter((sample) => sample.query === query.text)
      const queryRanks = mine.map((sample) => sample.rankInAnswer).filter((rank) => rank != null && rank > 0)
      return {
        ...query,
        language: 'zh',
        source: 'user',
        samples: mine.length,
        mentions: mine.filter((sample) => sample.brandMentioned).length,
        citations: mine.filter((sample) => sample.brandCited).length,
        meanRank: queryRanks.length > 0 ? queryRanks.reduce((sum, rank) => sum + rank, 0) / queryRanks.length : null,
      }
    }),
    querySource: querySourceOf(queries.map((query) => ({ ...query, language: 'zh', source: 'user' }))),
    enginesRun: ['deepseek', 'doubao'],
    enginesSkipped: skipped,
    mentionRate,
    citationRate,
    meanRank,
    shareOfVoice,
    citedUrls: [...new Set(samples.flatMap((sample) => sample.citedUrls))],
    brandCitedUrls: [ACME_SITE],
    competitorSov: COMPETITORS.map((brand) => {
      const rows = ok.map((sample) => sample.competitors.find((item) => item.brand === brand)).filter(Boolean)
      const mentioned = rows.filter((item) => item.mentioned).length
      const share = rows.reduce((sum, item) => sum + item.shareOfVoice, 0)
      return { brand, mentionRate: mentioned / ok.length, shareOfVoice: share / ok.length }
    }),
    samples,
    note: tx(`${QUERY_FALLBACK_NOTE.user.en} ${NOTE_EN}`, `${QUERY_FALLBACK_NOTE.user.zh}${NOTE_ZH}`),
    error: null,
  }
}

function citability() {
  const pages = [
    {
      url: `${ACME_SITE}/`,
      title: 'Acme Draw 首页',
      atomScore: 42,
      citabilityScore: 38,
      weakestAtoms: [{ text: '我们的画板很好用，欢迎试用。', score: 22, missing: ['definition', 'numeric', 'entity'] }],
    },
    {
      url: `${ACME_SITE}/pricing`,
      title: '定价',
      atomScore: 61,
      citabilityScore: 55,
      weakestAtoms: [{ text: '团队版请联系销售。', score: 30, missing: ['numeric'] }],
    },
  ].map((page) => ({ ...page, composite: pageComposite(page.atomScore, page.citabilityScore), fetchError: null }))
  const weakestPages = [...pages].sort((a, b) => a.composite - b.composite)
  return {
    status: 'SUCCEEDED',
    score: Math.round(pages.reduce((sum, page) => sum + page.composite, 0) / pages.length),
    pages,
    weakestPages,
    note: tx(`Sampled ${pages.length} fictional pages. ${NOTE_EN}`, `抽了 ${pages.length} 个虚构页面。${NOTE_ZH}`),
    error: null,
  }
}

function runInput() {
  return {
    workspaceId: 'demo',
    brandName: ACME_BRAND,
    siteUrl: ACME_SITE,
    industry: ACME_INDUSTRY,
    competitors: [...COMPETITORS],
    userQueries: QUERIES.map((query) => query.text),
    language: 'zh',
  }
}

function buildAt(generatedAt, preset) {
  const input = runInput()
  const queries = QUERIES.map((query) => ({ ...query, language: 'zh', source: 'user' }))
  const readiness = readinessReport(new Date(generatedAt.getTime() - 30_000).toISOString())
  const pillars = {
    agentReadiness: { status: 'SUCCEEDED', score: readiness.score, report: readiness, error: null },
    citations: citationPillar(queries, preset),
    citability: citability(),
    structuredSignals: runStructuredSignals(input, readiness),
  }
  const concluded = conclude(input, pillars, generatedAt)
  return {
    health: concluded.report,
    healthStatus: concluded.status,
    userQueries: input.userQueries,
    competitors: input.competitors,
  }
}

const SERIES = [
  { daysAgo: 27, trigger: 'MANUAL', preset: 'sparse' },
  { daysAgo: 20, trigger: 'SCHEDULED', preset: 'low' },
  { daysAgo: 13, trigger: 'SCHEDULED', preset: 'strong' },
  { daysAgo: 0.05, trigger: 'SCHEDULED', preset: 'canonical' },
]

/** Four fictional Acme Draw checks, oldest first. The latest falls back from the peak. */
export function buildAcmeDrawSeries(options = {}) {
  const now = options.now ?? new Date()
  return SERIES.map((item) => {
    const generatedAt = new Date(now.getTime() - item.daysAgo * 86400000)
    return { ...item, generatedAt, ...buildAt(generatedAt, item.preset) }
  })
}
