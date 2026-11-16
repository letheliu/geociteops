import { describe, expect, it } from 'vitest'
import type { FetchOutcome } from '../agent-readiness/safe-fetch.js'
import type { AgentReadinessReport } from '../agent-readiness/types.js'
import { selectPageUrls } from './citability.js'
import { renderMarkdown } from './export.js'
import { conclude, runPillar } from './orchestrator.js'
import type { GeoHealthRunDeps } from './orchestrator.js'
import type { GeoHealthRunInput } from './run-input.js'
import { PILLAR_IDS } from './types.js'

const input: GeoHealthRunInput = {
  workspaceId: 'ws-1',
  brandName: 'Acme',
  siteUrl: 'https://acme.example/',
  industry: 'docs',
  competitors: ['Notion'],
  userQueries: [],
  language: 'en',
}

function fetchOutcome(url: string, body: string, status = 200): FetchOutcome {
  return {
    url,
    status,
    headers: {},
    body,
    truncated: false,
    redirectChain: [],
    durationMs: 1,
  }
}

function readiness(): AgentReadinessReport {
  return {
    version: 1,
    url: 'https://acme.example/',
    finalUrl: 'https://acme.example/',
    fetchedAt: '2026-11-16T00:00:00.000Z',
    durationMs: 12,
    score: 80,
    grade: 'B',
    summary: { en: 'Ready enough.', zh: '基本就绪。' },
    checks: [
      check('page.jsonld', 'page', 'fail', 10),
      check('llms.txt', 'llms', 'warn', 12),
      check('llms-full.txt', 'llms', 'fail', 4),
    ],
    fixes: [
      {
        checkId: 'page.jsonld',
        category: 'page',
        title: { en: 'JSON-LD', zh: 'JSON-LD' },
        status: 'fail',
        impact: 10,
        fix: { en: 'Add JSON-LD.', zh: '加上 JSON-LD。' },
        verify: { en: 'View source.', zh: '看源代码。' },
      },
    ],
    categories: [],
  }
}

function check(id: string, category: 'page' | 'llms', status: 'pass' | 'warn' | 'fail', weight: number) {
  return {
    id,
    category,
    title: { en: id, zh: id },
    status,
    weight,
    applicable: true,
    explanation: { en: status, zh: status },
    fix: { en: 'fix', zh: '改' },
    verify: { en: 'verify', zh: '查' },
    evidence: id === 'page.jsonld' ? { types: ['Organization'] } : {},
  }
}

function llmText() {
  return [
    '```json',
    JSON.stringify({
      queries: [
        { text: 'What is Acme?', kind: 'brand', language: 'en' },
        { text: 'Is Acme worth it?', kind: 'brand', language: 'en' },
        { text: 'Acme official site', kind: 'brand', language: 'en' },
        { text: 'best docs tool', kind: 'category', language: 'en' },
        { text: 'which docs tool', kind: 'category', language: 'en' },
        { text: 'docs recommendations', kind: 'keyword', language: 'en' },
        { text: 'Acme vs Notion', kind: 'comparison', language: 'en' },
      ],
    }),
    '```',
  ].join('\n')
}

function deps(overrides: Partial<GeoHealthRunDeps> = {}): GeoHealthRunDeps {
  const report = readiness()
  let calls = 0
  return {
    runReadiness: async () => report,
    completeChat: async () => llmText(),
    listEngines: async () => ({
      active: ['perplexity'],
      skipped: [{ platform: 'deepseek', reason: { en: 'No credentials.', zh: '未配置凭证。' } }],
    }),
    queryEngine: async (_workspace, _platform, text) => {
      calls += 1
      if (text === 'Acme vs Notion') throw new Error('engine down sk-secretkey1234567890')
      return {
        answer: 'Acme is a docs tool. Notion is the other one.',
        sourceCitations: [{ url: 'https://acme.example/pricing', title: 'Pricing', position: 1, sourceType: 'api_citation' as const }],
        groundingSources: [],
        answerMentions: [],
      }
    },
    fetchPage: async (url) => {
      if (url.endsWith('/robots.txt')) return fetchOutcome(url, 'User-agent: *\nAllow: /\nSitemap: https://acme.example/sitemap.xml\n')
      if (url.endsWith('/sitemap.xml')) {
        return fetchOutcome(url, '<?xml version="1.0"?><urlset><url><loc>https://acme.example/pricing</loc></url><url><loc>https://other.example/nope</loc></url><url><loc>https://acme.example/blog/old</loc></url></urlset>')
      }
      if (url.includes('/pricing')) {
        return fetchOutcome(url, '<html><title>Pricing</title><body><p>Acme costs 99 dollars a month and serves 1200 teams that need a shared wiki.</p></body></html>')
      }
      return fetchOutcome(url, '<html><title>Acme</title><body><p>Acme is a docs tool for 1200 teams that want one wiki.</p></body></html>')
    },
    atomize: async () => ([
      {
        text: 'Acme is a docs tool for 1200 teams.',
        subject: 'Acme',
        predicate: 'is',
        object: 'a docs tool',
        anchors: ['1200'],
        definition: 'Acme is a docs tool',
      },
      {
        text: 'It is nice.',
        subject: '',
        predicate: '',
        object: '',
        anchors: [],
      },
    ]),
    ...overrides,
  }
  void calls
}

describe('page sampling', () => {
  it('keeps the homepage, prefers key paths, and stays on the same host', () => {
    const urls = selectPageUrls('https://acme.example/', [
      'https://other.example/pricing',
      'https://acme.example/blog/old',
      'https://acme.example/pricing',
      'https://acme.example/files/guide.pdf',
      'https://www.acme.example/',
    ], 3)
    expect(urls[0]).toBe('https://acme.example/')
    expect(urls).toContain('https://acme.example/pricing')
    expect(urls.some((url) => url.includes('other.example'))).toBe(false)
    expect(urls.some((url) => url.endsWith('.pdf'))).toBe(false)
    expect(urls).toHaveLength(3)
  })
})

describe('geo health orchestration', () => {
  it('embeds the readiness report and still scores when one engine call fails', async () => {
    const reportObject = readiness()
    const used = deps({ runReadiness: async () => reportObject })
    const partial: Record<string, unknown> = {}
    for (const pillar of ['agentReadiness', 'citations', 'citability'] as const) {
      partial[pillar] = await runPillar(pillar, input, null, used)
    }
    partial.structuredSignals = await runPillar(
      'structuredSignals',
      input,
      (partial.agentReadiness as { report: AgentReadinessReport }).report,
      used,
    )
    const { status, report } = conclude(input, partial as never, new Date('2026-11-16T03:00:00.000Z'))

    expect(status).toBe('SUCCEEDED')
    expect(report.version).toBe(1)
    expect(report.pillars.agentReadiness.report).toBe(reportObject)
    expect(report.pillars.agentReadiness.report?.checks).toBe(reportObject.checks)
    expect(report.pillars.citations.enginesSkipped.map((item) => item.platform)).toEqual(['deepseek'])
    expect(report.pillars.citations.enginesRun).toEqual(['perplexity'])
    expect(report.pillars.citations.samples.some((sample) => sample.ok)).toBe(true)
    expect(report.pillars.citations.samples.some((sample) => !sample.ok)).toBe(true)
    expect(report.pillars.citations.samples.find((sample) => !sample.ok)?.error).not.toContain('sk-secret')
    expect(report.pillars.citations.queries.some((query) => query.text === 'What is Acme?' && query.source === 'llm')).toBe(true)
    expect(report.pillars.citations.queries.some((query) => query.text === 'docs recommendations')).toBe(false)
    expect(report.pillars.citations.queries.some((query) => query.kind === 'comparison')).toBe(true)
    expect(report.pillars.citations.mentionRate).toBe(1)
    expect(report.pillars.citations.competitorSov[0]?.brand).toBe('Notion')
    expect(report.pillars.citations.competitorSov[0]?.mentionRate).toBeGreaterThan(0)
    expect(report.pillars.citations.brandCitedUrls.some((url) => url.includes('acme.example'))).toBe(true)
    expect(report.pillars.citability.pages.map((page) => page.url)).toContain('https://acme.example/pricing')
    expect(report.pillars.citability.score).not.toBeNull()
    expect(report.pillars.structuredSignals.schemaTypes).toEqual(['Organization'])
    expect(report.pillars.structuredSignals.generatedLlmsTxt).toContain('# Acme')
    expect(report.pillars.structuredSignals.generatedJsonLd).toContain('Organization')
    expect(report.actions.length).toBeGreaterThan(0)
    expect(report.actions.length).toBeLessThanOrEqual(10)
    const markdown = renderMarkdown(report)
    expect(markdown).toContain('GEO 体检：Acme')
    expect(markdown).toContain(String(report.score))
    expect(markdown).toContain('未配置凭证')
  })

  it('keeps a report when readiness and citability fail', async () => {
    const used = deps({
      runReadiness: async () => {
        throw new Error('origin blocked')
      },
      fetchPage: async () => {
        throw new Error('network down')
      },
      listEngines: async () => ({ active: [], skipped: [{ platform: 'perplexity', reason: { en: 'No credentials.', zh: '未配置凭证。' } }] }),
    })
    const partial: Record<string, unknown> = {}
    for (const pillar of PILLAR_IDS) {
      const readinessReport = pillar === 'structuredSignals'
        ? (partial.agentReadiness as { report: AgentReadinessReport | null }).report
        : null
      partial[pillar] = await runPillar(pillar, input, readinessReport, used)
    }
    const { status, report } = conclude(input, partial as never, new Date('2026-11-16T03:00:00.000Z'))
    expect(partial.agentReadiness).toMatchObject({ status: 'FAILED', report: null })
    expect(partial.citations).toMatchObject({ status: 'SKIPPED', score: null })
    expect(partial.citability).toMatchObject({ status: 'FAILED' })
    expect(partial.structuredSignals).toMatchObject({ status: 'SKIPPED' })
    expect((partial.structuredSignals as { generatedLlmsTxt: string }).generatedLlmsTxt).toContain('# Acme')
    expect(status).toBe('PARTIAL')
    expect(report.pillars.agentReadiness.report).toBeNull()
    expect(report.score).toBe(0)
    expect(report.weighting.applied.citations).toBe(0)
    expect(report.pillars.citations.note?.zh).toContain('凭证')
  })

  it('falls back to templates when the model returns nothing usable', async () => {
    const used = deps({
      completeChat: async () => 'I cannot help with that.',
    })
    const pillar = await runPillar('citations', input, null, used)
    expect(pillar.status === 'SUCCEEDED' || pillar.status === 'SKIPPED' || pillar.status === 'FAILED').toBe(true)
    if (pillar.status === 'FAILED' && !('queries' in pillar)) throw new Error('missing queries')
    const queries = 'queries' in pillar ? pillar.queries : []
    expect(queries.length).toBeGreaterThanOrEqual(5)
    expect(queries.every((query) => query.source === 'template')).toBe(true)
    expect(queries.some((query) => query.text.includes('Acme'))).toBe(true)
  })
})
