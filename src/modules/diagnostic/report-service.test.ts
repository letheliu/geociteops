import { describe, it, expect, vi } from 'vitest'
import { createReportService } from './report-service.js'
import { DiagnosticError } from './errors.js'

describe('ReportService', () => {
  it('returns report for COMPLETED run', async () => {
    const prisma: any = {
      diagnosticReportCache: { findFirst: vi.fn(), upsert: vi.fn() },
      diagnosticRun: { findFirst: vi.fn() },
      diagnosticRunQuery: { findMany: vi.fn() },
      diagnosticSample: { findMany: vi.fn() },
      diagnosticFinding: { findMany: vi.fn() },
      diagnosticAction: { findMany: vi.fn() },
    }
    prisma.diagnosticRun.findFirst.mockResolvedValue({
      id: 'run-1', projectId: 'project-1', workspaceId: 'ws-1',
      status: 'COMPLETED', runType: 'BASELINE',
      totalUnits: 10, completedUnits: 8, failedUnits: 2,
      platformSnapshot: ['deepseek', 'qwen'],
      samplingSnapshot: { samplesPerQuery: 1, locale: 'zh-CN', timezone: 'Asia/Shanghai' },
      createdAt: new Date(),
    })
    prisma.diagnosticSample.findMany.mockResolvedValue([
      { id: 's-1', status: 'SUCCEEDED', rawAnswer: 'yes', platform: 'deepseek', analysis: { brandMentioned: true, brandSourceCited: true, rankInAnswer: 1, sourceRank: 1, sovScore: 0.8, sourceCitationRate: 0.5, competitors: [] }, updatedAt: new Date() },
    ])
    prisma.diagnosticFinding.findMany.mockResolvedValue([])
    prisma.diagnosticAction.findMany.mockResolvedValue([])
    prisma.diagnosticReportCache.findFirst.mockResolvedValue(null)

    const svc = createReportService({ prisma } as any)
    const report = await svc.get('ws-1', 'run-1')

    expect(report.runId).toBe('run-1')
    expect(report.metrics.plannedSamples).toBe(10)
  })

  it('throws REPORT_NOT_READY for RUNNING run', async () => {
    const prisma: any = {
      diagnosticRun: { findFirst: vi.fn() },
    }
    prisma.diagnosticRun.findFirst.mockResolvedValue({
      id: 'run-1', status: 'RUNNING',
    })

    const svc = createReportService({ prisma } as any)
    await expect(svc.get('ws-1', 'run-1')).rejects.toThrow(DiagnosticError)
  })

  it('invalidates cache when samples updated', async () => {
    const prisma: any = {
      diagnosticReportCache: { findFirst: vi.fn(), upsert: vi.fn() },
      diagnosticRun: { findFirst: vi.fn() },
      diagnosticRunQuery: { findMany: vi.fn() },
      diagnosticSample: { findMany: vi.fn() },
      diagnosticFinding: { findMany: vi.fn() },
      diagnosticAction: { findMany: vi.fn() },
    }
    const oldDate = new Date('2024-01-01')
    const newDate = new Date('2024-06-01')
    prisma.diagnosticRun.findFirst.mockResolvedValue({
      id: 'run-1', projectId: 'project-1', workspaceId: 'ws-1',
      status: 'COMPLETED', runType: 'BASELINE',
      totalUnits: 1, completedUnits: 1, failedUnits: 0,
      platformSnapshot: ['deepseek'],
      samplingSnapshot: { samplesPerQuery: 1, locale: 'zh-CN', timezone: 'Asia/Shanghai' },
      createdAt: new Date(),
    })
    prisma.diagnosticSample.findMany.mockResolvedValue([
      { id: 's-1', status: 'SUCCEEDED', rawAnswer: 'yes', platform: 'deepseek', analysis: { brandMentioned: true, brandSourceCited: true, rankInAnswer: 1, sourceRank: 1, sovScore: 0.8, sourceCitationRate: 0.5, competitors: [] }, updatedAt: newDate },
    ])
    prisma.diagnosticFinding.findMany.mockResolvedValue([])
    prisma.diagnosticAction.findMany.mockResolvedValue([])
    prisma.diagnosticReportCache.findFirst.mockResolvedValue({
      id: 'cache-1', reportVersion: 1, sourceSampleUpdatedAt: oldDate, content: {},
    })

    const svc = createReportService({ prisma } as any)
    await svc.get('ws-1', 'run-1')

    // Cache should be regenerated
    expect(prisma.diagnosticReportCache.upsert).toHaveBeenCalled()
  })

  it('detects non-strictly-comparable retest', async () => {
    const prisma: any = {
      diagnosticRun: { findFirst: vi.fn() },
      diagnosticSample: { findMany: vi.fn() },
      diagnosticFinding: { findMany: vi.fn() },
      diagnosticAction: { findMany: vi.fn() },
      diagnosticRunQuery: { findMany: vi.fn() },
      diagnosticReportCache: { findFirst: vi.fn() },
    }
    prisma.diagnosticRun.findFirst
      .mockResolvedValueOnce({
        id: 'baseline-1', workspaceId: 'ws-1', projectId: 'project-1',
        status: 'COMPLETED', runType: 'BASELINE',
        totalUnits: 5, completedUnits: 5, failedUnits: 0,
        platformSnapshot: ['deepseek'],
        samplingSnapshot: { samplesPerQuery: 1, locale: 'zh-CN', timezone: 'Asia/Shanghai' },
        brandSnapshot: { brandName: 'Test' },
        competitorSnapshot: [],
        scopeDiff: null,
        createdAt: new Date(),
      })
      .mockResolvedValueOnce({
        id: 'retest-1', workspaceId: 'ws-1', projectId: 'project-1',
        status: 'COMPLETED', runType: 'RETEST',
        totalUnits: 10, completedUnits: 10, failedUnits: 0,
        platformSnapshot: ['deepseek', 'qwen'],
        samplingSnapshot: { samplesPerQuery: 2, locale: 'en', timezone: 'UTC' },
        brandSnapshot: { brandName: 'Test' },
        competitorSnapshot: [],
        scopeDiff: { platformDiffs: { added: ['qwen'], removed: [] }, samplingDiff: { samplesPerQueryChanged: true, localeChanged: true, timezoneChanged: true } },
        createdAt: new Date(),
      })
    prisma.diagnosticSample.findMany.mockResolvedValue([])
    prisma.diagnosticFinding.findMany.mockResolvedValue([])
    prisma.diagnosticAction.findMany.mockResolvedValue([])

    const svc = createReportService({ prisma } as any)
    const comparison = await svc.compare('ws-1', 'baseline-1', 'retest-1')

    expect(comparison.strictlyComparable).toBe(false)
  })
})
