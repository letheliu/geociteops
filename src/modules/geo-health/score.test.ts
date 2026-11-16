import { describe, expect, it } from 'vitest'
import { buildActions } from './actions.js'
import { applyWeights, citationPillarScore, gradeFor, overallCheckStatus, pageComposite, progressPercent, rankComponent, structuredSignalScore } from './score.js'
import { emptyProgress } from './score.js'
import type { CitationPillar, CitabilityPillar, StructuredSignalsPillar } from './types.js'
import { NOMINAL_WEIGHTS } from './weights.js'

describe('geo health score', () => {
  it('nominal weights sum to 1', () => {
    const sum = Object.values(NOMINAL_WEIGHTS).reduce((total, weight) => total + weight, 0)
    expect(sum).toBeCloseTo(1)
  })

  it('drops a pillar with no score and rescales the rest', () => {
    const { score, applied } = applyWeights({
      agentReadiness: 100,
      citations: null,
      citability: 100,
      structuredSignals: 100,
    })
    expect(score).toBe(100)
    expect(applied.citations).toBe(0)
    expect(applied.agentReadiness + applied.citability + applied.structuredSignals).toBeCloseTo(1)
    expect(applied.agentReadiness).toBeCloseTo(0.3 / 0.65)
  })

  it('scores a full set with the documented blend', () => {
    const { score, applied } = applyWeights({
      agentReadiness: 80,
      citations: 60,
      citability: 50,
      structuredSignals: 40,
    })
    expect(applied.citations).toBeCloseTo(0.35)
    expect(score).toBe(Math.round(80 * 0.3 + 60 * 0.35 + 50 * 0.2 + 40 * 0.15))
  })

  it('uses the same letter grades as agent readiness', () => {
    expect(gradeFor(100)).toBe('A')
    expect(gradeFor(90)).toBe('A')
    expect(gradeFor(89)).toBe('B')
    expect(gradeFor(75)).toBe('B')
    expect(gradeFor(74)).toBe('C')
    expect(gradeFor(60)).toBe('C')
    expect(gradeFor(59)).toBe('D')
    expect(gradeFor(40)).toBe('D')
    expect(gradeFor(39)).toBe('F')
    expect(gradeFor(0)).toBe('F')
  })

  it('scores citations from mention, citation, and rank', () => {
    expect(citationPillarScore({ mentionRate: 1, citationRate: 1, meanRank: 1 })).toBe(100)
    expect(citationPillarScore({ mentionRate: 0, citationRate: 0, meanRank: null })).toBe(0)
    expect(rankComponent(3)).toBe(50)
    expect(citationPillarScore({ mentionRate: 1, citationRate: 0, meanRank: 3 })).toBe(55)
    expect(citationPillarScore({ mentionRate: 1.4, citationRate: -1, meanRank: 9 })).toBe(45)
  })

  it('blends atom and passage scores 60/40', () => {
    expect(pageComposite(80, 50)).toBe(68)
    expect(pageComposite(0, 0)).toBe(0)
  })

  it('scores structured signals from readiness check statuses', () => {
    expect(structuredSignalScore([
      { id: 'page.jsonld', status: 'pass', applicable: true },
      { id: 'llms.txt', status: 'warn', applicable: true },
      { id: 'llms-full.txt', status: 'fail', applicable: true },
    ])).toBe(68)
    expect(structuredSignalScore([
      { id: 'page.jsonld', status: 'pass', applicable: false },
      { id: 'llms.txt', status: 'pass', applicable: true },
    ])).toBe(35)
  })

  it('treats a skipped pillar as success and an all-failed run as failure', () => {
    expect(overallCheckStatus(['SUCCEEDED', 'SKIPPED', 'SUCCEEDED', 'SUCCEEDED'])).toBe('SUCCEEDED')
    expect(overallCheckStatus(['FAILED', 'SUCCEEDED', 'SKIPPED', 'FAILED'])).toBe('PARTIAL')
    expect(overallCheckStatus(['FAILED', 'FAILED', 'FAILED', 'FAILED'])).toBe('FAILED')
  })

  it('counts a running pillar as half a step', () => {
    const progress = emptyProgress()
    progress.pillars.agentReadiness.status = 'SUCCEEDED'
    progress.pillars.citations.status = 'RUNNING'
    expect(progressPercent(progress)).toBe(38)
    progress.pillars.citability.status = 'FAILED'
    progress.pillars.structuredSignals.status = 'SKIPPED'
    expect(progressPercent(progress)).toBe(88)
  })
})

describe('geo health actions', () => {
  it('sorts by impact then effort and keeps ten', () => {
    const fixes = Array.from({ length: 12 }, (_, index) => ({
      checkId: `extra.${index}`,
      category: 'page' as const,
      title: { en: `Fix ${index}`, zh: `修复 ${index}` },
      status: 'fail' as const,
      impact: 12 - index,
      fix: { en: 'do it', zh: '改' },
      verify: { en: 'check', zh: '查' },
    }))
    const actions = buildActions({
      readiness: {
        status: 'SUCCEEDED',
        score: 40,
        error: null,
        report: {
          version: 1,
          url: 'https://acme.example/',
          finalUrl: 'https://acme.example/',
          fetchedAt: '2026-11-16T00:00:00.000Z',
          durationMs: 1,
          score: 40,
          grade: 'D',
          summary: { en: 's', zh: 's' },
          checks: [],
          fixes,
          categories: [],
        },
      },
      citations: citation(),
      citability: citability(),
      signals: signals(),
    })
    expect(actions).toHaveLength(10)
    expect(actions.map((item) => item.impact)).toEqual([...actions].sort((a, b) => {
      const rank = { high: 3, medium: 2, low: 1 }
      return rank[b.impact] - rank[a.impact] || a.effort - b.effort
    }).map((item) => item.impact))
    expect(actions[0].id).toBe('readiness:extra.0')
    expect(actions[0].effort).toBe(2)
  })

  it('points a weak mention at a question that can be run again', () => {
    const actions = buildActions({
      readiness: { status: 'SUCCEEDED', score: 90, report: null, error: null },
      citations: citation({
        mentionRate: 0.2,
        citationRate: 0.1,
        queries: [{
          text: '最好的协作文档',
          kind: 'category',
          language: 'zh',
          source: 'llm',
          samples: 2,
          mentions: 0,
          citations: 0,
          meanRank: null,
        }],
      }),
      citability: citability(),
      signals: signals(),
    })
    const mention = actions.find((item) => item.id === 'citations:mention')
    expect(mention?.impact).toBe('high')
    expect(mention?.effort).toBe(3)
    expect(mention?.verifyQuery).toBe('最好的协作文档')
    expect(mention?.verify.zh).toContain('最好的协作文档')
    expect(mention?.fix.zh).toContain('定义')
  })
})

function citation(overrides: Partial<CitationPillar> = {}): CitationPillar {
  return {
    status: 'SUCCEEDED',
    score: 80,
    queries: [],
    querySource: 'llm',
    enginesRun: ['perplexity'],
    enginesSkipped: [],
    mentionRate: 0.8,
    citationRate: 0.8,
    meanRank: 1,
    shareOfVoice: 0.6,
    citedUrls: [],
    brandCitedUrls: [],
    competitorSov: [],
    samples: [],
    note: null,
    error: null,
    ...overrides,
  }
}

function citability(): CitabilityPillar {
  return { status: 'SUCCEEDED', score: 80, pages: [], weakestPages: [], note: null, error: null }
}

function signals(): StructuredSignalsPillar {
  return {
    status: 'SUCCEEDED',
    score: 80,
    schemaTypes: ['Organization'],
    jsonLdPresent: true,
    llmsTxtStatus: 'pass',
    llmsFullStatus: 'pass',
    generatedLlmsTxt: '# Acme\n',
    generatedJsonLd: '{}',
    note: null,
    error: null,
  }
}
