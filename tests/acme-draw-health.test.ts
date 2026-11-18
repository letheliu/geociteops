import { describe, expect, it } from 'vitest'
import { buildAcmeDrawSeries } from '../scripts/lib/acme-draw-health.ts'
import { diffReports } from '../src/modules/geo-health/diff.ts'

describe('Acme Draw health sample', () => {
  const series = buildAcmeDrawSeries({ now: new Date('2026-11-16T08:00:00.000Z') })

  it('keeps the brand on an .example site and drops the score after the peak', () => {
    expect(series.map((item) => item.daysAgo)).toEqual([27, 20, 13, 0.05])
    expect(series.every((item) => item.health.brandName === 'Acme Draw')).toBe(true)
    expect(series.every((item) => item.health.siteUrl === 'https://acmedraw.example')).toBe(true)
    const hosts = series.flatMap((item) => item.health.pillars.citations.citedUrls)
    expect(hosts.every((url) => url.endsWith('.example') || url.includes('.example/'))).toBe(true)
    const scores = series.map((item) => item.health.score)
    expect(scores[2]).toBeGreaterThan(scores[3]!)
    expect(scores[0]).toBeLessThan(scores[3]!)
    const diff = diffReports(series[2]!.health, series[3]!.health)
    expect(diff.scoreDelta).toBeLessThan(0)
    expect(diff.regressedPillars).toContain('citations')
    expect(diff.newActions.map((action) => action.id)).toContain('citations:mention')
  })
})