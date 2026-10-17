import type { DiagnosticRunStatus } from '@prisma/client'

export interface CompetitorInput {
  name: string
  domain?: string
  aliases?: string[]
}

export interface RunDraftConfig {
  queryIds: string[]
  platforms: string[]
  samplesPerQuery: number
  locale: string
  timezone: string
}

export interface SamplingSnapshot {
  samplesPerQuery: number
  locale: string
  timezone: string
}

export interface DiagnosticMetricSample {
  status: string
  rawAnswer: string | null
  analysis: {
    brandMentioned: boolean
    brandSourceCited: boolean
    rankInAnswer: number | null
    sourceRank: number | null
    sovScore: number
    sourceCitationRate: number
    competitors: Array<{ name: string; mentioned: boolean }>
  } | null
  platform: string
}

export interface DiagnosticMetrics {
  validSampleRate: number
  validSampleCount: number
  mentionRate: number | null
  sourceCitationRate: number | null
  mentionedSourceCitationRate: number | null
  averageRank: number | null
  rankedSampleCount: number
  rankCoverageScore: number
  sovScore: number
  competitorLeadDeltas: Array<{ name: string; mentionRate: number; leadDelta: number }>
  queryTypeCoverage: Record<string, { total: number; covered: number; rate: number }>
  reliability: 'HIGH' | 'MEDIUM' | 'LOW'
  plannedSamples: number
  failedSamples: number
  successSamples: number
  platformGaps: string[]
}

export interface MetricBreakdown {
  dimension: string
  mentionRate: number | null
  sourceCitationRate: number | null
  averageRank: number | null
  rankedSampleCount: number
  validSampleCount: number
}

export interface DiagnosticReport {
  runId: string
  projectId: string
  name: string
  runType: string
  status: string
  reliability: string
  scope: {
    platforms: string[]
    samplesPerQuery: number
    locale: string
    timezone: string
    totalUnits: number
  }
  metrics: DiagnosticMetrics
  queryTypeBreakdown: MetricBreakdown[]
  platformBreakdown: MetricBreakdown[]
  competitorMetrics: Array<{
    name: string
    mentionRate: number
    leadDelta: number
  }>
  findings: Array<{
    id: string
    type: string
    severity: string
    title: string
    summary: string
    metric: unknown
    evidenceSampleIds: string[]
  }>
  actions: Array<{
    id: string
    horizon: string
    actionType: string
    title: string
    description: string
    priority: number
    status: string
  }>
  reportGeneratedAt: string
  sourceSampleUpdatedAt: string
}

export interface RunScopeComparison {
  strictlyComparable: boolean
  baselineRunId: string
  retestRunId: string
  queryDiffs: {
    added: string[]
    removed: string[]
  }
  platformDiffs: {
    added: string[]
    removed: string[]
  }
  competitorDiffs: {
    added: string[]
    removed: string[]
  }
  samplingDiff: {
    samplesPerQueryChanged: boolean
    localeChanged: boolean
    timezoneChanged: boolean
  }
  baselineReport: DiagnosticReport | null
  retestReport: DiagnosticReport | null
}
