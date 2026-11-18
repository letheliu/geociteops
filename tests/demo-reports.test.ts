import { describe, expect, it } from 'vitest'
import { AI_CRAWLERS } from '../src/modules/agent-readiness/bots.js'
import { gradeFor, scoreChecks } from '../src/modules/agent-readiness/score.js'
import { applyWeights } from '../src/modules/geo-health/score.js'
import { buildDemoReports } from '../scripts/lib/demo-reports.ts'

describe('demo health snapshot', () => {
  const built = buildDemoReports({ generatedAt: new Date('2026-11-01T08:00:00.000Z') })

  it('scores the fictional readiness audit with the product formula', () => {
    const { readiness } = built
    expect(readiness.version).toBe(1)
    expect(readiness.url).toBe('https://acmedraw.example')
    expect(readiness.score).toBe(scoreChecks(readiness.checks))
    expect(readiness.grade).toBe(gradeFor(readiness.score))
    expect(readiness.summary.zh).toContain('虚构')
    expect(readiness.checks.find((check) => check.id === 'access.bot-ua')?.status).toBe('fail')
    expect(readiness.checks.find((check) => check.id === 'page.jsonld')?.status).toBe('fail')
    expect(readiness.checks.find((check) => check.id === 'llms.txt')?.status).toBe('warn')
    const answer = readiness.checks.find((check) => check.id === 'robots.answer-bots')
    const bots = answer?.evidence.bots as { token: string }[]
    expect(bots.map((bot) => bot.token).sort()).toEqual(AI_CRAWLERS.map((bot) => bot.token).sort())
    expect(readiness.fixes[0]?.checkId).toBe('access.bot-ua')
  })

  it('builds a health report whose overall score matches the pillar weights', () => {
    const { health, healthStatus } = built
    expect(healthStatus).toBe('SUCCEEDED')
    expect(health.version).toBe(1)
    expect(health.brandName).toBe('Acme Draw')
    expect(health.summary.zh).toMatch(/GEO 体检得分/)
    const weighted = applyWeights({
      agentReadiness: health.pillars.agentReadiness.score,
      citations: health.pillars.citations.score,
      citability: health.pillars.citability.score,
      structuredSignals: health.pillars.structuredSignals.score,
    })
    expect(health.score).toBe(weighted.score)
    expect(health.grade).toBe(gradeFor(health.score))
    expect(health.pillars.citations.enginesRun).toEqual(['deepseek', 'doubao'])
    expect(health.pillars.citations.enginesSkipped.map((item) => item.platform)).toEqual([
      'qwen', 'ernie', 'perplexity', 'chatgpt', 'gemini',
    ])
    expect(health.pillars.citations.note?.zh).toContain('虚构')
    expect(health.pillars.citations.mentionRate).toBeCloseTo(3 / 8)
    expect(health.pillars.citations.samples).toHaveLength(8)
    const brandShare = health.pillars.citations.shareOfVoice ?? 0
    const leader = Math.max(...health.pillars.citations.competitorSov.map((row) => row.shareOfVoice))
    expect(leader).toBeGreaterThan(brandShare)
    expect(health.pillars.structuredSignals.generatedLlmsTxt).toContain('# Acme Draw')
    expect(health.pillars.structuredSignals.generatedJsonLd).toContain('Organization')
    expect(health.actions.length).toBeGreaterThan(0)
    expect(health.actions.length).toBeLessThanOrEqual(10)
    expect(health.pillars.agentReadiness.report?.score).toBe(built.readiness.score)
  })
})
