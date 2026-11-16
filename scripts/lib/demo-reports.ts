// 演示用的 Agent 就绪审计 + GEO 体检报告。
//
// 品牌 ZoomerAI / zoomer.top 是虚构的。分数不手写：检查项交给 Agent 就绪的
// buildReport，结构化信号交给 runStructuredSignals，总分和行动清单交给 conclude。
// 引用快照与页面分数是写死的虚构样本，但提及率、排名分、页面综合分走产品里的同一套公式。

import { AI_CRAWLERS } from '../../src/modules/agent-readiness/bots.js'
import { buildReport } from '../../src/modules/agent-readiness/score.js'
import { asEvidence, tx } from '../../src/modules/agent-readiness/types.js'
import { CHECK_WEIGHTS } from '../../src/modules/agent-readiness/weights.js'
import { conclude } from '../../src/modules/geo-health/orchestrator.js'
import { QUERY_FALLBACK_NOTE, querySourceOf } from '../../src/modules/geo-health/queries.js'
import { citationPillarScore, pageComposite } from '../../src/modules/geo-health/score.js'
import { runStructuredSignals } from '../../src/modules/geo-health/signals.js'

export const DEMO_BRAND = 'ZoomerAI'
export const DEMO_SITE = 'https://zoomer.top'
export const DEMO_INDUSTRY = 'AI 图像生成'

const FICTIONAL_EN = 'Fictional demo data for the ZoomerAI walkthrough, not a live fetch or a live engine response.'
const FICTIONAL_ZH = '这是 ZoomerAI 演示用的虚构数据，不是一次真实抓取，也不是引擎的真实返回。'

/** 训练爬虫拒绝不计分；360Spider 单独 Disallow，用来照亮「只挡一家中文引擎」的警告。 */
const ROBOTS_DENIED = new Set([
  'GPTBot',
  'ClaudeBot',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
  'Bytespider',
  'Meta-ExternalAgent',
  '360Spider',
])

const QUERIES = [
  { text: 'ZoomerAI 是什么', kind: 'brand' },
  { text: '国内好用的 AI 画图工具有哪些', kind: 'category' },
  { text: 'Midjourney 有没有好用的中文替代', kind: 'comparison' },
  { text: '免费的 AI 绘画软件推荐', kind: 'category' },
]

const COMPETITORS = ['Midjourney', '即梦', '文心一格', 'LiblibAI']

/**
 * 每个样本是「一个引擎、一个问题、一次回答」。
 * mentioned / rank / cited 决定品牌指标；competitors 决定声量对照。
 * share 是该答案里这个名字的精确份额，品牌自己的份额在 sov 字段。
 */
const SAMPLES = [
  row('deepseek', 0, { mentioned: true, cited: true, rank: 2, sov: 0.22, urls: ['https://zoomer.top', 'https://www.midjourney.com'], comps: { Midjourney: [1, 0.45], 即梦: [3, 0.18] } }),
  row('doubao', 0, { mentioned: true, cited: false, rank: 4, sov: 0.18, urls: ['https://www.midjourney.com'], comps: { Midjourney: [1, 0.5], 即梦: [2, 0.32] } }),
  row('deepseek', 1, { mentioned: false, cited: false, rank: null, sov: 0, urls: ['https://jimeng.jianying.com'], comps: { Midjourney: [1, 0.4], 即梦: [2, 0.35], 文心一格: [3, 0.25] } }),
  row('doubao', 1, { mentioned: true, cited: false, rank: 5, sov: 0.12, urls: ['https://www.midjourney.com'], comps: { Midjourney: [1, 0.48], 文心一格: [2, 0.22], LiblibAI: [4, 0.18] } }),
  row('deepseek', 2, { mentioned: false, cited: false, rank: null, sov: 0, urls: ['https://www.midjourney.com'], comps: { Midjourney: [1, 0.7], 即梦: [2, 0.3] } }),
  row('doubao', 2, { mentioned: false, cited: false, rank: null, sov: 0, urls: [], comps: { Midjourney: [1, 0.55], 即梦: [2, 0.25], LiblibAI: [3, 0.2] } }),
  row('deepseek', 3, { mentioned: false, cited: false, rank: null, sov: 0, urls: ['https://www.liblib.art'], comps: { 即梦: [1, 0.4], LiblibAI: [2, 0.35], 文心一格: [3, 0.25] } }),
  row('doubao', 3, { mentioned: false, cited: false, rank: null, sov: 0, urls: ['https://www.liblib.art'], comps: { LiblibAI: [1, 0.42], 即梦: [2, 0.33], 文心一格: [3, 0.25] } }),
]

function row(platform, queryIndex, spec) {
  return { platform, queryIndex, ...spec }
}

function check(id, category, status, titleEn, titleZh, explanationEn, explanationZh, fixEn, fixZh, verifyEn, verifyZh, evidence, applicable = true) {
  return {
    id,
    category,
    title: tx(titleEn, titleZh),
    status,
    weight: CHECK_WEIGHTS[id],
    applicable,
    explanation: tx(explanationEn, explanationZh),
    fix: tx(fixEn, fixZh),
    verify: tx(verifyEn, verifyZh),
    evidence: asEvidence(evidence),
  }
}

function botRows() {
  return AI_CRAWLERS.map((bot) => {
    const denied = ROBOTS_DENIED.has(bot.token)
    return {
      token: bot.token,
      vendor: bot.vendor,
      role: bot.role,
      allowed: !denied,
      source: denied ? 'group' : 'default',
      matchedRule: denied ? 'Disallow: /' : null,
    }
  })
}

function readinessChecks() {
  const bots = botRows()
  return [
    check(
      'access.http', 'access', 'pass',
      'Page responds to a browser', '页面对浏览器可访问',
      'https://zoomer.top returned HTTP 200 in 180ms, with one redirect.',
      'https://zoomer.top 在 180ms 内返回 HTTP 200，中间有一次跳转。',
      'No change required.', '无需修改。',
      'curl -sI https://zoomer.top ends on HTTP 200. Re-run the audit.',
      'curl -sI https://zoomer.top 最终是 HTTP 200。然后重新审计。',
      { status: 200, durationMs: 180, redirects: 1 },
    ),
    check(
      'access.bot-ua', 'access', 'fail',
      'AI crawler user-agents are not blocked', 'AI 爬虫 User-Agent 未被拦截',
      'GPTBot got HTTP 403, while a browser user-agent got HTTP 200. A WAF or bot rule is turning AI crawlers away. ClaudeBot got HTTP 200.',
      'GPTBot 得到 HTTP 403，而浏览器 User-Agent 得到 HTTP 200。WAF 或机器人规则正在把 AI 爬虫挡在外面。ClaudeBot 得到 HTTP 200。',
      'Allow the GPTBot user-agent through the WAF. Keep a separate robots.txt policy if you only want to opt out of training.',
      '在 WAF 上放行 GPTBot。如果只想拒绝训练，用 robots.txt 单独表达，不要在 WAF 上直接 403。',
      'curl -sI -A "GPTBot" https://zoomer.top returns the same status as a browser curl. Re-run the audit.',
      'curl -sI -A "GPTBot" https://zoomer.top 的状态码应与浏览器 curl 相同。然后重新审计。',
      {
        browserStatus: 200,
        browserDurationMs: 180,
        bots: [
          { token: 'GPTBot', status: 403, durationMs: 90, error: null },
          { token: 'ClaudeBot', status: 200, durationMs: 210, error: null },
        ],
      },
    ),
    check(
      'robots.reachable', 'robots', 'pass',
      'robots.txt can be fetched', 'robots.txt 可抓取',
      '/robots.txt returned HTTP 200 and plain text.',
      '/robots.txt 返回 HTTP 200，内容是纯文本。',
      'No change required.', '无需修改。',
      'Open https://zoomer.top/robots.txt and confirm it is text, not an HTML error page.',
      '打开 https://zoomer.top/robots.txt，确认是文本而不是 HTML 错误页。',
      { status: 200, contentType: 'text/plain' },
    ),
    check(
      'robots.answer-bots', 'robots', 'pass',
      'Answer-engine crawlers are allowed', '回答引擎爬虫被放行',
      'Answer crawlers are allowed for this path. Training opt-out is allowed and does not change this check: GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, CCBot, Bytespider, Meta-ExternalAgent.',
      '该路径放行了回答引擎爬虫。训练爬虫的拒绝不会拉低本项：GPTBot、ClaudeBot、Google-Extended、Applebot-Extended、CCBot、Bytespider、Meta-ExternalAgent。',
      'No change required. Keep training opt-outs if you want them.',
      '无需修改。训练爬虫如需拒绝，可以继续 Disallow。',
      'Re-fetch /robots.txt and confirm OAI-SearchBot, ChatGPT-User, Claude-User, Claude-SearchBot, PerplexityBot, Perplexity-User, and Amazonbot are not Disallow: /.',
      '重新抓取 /robots.txt，确认 OAI-SearchBot、ChatGPT-User、Claude-User、Claude-SearchBot、PerplexityBot、Perplexity-User、Amazonbot 没有 Disallow: /。',
      { bots, trainingOptOut: [...ROBOTS_DENIED].filter((token) => token !== '360Spider') },
    ),
    check(
      'robots.search-bots', 'robots', 'warn',
      'Search crawlers are allowed', '搜索爬虫被放行',
      'Blocked search crawlers: 360Spider. Googlebot and Bingbot are still allowed, so this is a warning rather than a failure.',
      '被禁止的搜索爬虫：360Spider。Googlebot 和 Bingbot 仍然放行，所以这是警告而不是未通过。',
      'Allow 360Spider. Do not confuse Google-Extended (training opt-out) with Googlebot (search).',
      '放行 360Spider。不要把 Google-Extended（训练 opt-out）和 Googlebot（搜索）写成同一条规则。',
      'In robots.txt, the 360Spider group does not contain Disallow: /. Re-run the audit.',
      'robots.txt 里 360Spider 分组没有 Disallow: /。重新审计。',
      { bots: bots.filter((bot) => bot.role === 'search') },
    ),
    check(
      'llms.txt', 'llms', 'warn',
      'llms.txt is present and valid', 'llms.txt 存在且格式有效',
      'https://zoomer.top/llms.txt returned HTTP 404. A missing file warns: major answer engines have not confirmed they consume it.',
      'https://zoomer.top/llms.txt 返回 HTTP 404。文件缺失记为警告：主流回答引擎还没有确认会读取它。',
      'Publish an llms.txt with an H1, a blockquote summary, and one H2 section of markdown links. The health report can generate a starter file.',
      '发布一份 llms.txt：一级标题、一段引言摘要，外加一节带 Markdown 链接的二级标题。体检报告可以生成一份起步稿。',
      'Open /llms.txt and confirm the H1, the summary, and one list of links. Re-run the audit.',
      '打开 /llms.txt，确认有一级标题、摘要和一组链接。然后重新审计。',
      { status: 404, url: 'https://zoomer.top/llms.txt' },
    ),
    check(
      'llms-full.txt', 'llms', 'warn',
      'llms-full.txt is available', 'llms-full.txt 可获取',
      'https://zoomer.top/llms-full.txt returned HTTP 404. The companion file is optional, so a miss warns and does not fail the audit.',
      'https://zoomer.top/llms-full.txt 返回 HTTP 404。这个伴随文件是可选的，缺失只警告，不让整次审计失败。',
      'Optional. Publish llms-full.txt only if you want a single concatenated copy of the linked pages.',
      '可选。只有在你想提供一份拼好的长文时才发布 llms-full.txt。',
      'Open /llms-full.txt. Re-run the audit.',
      '打开 /llms-full.txt。然后重新审计。',
      { status: 404, url: 'https://zoomer.top/llms-full.txt' },
    ),
    check(
      'llms.links', 'llms', 'warn',
      'llms.txt links resolve', 'llms.txt 链接可访问',
      'Skipped because llms.txt is missing, so there are no links to probe. This check is not scored.',
      'llms.txt 不存在，没有链接可探测，本项不计入分数。',
      'Publish llms.txt first, then re-run.',
      '先发布 llms.txt，再重新审计。',
      'After llms.txt exists, a sample of its links returns HTTP 2xx or 3xx.',
      'llms.txt 出现后，抽查其中的链接应返回 HTTP 2xx 或 3xx。',
      { reason: 'llms.txt missing' },
      false,
    ),
    check(
      'sitemap', 'sitemap', 'pass',
      'XML sitemap is discoverable', 'XML 站点地图可被发现',
      'Found https://zoomer.top/sitemap.xml from the Sitemap: directive in robots.txt. It parsed, with a homepage, a features page, and a pricing page.',
      '从 robots.txt 的 Sitemap: 指令找到 https://zoomer.top/sitemap.xml。解析成功，里面有首页、功能页和定价页。',
      'No change required.', '无需修改。',
      'Open /sitemap.xml and confirm the URLs you want cited are listed. Re-run the audit.',
      '打开 /sitemap.xml，确认你希望被引用的 URL 都在里面。然后重新审计。',
      { url: 'https://zoomer.top/sitemap.xml', urlCount: 4 },
    ),
    check(
      'page.jsonld', 'page', 'fail',
      'Schema.org JSON-LD is present', '存在 Schema.org JSON-LD',
      'The raw HTML of https://zoomer.top has no script type="application/ld+json".',
      'https://zoomer.top 的网页源代码里没有 script type="application/ld+json"。',
      'Add Organization and WebSite JSON-LD to the homepage. View source, not the DOM inspector. The health report can generate a starter file.',
      '在首页加上 Organization 和 WebSite 的 JSON-LD。看网页源代码，不要看 DOM 检查器。体检报告可以生成一份起步稿。',
      'View source and confirm a script type="application/ld+json" is in the HTML. Re-run the audit.',
      '查看源代码，确认 HTML 里有 script type="application/ld+json"。然后重新审计。',
      { blocks: 0, parseErrors: 0, types: [], supported: [], deprecated: [], unknown: [] },
    ),
    check(
      'page.meta-description', 'page', 'warn',
      'Meta description is usable', 'meta description 可用',
      'Meta description is 18 characters. Aim for 50–160 so it is specific without being truncated.',
      'meta description 有 18 个字符。建议 50–160，既具体又不会被截断。',
      'Rewrite the description into that range and keep the brand name in the sentence.',
      '把描述改到这个长度，并在句子里保留品牌名。',
      'curl -s the page and grep name="description". Re-run the audit.',
      'curl -s 页面并 grep name="description"。然后重新审计。',
      { length: 18, present: true, sample: 'ZoomerAI 是一款 AI 画图产品。' },
    ),
    check(
      'page.canonical', 'page', 'pass',
      'Canonical URL is set', '已设置 canonical',
      'One rel=canonical points at https://zoomer.top/.',
      '有一条 rel=canonical，指向 https://zoomer.top/。',
      'No change required.', '无需修改。',
      'View source and confirm a single rel=canonical. Re-run the audit.',
      '查看源代码，确认只有一条 rel=canonical。然后重新审计。',
      { href: 'https://zoomer.top/' },
    ),
    check(
      'page.lang', 'page', 'pass',
      'Page declares a language', '页面声明了语言',
      'html lang is zh-CN.',
      'html lang 是 zh-CN。',
      'No change required.', '无需修改。',
      'View source and confirm <html lang>. Re-run the audit.',
      '查看源代码，确认有 <html lang>。然后重新审计。',
      { lang: 'zh-CN' },
    ),
    check(
      'page.open-graph', 'page', 'warn',
      'Open Graph title and description', 'Open Graph 标题与描述',
      'og:title is present. og:description is missing, so link previews and some scrapers fall back to other text.',
      '有 og:title，没有 og:description。链接预览和部分抓取器只能退回页面里的其它文字。',
      'Add og:title and og:description. Keep the brand name in both.',
      '补上 og:title 和 og:description，两边都带上品牌名。',
      'View source and confirm both meta properties. Re-run the audit.',
      '查看源代码，确认这两个 meta。然后重新审计。',
      { title: 'ZoomerAI', description: null },
    ),
    check(
      'page.ssr-text', 'page', 'pass',
      'Server-rendered text is visible', '服务端直出的可见文本',
      'The raw HTML contains a few short paragraphs. It is not an empty JavaScript shell, but the sentences are thin.',
      '网页源代码里有几段短文字。它不是一个空的 JavaScript 壳，但句子很薄。',
      'No change required for this check. The citability pillar covers how quotable those sentences are.',
      '这一项不用改。句子好不好引用，由可引用性支柱来评。',
      'View source and confirm the main sentences are in the HTML, not only after hydration. Re-run the audit.',
      '查看源代码，确认主要句子在 HTML 里，而不是水合之后才出现。然后重新审计。',
      { characters: 420 },
    ),
    check(
      'page.robots-directives', 'page', 'pass',
      'Page is indexable', '页面允许索引',
      'No noindex in the meta robots tag or X-Robots-Tag.',
      'meta robots 和 X-Robots-Tag 里都没有 noindex。',
      'No change required.', '无需修改。',
      'View source and the response headers. Re-run the audit.',
      '查看源代码和响应头。然后重新审计。',
      { noindex: false, nosnippet: false },
    ),
    check(
      'markdown', 'markdown', 'warn',
      'Markdown is available to agents', '可为 Agent 提供 Markdown',
      'Accept: text/markdown and https://zoomer.top/index.md both missed. Agents can still read the HTML.',
      'Accept: text/markdown 和 https://zoomer.top/index.md 都没有命中。Agent 仍然可以读 HTML。',
      'Optional. Serve markdown for the same URL, or publish a sibling .md file.',
      '可选。同一 URL 上提供 markdown，或者放一个同名的 .md 文件。',
      'curl -sH "Accept: text/markdown" https://zoomer.top returns markdown, or /index.md does. Re-run the audit.',
      'curl -sH "Accept: text/markdown" https://zoomer.top 返回 markdown，或者 /index.md 可以打开。然后重新审计。',
      { contentNegotiation: 406, siblingStatus: 404 },
    ),
  ]
}

function buildReadinessReport(fetchedAt) {
  const report = buildReport({
    url: DEMO_SITE,
    finalUrl: `${DEMO_SITE}/`,
    fetchedAt,
    durationMs: 2400,
    checks: readinessChecks(),
  })
  report.summary = {
    en: `${report.summary.en} ${FICTIONAL_EN}`,
    zh: `${report.summary.zh}${FICTIONAL_ZH}`,
  }
  return report
}

function healthQueries() {
  return QUERIES.map((query) => ({
    text: query.text,
    kind: query.kind,
    language: 'zh',
    source: 'user',
  }))
}

function citationSamples(queries) {
  return SAMPLES.map((sample) => ({
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
      return {
        brand,
        mentioned: Boolean(hit),
        rank: hit ? hit[0] : null,
        shareOfVoice: hit ? hit[1] : 0,
      }
    }),
  }))
}

function rollup(queries, samples) {
  return queries.map((query) => {
    const mine = samples.filter((sample) => sample.ok && sample.query === query.text)
    const ranks = mine.map((sample) => sample.rankInAnswer).filter((rank) => rank != null && rank > 0)
    return {
      ...query,
      samples: mine.length,
      mentions: mine.filter((sample) => sample.brandMentioned).length,
      citations: mine.filter((sample) => sample.brandCited).length,
      meanRank: ranks.length > 0 ? ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length : null,
    }
  })
}

function competitorSov(samples) {
  const ok = samples.filter((sample) => sample.ok)
  return COMPETITORS.map((brand) => {
    const rows = ok.map((sample) => sample.competitors.find((item) => item.brand === brand)).filter(Boolean)
    const mentioned = rows.filter((item) => item.mentioned).length
    const share = rows.reduce((sum, item) => sum + item.shareOfVoice, 0)
    return {
      brand,
      mentionRate: mentioned / ok.length,
      shareOfVoice: share / ok.length,
    }
  })
}

function citationPillar(queries) {
  const samples = citationSamples(queries)
  const mentionRate = samples.filter((sample) => sample.brandMentioned).length / samples.length
  const citationRate = samples.filter((sample) => sample.brandCited).length / samples.length
  const ranks = samples.map((sample) => sample.rankInAnswer).filter((rank) => rank != null && rank > 0)
  const meanRank = ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length
  const shareOfVoice = samples.reduce((sum, sample) => sum + sample.sovScore, 0) / samples.length
  const skipped = ['qwen', 'ernie', 'perplexity', 'chatgpt', 'gemini'].map((platform) => ({
    platform,
    reason: tx(
      'No credentials configured for this engine.',
      '这个引擎还没有配置凭证。',
    ),
  }))
  return {
    status: 'SUCCEEDED',
    score: citationPillarScore({ mentionRate, citationRate, meanRank }),
    queries: rollup(queries, samples),
    querySource: querySourceOf(queries),
    enginesRun: ['deepseek', 'doubao'],
    enginesSkipped: skipped,
    mentionRate,
    citationRate,
    meanRank,
    shareOfVoice,
    citedUrls: [...new Set(samples.flatMap((sample) => sample.citedUrls))],
    brandCitedUrls: ['https://zoomer.top'],
    competitorSov: competitorSov(samples),
    samples,
    note: tx(
      `${QUERY_FALLBACK_NOTE.user.en} ${FICTIONAL_EN}`,
      `${QUERY_FALLBACK_NOTE.user.zh}${FICTIONAL_ZH}`,
    ),
    error: null,
  }
}

function page(url, title, atomScore, citabilityScore, atoms) {
  return {
    url,
    title,
    atomScore,
    citabilityScore,
    composite: pageComposite(atomScore, citabilityScore),
    weakestAtoms: atoms,
    fetchError: null,
  }
}

function citabilityPillar() {
  const pages = [
    page('https://zoomer.top/', 'ZoomerAI 首页', 42, 38, [
      { text: '我们的产品很好用，欢迎体验。', score: 22, missing: ['definition', 'numeric', 'entity'] },
      { text: '我们提供 AI 画图功能，可以帮助用户快速生成图片。', score: 35, missing: ['numeric', 'selfContained'] },
    ]),
    page('https://zoomer.top/features', '功能', 48, 44, [
      { text: '画布编辑器：可以拖拽编辑。', score: 28, missing: ['selfContained', 'definition'] },
      { text: 'AI 生成：支持文生图。', score: 31, missing: ['entity', 'numeric'] },
    ]),
    page('https://zoomer.top/pricing', '定价', 61, 55, [
      { text: '团队版：联系销售。', score: 30, missing: ['numeric'] },
    ]),
  ]
  const score = Math.round(pages.reduce((sum, item) => sum + item.composite, 0) / pages.length)
  const weakestPages = [...pages].sort((a, b) => a.composite - b.composite || a.url.localeCompare(b.url))
  return {
    status: 'SUCCEEDED',
    score,
    pages,
    weakestPages,
    note: tx(
      `Scored the homepage and ${pages.length - 1} other page(s) from the sitemap (cap 5). ${FICTIONAL_EN}`,
      `评了首页，以及站点地图里的另外 ${pages.length - 1} 页（上限 5 页）。${FICTIONAL_ZH}`,
    ),
    error: null,
  }
}

function runInput() {
  return {
    workspaceId: 'demo',
    brandName: DEMO_BRAND,
    siteUrl: DEMO_SITE,
    industry: DEMO_INDUSTRY,
    competitors: [...COMPETITORS],
    userQueries: QUERIES.map((query) => query.text),
    language: 'zh',
  }
}

/**
 * @param {{ fetchedAt?: string, generatedAt?: Date }} [options]
 * @returns {{ readiness: import('../../src/modules/agent-readiness/types.js').AgentReadinessReport, health: import('../../src/modules/geo-health/types.js').GeoHealthReport, healthStatus: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' }}
 */
export function buildDemoReports(options = {}) {
  const generatedAt = options.generatedAt ?? new Date()
  const fetchedAt = options.fetchedAt ?? new Date(generatedAt.getTime() - 30_000).toISOString()
  const input = runInput()
  const readiness = buildReadinessReport(fetchedAt)
  const queries = healthQueries()
  const pillars = {
    agentReadiness: {
      status: 'SUCCEEDED',
      score: readiness.score,
      report: readiness,
      error: null,
    },
    citations: citationPillar(queries),
    citability: citabilityPillar(),
    structuredSignals: runStructuredSignals(input, readiness),
  }
  const concluded = conclude(input, pillars, generatedAt)
  return {
    readiness,
    health: concluded.report,
    healthStatus: concluded.status,
    userQueries: input.userQueries,
    competitors: input.competitors,
  }
}
