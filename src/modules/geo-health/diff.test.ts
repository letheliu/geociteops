import { describe, expect, it } from 'vitest'
import { buildAcmeDrawSeries } from '../../../scripts/lib/acme-draw-health.ts'
import { diffReports } from './diff.js'
import type { GeoHealthAction, GeoHealthReport } from './types.js'

function withActions(report: GeoHealthReport, actions: GeoHealthAction[]): GeoHealthReport {
  return { ...report, actions }
}

describe('diffReports', () => {
  const base = buildAcmeDrawSeries({ now: new Date('2026-11-16T08:00:00.000Z') }).at(-1)!.health
  const sample = base.actions[0]!

  function action(id: string, impact: GeoHealthAction['impact']): GeoHealthAction {
    return { ...sample, id, impact, title: { en: id, zh: id } }
  }

  it('reports the score delta, new and resolved actions, and a pillar that fell', () => {
    const previous: GeoHealthReport = {
      ...withActions(base, [action('citations:mention', 'low'), action('signals:llms', 'low')]),
      score: 70,
      grade: 'C',
      pillars: {
        ...base.pillars,
        citations: { ...base.pillars.citations, score: 50 },
      },
    }
    const current: GeoHealthReport = {
      ...withActions(base, [action('citations:mention', 'high'), action('citability:home', 'medium')]),
      score: 62,
      grade: 'C',
      pillars: {
        ...base.pillars,
        citations: { ...base.pillars.citations, score: 30 },
      },
    }
    const diff = diffReports(previous, current)
    expect(diff.scoreDelta).toBe(-8)
    expect(diff.newActions.map((item) => item.id)).toEqual(['citability:home'])
    expect(diff.resolvedActions.map((item) => item.id)).toEqual(['signals:llms'])
    expect(diff.regressedActions.map((item) => item.id)).toEqual(['citations:mention'])
    expect(diff.regressedPillars).toContain('citations')
    const citations = diff.pillars.find((item) => item.pillar === 'citations')
    expect(citations).toMatchObject({ previous: 50, current: 30, delta: -20 })
  })
})
