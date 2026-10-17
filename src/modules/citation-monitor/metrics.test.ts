import { describe, it, expect } from 'vitest'
import { summarizeGeoMetrics, compareGeoMetrics } from './metrics.js'

describe('metrics', () => {
  it('计算 before/after 的 source citation delta', () => {
    const before = [
      { brandMentioned: true, brandSourceCited: false, rankInAnswer: 2, sourceRank: null, sovScore: 0.2 },
    ] as any[]
    const after = [
      { brandMentioned: true, brandSourceCited: true, rankInAnswer: 1, sourceRank: 1, sovScore: 0.8 },
    ] as any[]

    const result = compareGeoMetrics(before, after)

    expect(result.before.sourceCitationRate).toBe(0)
    expect(result.after.sourceCitationRate).toBe(1)
    expect(result.delta.sourceCitationRate).toBe(1)
    expect(result.delta.avgSovScore).toBeCloseTo(0.6)
  })

  it('空样本返回 0 或 null', () => {
    const result = summarizeGeoMetrics([])

    expect(result.totalEvents).toBe(0)
    expect(result.brandMentionRate).toBe(0)
    expect(result.sourceCitationRate).toBe(0)
    expect(result.avgAnswerRank).toBeNull()
    expect(result.avgSourceRank).toBeNull()
    expect(result.avgSovScore).toBe(0)
  })

  it('rank 越小越好', () => {
    const events = [
      { brandMentioned: true, brandSourceCited: true, rankInAnswer: 1, sourceRank: 2, sovScore: 0.8 },
      { brandMentioned: true, brandSourceCited: true, rankInAnswer: 3, sourceRank: 1, sovScore: 0.6 },
    ] as any[]

    const result = summarizeGeoMetrics(events)

    expect(result.avgAnswerRank).toBe(2)
    expect(result.avgSourceRank).toBe(1.5)
  })

  it('只统计非 null 的 rank', () => {
    const events = [
      { brandMentioned: true, brandSourceCited: false, rankInAnswer: 1, sourceRank: null, sovScore: 0.5 },
      { brandMentioned: false, brandSourceCited: false, rankInAnswer: null, sourceRank: null, sovScore: 0 },
    ] as any[]

    const result = summarizeGeoMetrics(events)

    expect(result.avgAnswerRank).toBe(1)
    expect(result.avgSourceRank).toBeNull()
  })
})
