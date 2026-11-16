import { tx } from '../agent-readiness/types.js'
import type { AgentReadinessFix } from '../agent-readiness/types.js'
import { effortLabel, impactBand } from './score.js'
import type {
  AgentReadinessPillar,
  CitationPillar,
  CitabilityPillar,
  EffortLevel,
  GeoHealthAction,
  QueryRollup,
  StructuredSignalsPillar,
} from './types.js'
import { ACTION_CAP } from './weights.js'

const EASY_CHECKS = new Set([
  'robots.reachable',
  'robots.answer-bots',
  'robots.search-bots',
  'llms.txt',
  'llms-full.txt',
  'llms.links',
  'page.jsonld',
  'page.meta-description',
  'page.canonical',
  'page.lang',
  'page.open-graph',
  'page.robots-directives',
])

const HARD_CHECKS = new Set(['access.bot-ua'])

function effortForCheck(id: string): EffortLevel {
  if (HARD_CHECKS.has(id)) return 3
  if (EASY_CHECKS.has(id)) return 1
  return 2
}

function splitFix(query: string | null, fix: { en: string; zh: string }) {
  return {
    fix,
    verify: query
      ? tx(
        `Re-run this question and compare mention, citation, and rank: “${query}”.`,
        `重跑这个问题，对比提及、引用和排名：「${query}」。`,
      )
      : tx('Re-run the health check and compare this pillar.', '重新体检，对比这一支柱的分数。'),
    verifyQuery: query,
  }
}

function worstQuery(queries: QueryRollup[], prefer: (query: QueryRollup) => number): string | null {
  const ranked = [...queries].sort((a, b) => prefer(a) - prefer(b) || a.text.localeCompare(b.text))
  return ranked[0]?.text ?? null
}

function action(partial: Omit<GeoHealthAction, 'effortLabel'>): GeoHealthAction {
  return { ...partial, effortLabel: effortLabel(partial.effort) }
}

export function buildActions(input: {
  readiness: AgentReadinessPillar
  citations: CitationPillar
  citability: CitabilityPillar
  signals: StructuredSignalsPillar
}): GeoHealthAction[] {
  const actions: GeoHealthAction[] = []
  const covered = new Set<string>()

  for (const fix of input.readiness.report?.fixes ?? []) {
    covered.add(fix.checkId)
    actions.push(readinessAction(fix))
  }

  const queries = input.citations.queries
  const rerun = worstQuery(queries, (query) => {
    if (query.samples === 0) return 1
    return query.mentions / query.samples
  })

  if (input.citations.enginesRun.length === 0) {
    actions.push(action({
      id: 'citations:engines',
      pillar: 'citations',
      title: tx('Configure at least one answer engine', '至少配置一个回答引擎'),
      impact: 'medium',
      effort: 1,
      fix: tx(
        'Add an API key for one registered engine (DeepSeek, Doubao, Qwen, ERNIE, Perplexity, ChatGPT Search, or Gemini) in workspace settings, then run the health check again.',
        '在工作区设置里给一个已注册的引擎（DeepSeek、豆包、通义千问、文心一言、Perplexity、ChatGPT Search 或 Gemini）加上 API Key，然后重新体检。',
      ),
      verify: tx(
        'The next report should list that engine under “engines run”, not under “skipped”.',
        '下一份报告里，这个引擎应出现在「已跑」而不是「已跳过」。',
      ),
      verifyQuery: null,
    }))
  } else if (input.citations.mentionRate != null && input.citations.mentionRate < 0.5) {
    const line = splitFix(rerun, tx(
      'Publish a page that answers the question in the first paragraph, with the brand, a definition, and one verifiable number.',
      '发一页能直接回答这个问题的内容：第一段写出品牌、定义和一句可核对的数字。',
    ))
    actions.push(action({
      id: 'citations:mention',
      pillar: 'citations',
      title: tx('Get the brand mentioned on the weakest question', '让品牌出现在最弱的问题上'),
      impact: 'high',
      effort: 3,
      ...line,
    }))
  }

  if (
    input.citations.citationRate != null &&
    input.citations.citationRate < 0.3 &&
    (input.citations.mentionRate ?? 0) > input.citations.citationRate
  ) {
    const citedQuery = queries.find((query) => query.mentions > query.citations)?.text ?? rerun
    const line = splitFix(citedQuery, tx(
      'The brand is named, but the official URL is rarely the source. Add a citable page and make sure the answer can link to it.',
      '品牌被点到了名字，但官网很少成为来源。补一页可引用的内容，并让答案能链到它。',
    ))
    actions.push(action({
      id: 'citations:cite',
      pillar: 'citations',
      title: tx('Turn mentions into citations of the official site', '把提及变成对官网的引用'),
      impact: 'medium',
      effort: 2,
      ...line,
    }))
  }

  if (input.citations.meanRank != null && input.citations.meanRank > 3) {
    const late = [...queries].sort((a, b) => (b.meanRank ?? 0) - (a.meanRank ?? 0))[0]?.text ?? rerun
    const line = splitFix(late, tx(
      'Open the answer with a one-sentence definition of the brand so it is the first entity, not a footnote.',
      '用一句话定义品牌作为开头，让它成为答案里的第一个实体，而不是附注。',
    ))
    actions.push(action({
      id: 'citations:rank',
      pillar: 'citations',
      title: tx('Move the brand earlier in the answer', '让品牌在答案里更靠前'),
      impact: 'medium',
      effort: 2,
      ...line,
    }))
  }

  const weakest = input.citability.weakestPages[0]
  if (weakest && weakest.fetchError == null && weakest.composite < 70) {
    const gap = weakest.weakestAtoms[0]
    const gapText = gap ? ` “${gap.text}”` : ''
    const related = queries.find((query) => query.kind === 'category')?.text
      ?? queries.find((query) => query.kind === 'brand')?.text
      ?? rerun
    const line = splitFix(related, tx(
      `Rewrite the weakest passage on ${weakest.url}.${gapText} Add a definition, one number, and a named entity.`,
      `改写 ${weakest.url} 上最弱的一段。${gapText}补上定义、一个数字和一个实体名。`,
    ))
    actions.push(action({
      id: `citability:${weakest.url}`,
      pillar: 'citability',
      title: tx('Rewrite the least citable page', '改写最不可引用的页面'),
      impact: weakest.composite < 40 ? 'high' : 'medium',
      effort: 2,
      ...line,
    }))
  }

  if (!covered.has('llms.txt') && input.signals.llmsTxtStatus !== 'pass' && input.signals.generatedLlmsTxt) {
    actions.push(action({
      id: 'signals:llms',
      pillar: 'structuredSignals',
      title: tx('Publish the generated llms.txt', '发布已生成的 llms.txt'),
      impact: input.signals.llmsTxtStatus === 'fail' ? 'medium' : 'low',
      effort: 1,
      fix: tx(
        'Download the generated llms.txt from this report and publish it at /llms.txt. Major answer engines have not confirmed they fetch it; ship it so the file is there when they do.',
        '从这份报告下载生成的 llms.txt，放到网站的 /llms.txt。主流回答引擎还没有确认会抓它；先放上，等它们抓的时候文件已经在。',
      ),
      verify: tx(
        'Open /llms.txt and confirm the H1, the blockquote summary, and one list of links. Re-run the health check.',
        '打开 /llms.txt，确认有一级标题、一段引言摘要和一组链接。然后重新体检。',
      ),
      verifyQuery: null,
    }))
  }

  if (!covered.has('page.jsonld') && !input.signals.jsonLdPresent && input.signals.generatedJsonLd) {
    actions.push(action({
      id: 'signals:jsonld',
      pillar: 'structuredSignals',
      title: tx('Add the generated Organization JSON-LD', '加上已生成的 Organization JSON-LD'),
      impact: 'medium',
      effort: 1,
      fix: tx(
        'Download the generated JSON-LD and paste the Organization and WebSite objects into the homepage as application/ld+json. View source, not the DOM inspector.',
        '下载生成的 JSON-LD，把 Organization 和 WebSite 以 application/ld+json 放进首页。看网页源代码，不要看 DOM 检查器。',
      ),
      verify: tx(
        'View source and confirm a script type="application/ld+json" is in the HTML. Re-run the health check.',
        '查看源代码，确认 HTML 里有 script type="application/ld+json"。然后重新体检。',
      ),
      verifyQuery: rerun,
    }))
  }

  const rank = { high: 3, medium: 2, low: 1 } as const
  return actions
    .sort((a, b) => rank[b.impact] - rank[a.impact] || a.effort - b.effort || a.id.localeCompare(b.id))
    .slice(0, ACTION_CAP)
}

function readinessAction(fix: AgentReadinessFix): GeoHealthAction {
  return action({
    id: `readiness:${fix.checkId}`,
    pillar: 'agentReadiness',
    title: fix.title,
    impact: impactBand(fix.impact),
    effort: effortForCheck(fix.checkId),
    fix: fix.fix,
    verify: fix.verify,
    verifyQuery: null,
  })
}
