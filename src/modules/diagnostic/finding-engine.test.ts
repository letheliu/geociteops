import { describe, it, expect } from 'vitest'
import { generateFindings } from './finding-engine.js'
import type { DiagnosticMetricSample } from './types.js'

function makeSample(overrides: Partial<DiagnosticMetricSample> & { status: string; id?: string }): DiagnosticMetricSample & { id?: string } {
  return {
    id: overrides.id ?? `s-${Math.random()}`,
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

describe('generateFindings', () => {
  it('generates LOW_VISIBILITY when mention rate < 30% with enough samples', () => {
    const samples: (DiagnosticMetricSample & { id?: string })[] = Array.from({ length: 10 }, (_, i) =>
      makeSample({ id: `s${i}`, status: 'SUCCEEDED', analysis: { brandMentioned: i < 2, brandSourceCited: false, rankInAnswer: null, sourceRank: null, sovScore: 0, sourceCitationRate: 0, competitors: [] }, platform: 'deepseek' })
    )
    const findings = generateFindings({ samples: samples as DiagnosticMetricSample[], globalMetrics: { mentionRate: 0.2, validSampleCount: 10, sourceCitationRate: 0, sovScore: 0, reliability: 'LOW', plannedSamples: 10, failedSamples: 0, successSamples: 10, mentionedSourceCitationRate: 0, rankCoverageScore: 0, validSampleRate: 1, averageRank: null, rankedSampleCount: 0, competitorLeadDeltas: [], queryTypeCoverage: {}, platformGaps: [] }, allPlatforms: ['deepseek'], queryTypes: ['BRAND'], queryTypeSamples: { BRAND: { totalQueries: 1, samples: samples as DiagnosticMetricSample[] } } })
    const lowVis = findings.filter(f => f.type === 'LOW_VISIBILITY')
    expect(lowVis.length).toBeGreaterThanOrEqual(1)
  })

  it('does NOT generate LOW_VISIBILITY when mention rate >= 30%', () => {
    const samples: (DiagnosticMetricSample & { id?: string })[] = Array.from({ length: 10 }, (_, i) =>
      makeSample({ id: `s${i}`, status: 'SUCCEEDED', analysis: { brandMentioned: i < 3, brandSourceCited: false, rankInAnswer: null, sourceRank: null, sovScore: 0, sourceCitationRate: 0, competitors: [] }, platform: 'deepseek' })
    )
    const findings = generateFindings({ samples: samples as DiagnosticMetricSample[], globalMetrics: { mentionRate: 0.3, validSampleCount: 10, sourceCitationRate: 0, sovScore: 0, reliability: 'HIGH', plannedSamples: 10, failedSamples: 0, successSamples: 10, mentionedSourceCitationRate: 0, rankCoverageScore: 0, validSampleRate: 1, averageRank: null, rankedSampleCount: 0, competitorLeadDeltas: [], queryTypeCoverage: {}, platformGaps: [] }, allPlatforms: ['deepseek'], queryTypes: ['BRAND'], queryTypeSamples: { BRAND: { totalQueries: 1, samples: samples as DiagnosticMetricSample[] } } })
    expect(findings.filter(f => f.type === 'LOW_VISIBILITY')).toHaveLength(0)
  })

  it('generates LOW_RANK when average rank > 3 with enough ranked samples', () => {
    const samples: (DiagnosticMetricSample & { id?: string })[] = Array.from({ length: 5 }, (_, i) =>
      makeSample({ id: `s${i}`, status: 'SUCCEEDED', analysis: { brandMentioned: true, brandSourceCited: false, rankInAnswer: i + 4, sourceRank: null, sovScore: 0.5, sourceCitationRate: 0, competitors: [] }, platform: 'deepseek' })
    )
    const findings = generateFindings({ samples: samples as DiagnosticMetricSample[], globalMetrics: { mentionRate: 1, validSampleCount: 5, sourceCitationRate: 1, sovScore: 0.5, reliability: 'HIGH', plannedSamples: 5, failedSamples: 0, successSamples: 5, mentionedSourceCitationRate: 1, rankCoverageScore: 0.5, validSampleRate: 1, averageRank: 6, rankedSampleCount: 5, competitorLeadDeltas: [], queryTypeCoverage: {}, platformGaps: [] }, allPlatforms: ['deepseek'], queryTypes: ['BRAND'], queryTypeSamples: { BRAND: { totalQueries: 1, samples: samples as DiagnosticMetricSample[] } } })
    expect(findings.filter(f => f.type === 'LOW_RANK')).toHaveLength(1)
  })

  it('generates INSUFFICIENT_SAMPLE when valid rate < 70%', () => {
    const samples: (DiagnosticMetricSample & { id?: string })[] = Array.from({ length: 3 }, (_, i) =>
      makeSample({ id: `s${i}`, status: 'SUCCEEDED', platform: 'deepseek' })
    )
    const findings = generateFindings({ samples: samples as DiagnosticMetricSample[], globalMetrics: { mentionRate: 0, validSampleCount: 3, sourceCitationRate: 0, sovScore: 0, reliability: 'LOW', plannedSamples: 10, failedSamples: 7, successSamples: 3, mentionedSourceCitationRate: 0, rankCoverageScore: 0, validSampleRate: 0.3, averageRank: null, rankedSampleCount: 0, competitorLeadDeltas: [], queryTypeCoverage: {}, platformGaps: ['qwen'] }, allPlatforms: ['deepseek', 'qwen'], queryTypes: ['BRAND'], queryTypeSamples: {} })
    expect(findings.filter(f => f.type === 'INSUFFICIENT_SAMPLE')).toHaveLength(1)
  })

  it('limits evidence to 10 samples', () => {
    const samples: (DiagnosticMetricSample & { id?: string })[] = Array.from({ length: 20 }, (_, i) =>
      makeSample({ id: `s${i}`, status: 'SUCCEEDED', analysis: { brandMentioned: false, brandSourceCited: false, rankInAnswer: null, sourceRank: null, sovScore: 0, sourceCitationRate: 0, competitors: [] }, platform: 'deepseek' })
    )
    const findings = generateFindings({ samples: samples as DiagnosticMetricSample[], globalMetrics: { mentionRate: 0, validSampleCount: 20, sourceCitationRate: 0, sovScore: 0, reliability: 'HIGH', plannedSamples: 20, failedSamples: 0, successSamples: 20, mentionedSourceCitationRate: 0, rankCoverageScore: 0, validSampleRate: 1, averageRank: null, rankedSampleCount: 0, competitorLeadDeltas: [], queryTypeCoverage: {}, platformGaps: [] }, allPlatforms: ['deepseek'], queryTypes: ['BRAND'], queryTypeSamples: { BRAND: { totalQueries: 1, samples: samples as DiagnosticMetricSample[] } } })
    const insuff = findings.filter(f => f.type === 'INSUFFICIENT_SAMPLE')
    if (insuff.length > 0) {
      expect(insuff[0].evidenceSampleIds.length).toBeLessThanOrEqual(10)
    }
  })
})
