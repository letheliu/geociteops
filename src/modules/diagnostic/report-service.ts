import type { PrismaClient } from '@prisma/client'
import { DiagnosticError } from './errors.js'
import { calculateMetrics } from './metrics.js'
import type { DiagnosticMetrics, DiagnosticReport, RunScopeComparison } from './types.js'

export interface ReportService {
  get(workspaceId: string, runId: string): Promise<DiagnosticReport>
  compare(workspaceId: string, baselineRunId: string, retestRunId: string): Promise<RunScopeComparison>
}

export interface ReportServiceDeps {
  prisma: PrismaClient
}

export function createReportService(deps: ReportServiceDeps): ReportService {
  const { prisma } = deps

  async function getRun(workspaceId: string, runId: string) {
    const run = await prisma.diagnosticRun.findFirst({
      where: { id: runId, workspaceId },
    })
    if (!run) throw new DiagnosticError('PROJECT_NOT_FOUND', 'PROJECT_NOT_FOUND')
    return run
  }

  async function generateReport(workspaceId: string, runId: string): Promise<DiagnosticReport> {
    const run = await getRun(workspaceId, runId)

    if (['RUNNING', 'DRAFT', 'READY'].includes(run.status)) {
      throw new DiagnosticError('REPORT_NOT_READY', 'REPORT_NOT_READY')
    }

    if (run.status === 'FAILED') {
      throw new DiagnosticError('NO_VALID_SAMPLES', 'NO_VALID_SAMPLES')
    }

    const samples = await prisma.diagnosticSample.findMany({
      where: { runId },
    })

    const findings = await prisma.diagnosticFinding.findMany({
      where: { runId, workspaceId },
    })

    const actions = await prisma.diagnosticAction.findMany({
      where: { runId, workspaceId },
      orderBy: [{ horizon: 'asc' }, { priority: 'asc' }],
    })

    const metricSamples = samples.map((s) => ({
      status: s.status,
      rawAnswer: s.rawAnswer,
      analysis: s.analysis as any,
      platform: s.platform,
    }))

    const metrics = calculateMetrics({
      plannedSamples: run.totalUnits,
      runStatus: run.status,
      samples: metricSamples,
    })

    const now = new Date()
    const latestSampleUpdate = samples.reduce(
      (max, s) => (s.updatedAt > max ? s.updatedAt : max),
      new Date(0),
    )

    return {
      runId: run.id,
      projectId: run.projectId,
      name: run.id,
      runType: run.runType,
      status: run.status,
      reliability: metrics.reliability,
      scope: {
        platforms: (run.platformSnapshot as string[]) ?? [],
        samplesPerQuery: (run.samplingSnapshot as any)?.samplesPerQuery ?? 1,
        locale: (run.samplingSnapshot as any)?.locale ?? 'zh-CN',
        timezone: (run.samplingSnapshot as any)?.timezone ?? 'Asia/Shanghai',
        totalUnits: run.totalUnits,
      },
      metrics,
      queryTypeBreakdown: [],
      platformBreakdown: [],
      competitorMetrics: metrics.competitorLeadDeltas,
      findings: findings.map((f) => ({
        id: f.id,
        type: f.type,
        severity: f.severity,
        title: f.title,
        summary: f.summary,
        metric: f.metric,
        evidenceSampleIds: f.evidenceSampleIds as string[],
      })),
      actions: actions.map((a) => ({
        id: a.id,
        horizon: a.horizon,
        actionType: a.actionType,
        title: a.title,
        description: a.description,
        priority: a.priority,
        status: a.status,
      })),
      reportGeneratedAt: now.toISOString(),
      sourceSampleUpdatedAt: latestSampleUpdate.toISOString(),
    }
  }

  return {
    async get(workspaceId, runId) {
      const run = await getRun(workspaceId, runId)

      if (['RUNNING', 'DRAFT', 'READY'].includes(run.status)) {
        throw new DiagnosticError('REPORT_NOT_READY', 'REPORT_NOT_READY')
      }

      if (run.status === 'FAILED' || run.status === 'CANCELLED') {
        throw new DiagnosticError('NO_VALID_SAMPLES', 'NO_VALID_SAMPLES')
      }

      const samples = await prisma.diagnosticSample.findMany({
        where: { runId },
        select: { updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: 1,
      })

      const latestSampleUpdate = samples[0]?.updatedAt ?? new Date(0)

      const cache = await prisma.diagnosticReportCache.findFirst({
        where: { runId },
        orderBy: { reportVersion: 'desc' },
      })

      if (cache && cache.sourceSampleUpdatedAt >= latestSampleUpdate) {
        return cache.content as unknown as DiagnosticReport
      }

      const report = await generateReport(workspaceId, runId)

      await prisma.diagnosticReportCache.upsert({
        where: { runId_reportVersion: { runId, reportVersion: 1 } },
        create: {
          runId,
          reportVersion: 1,
          sourceSampleUpdatedAt: latestSampleUpdate,
          content: report as any,
        },
        update: {
          sourceSampleUpdatedAt: latestSampleUpdate,
          content: report as any,
        },
      })

      return report
    },

    async compare(workspaceId, baselineRunId, retestRunId) {
      const baseline = await getRun(workspaceId, baselineRunId)
      const retest = await getRun(workspaceId, retestRunId)

      const baselinePlatforms = new Set((baseline.platformSnapshot as string[]) ?? [])
      const retestPlatforms = new Set((retest.platformSnapshot as string[]) ?? [])

      const platformAdded = [...retestPlatforms].filter((p) => !baselinePlatforms.has(p))
      const platformRemoved = [...baselinePlatforms].filter((p) => !retestPlatforms.has(p))

      const baselineSampling = (baseline.samplingSnapshot as any) ?? {}
      const retestSampling = (retest.samplingSnapshot as any) ?? {}

      const baselineCompetitors = (baseline.competitorSnapshot as any[]) ?? []
      const retestCompetitors = (retest.competitorSnapshot as any[]) ?? []
      const baselineCompNames = new Set(baselineCompetitors.map((c) => c.name))
      const retestCompNames = new Set(retestCompetitors.map((c) => c.name))
      const compAdded = [...retestCompNames].filter((c) => !baselineCompNames.has(c))
      const compRemoved = [...baselineCompNames].filter((c) => !retestCompNames.has(c))

      const strictlyComparable =
        platformAdded.length === 0 &&
        platformRemoved.length === 0 &&
        compAdded.length === 0 &&
        compRemoved.length === 0 &&
        baselineSampling.samplesPerQuery === retestSampling.samplesPerQuery &&
        baselineSampling.locale === retestSampling.locale &&
        baselineSampling.timezone === retestSampling.timezone

      let baselineReport = null
      let retestReport = null
      try {
        baselineReport = await this.get(workspaceId, baselineRunId)
      } catch { /* baseline may not have report */ }
      try {
        retestReport = await this.get(workspaceId, retestRunId)
      } catch { /* retest may not have report */ }

      return {
        strictlyComparable,
        baselineRunId,
        retestRunId,
        queryDiffs: { added: [], removed: [] },
        platformDiffs: { added: platformAdded, removed: platformRemoved },
        competitorDiffs: { added: compAdded, removed: compRemoved },
        samplingDiff: {
          samplesPerQueryChanged: baselineSampling.samplesPerQuery !== retestSampling.samplesPerQuery,
          localeChanged: baselineSampling.locale !== retestSampling.locale,
          timezoneChanged: baselineSampling.timezone !== retestSampling.timezone,
        },
        baselineReport,
        retestReport,
      }
    },
  }
}
