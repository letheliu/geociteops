import { describe, it, expect } from 'vitest'
import { calculateMetrics } from './metrics.js'
import type { DiagnosticMetricSample } from './types.js'

function makeSample(overrides: Partial<DiagnosticMetricSample> & { status: string }): DiagnosticMetricSample {
  return {
    status: overrides.status,
    rawAnswer: overrides.rawAnswer ?? 'some answer',
    analysis: overrides.analysis ?? {
      brandMentioned: false,
      brandSourceCited: false,
      rankInAnswer: null,
      sourceRank: null,
      sovScore: 0,
      sourceCitationRate: 0,
      competitors: [],
    },
    platform: overrides.platform ?? 'deepseek',
  }
}

describe('calculateMetrics', () => {
  it('computes all metrics correctly with sample data', () => {
    const samples: DiagnosticMetricSample[] = [
      makeSample({ status: 'SUCCEEDED', analysis: { brandMentioned: true, brandSourceCited: true, rankInAnswer: 1, sourceRank: 1, sovScore: 0.8, sourceCitationRate: 0.5, competitors: [{ name: 'CompetitorA', mentioned: true }] } }),
      makeSample({ status: 'SUCCEEDED', analysis: { brandMentioned: true, brandSourceCited: true, rankInAnswer: 2, sourceRank: 2, sovScore: 0.6, sourceCitationRate: 0.3, competitors: [{ name: 'CompetitorA', mentioned: true }] } }),
      makeSample({ status: 'SUCCEEDED', analysis: { brandMentioned: true, brandSourceCited: false, rankInAnswer: 4, sourceRank: null, sovScore: 0.4, sourceCitationRate: 0, competitors: [{ name: 'CompetitorA', mentioned: true }] } }),
      makeSample({ status: 'SUCCEEDED', analysis: { brandMentioned: true, brandSourceCited: false, rankInAnswer: null, sourceRank: null, sovScore: 0.3, sourceCitationRate: 0, competitors: [] } }),
      makeSample({ status: 'SUCCEEDED', analysis: { brandMentioned: false, brandSourceCited: false, rankInAnswer: null, sourceRank: null, sovScore: 0, sourceCitationRate: 0, competitors: [{ name: 'CompetitorA', mentioned: true }] } }),
      makeSample({ status: 'SUCCEEDED', analysis: { brandMentioned: false, brandSourceCited: false, rankInAnswer: null, sourceRank: null, sovScore: 0, sourceCitationRate: 0, competitors: [] } }),
      makeSample({ status: 'SUCCEEDED', analysis: { brandMentioned: false, brandSourceCited: false, rankInAnswer: null, sourceRank: null, sovScore: 0, sourceCitationRate: 0, competitors: [] } }),
      makeSample({ status: 'SUCCEEDED', analysis: { brandMentioned: false, brandSourceCited: false, rankInAnswer: null, sourceRank: null, sovScore: 0, sourceCitationRate: 0, competitors: [] } }),
      makeSample({ status: 'FAILED', rawAnswer: null, analysis: null }),
      makeSample({ status: 'FAILED', rawAnswer: null, analysis: null }),
    ]

    const result = calculateMetrics({ plannedSamples: 10, runStatus: 'COMPLETED', samples })

    expect(result.validSampleRate).toBe(0.8)
    expect(result.mentionRate).toBe(0.5)
    expect(result.sourceCitationRate).toBe(0.25)
    expect(result.mentionedSourceCitationRate).toBe(0.5)
    expect(result.rankedSampleCount).toBe(3)
    expect(result.averageRank).toBeCloseTo(7 / 3)
    expect(result.reliability).toBe('MEDIUM')
  })

  it('returns null for metrics when no valid samples', () => {
    const samples: DiagnosticMetricSample[] = [
      makeSample({ status: 'FAILED', rawAnswer: null, analysis: null }),
    ]
    const result = calculateMetrics({ plannedSamples: 5, runStatus: 'FAILED', samples })
    expect(result.mentionRate).toBeNull()
    expect(result.averageRank).toBeNull()
    expect(result.rankCoverageScore).toBe(0)
  })

  it('returns HIGH reliability for COMPLETED with >=90% valid rate', () => {
    const samples: DiagnosticMetricSample[] = Array.from({ length: 10 }, () =>
      makeSample({ status: 'SUCCEEDED', platform: 'deepseek' })
    )
    const result = calculateMetrics({ plannedSamples: 10, runStatus: 'COMPLETED', samples })
    expect(result.validSampleRate).toBe(1)
    expect(result.reliability).toBe('HIGH')
  })

  it('returns MEDIUM for PARTIAL runs', () => {
    const samples: DiagnosticMetricSample[] = Array.from({ length: 8 }, () =>
      makeSample({ status: 'SUCCEEDED', platform: 'deepseek' })
    )
    const result = calculateMetrics({ plannedSamples: 10, runStatus: 'PARTIAL', samples })
    expect(result.reliability).toBe('MEDIUM')
  })

  it('returns LOW for <70% valid rate', () => {
    const samples: DiagnosticMetricSample[] = Array.from({ length: 5 }, () =>
      makeSample({ status: 'SUCCEEDED', platform: 'deepseek' })
    )
    const result = calculateMetrics({ plannedSamples: 10, runStatus: 'COMPLETED', samples })
    expect(result.reliability).toBe('LOW')
  })
})
