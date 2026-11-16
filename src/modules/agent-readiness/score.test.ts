import { describe, expect, it } from 'vitest'
import { buildReport, gradeFor, scoreChecks } from './score.js'
import { tx, type AgentReadinessCheck } from './types.js'

function check(partial: Partial<AgentReadinessCheck> & Pick<AgentReadinessCheck, 'id' | 'status' | 'weight'>): AgentReadinessCheck {
  return {
    category: 'page',
    title: tx(partial.id, partial.id),
    applicable: true,
    explanation: tx('e', 'e'),
    fix: tx('f', 'f'),
    verify: tx('v', 'v'),
    evidence: {},
    ...partial,
  }
}

describe('score', () => {
  it('normalizes pass, warn, and fail and ignores inapplicable checks', () => {
    const checks = [
      check({ id: 'a', status: 'pass', weight: 10 }),
      check({ id: 'b', status: 'warn', weight: 10 }),
      check({ id: 'c', status: 'fail', weight: 10 }),
      check({ id: 'd', status: 'fail', weight: 100, applicable: false }),
    ]
    // (10 + 5 + 0) / 30
    expect(scoreChecks(checks)).toBe(50)
  })

  it('maps grades and sorts fixes by impact', () => {
    expect(gradeFor(90)).toBe('A')
    expect(gradeFor(75)).toBe('B')
    expect(gradeFor(60)).toBe('C')
    expect(gradeFor(40)).toBe('D')
    expect(gradeFor(39)).toBe('F')

    const report = buildReport({
      url: 'https://example.com/',
      finalUrl: 'https://example.com/',
      fetchedAt: '2026-11-16T00:00:00.000Z',
      durationMs: 10,
      checks: [
        check({ id: 'small-fail', status: 'fail', weight: 4, category: 'markdown' }),
        check({ id: 'big-warn', status: 'warn', weight: 20, category: 'robots' }),
        check({ id: 'ok', status: 'pass', weight: 10 }),
      ],
    })
    expect(report.version).toBe(1)
    expect(report.fixes.map((f) => f.checkId)).toEqual(['big-warn', 'small-fail'])
    expect(report.fixes[0].impact).toBe(10)
    expect(report.fixes[1].impact).toBe(4)
    expect(report.categories.find((c) => c.id === 'robots')?.status).toBe('warn')
  })
})
