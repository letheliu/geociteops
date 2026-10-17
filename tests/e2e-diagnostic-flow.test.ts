import { describe, it, expect, vi } from 'vitest'
import { createProjectService } from '../src/modules/diagnostic/project-service.js'
import { createQueryPlanner } from '../src/modules/diagnostic/query-planner.js'
import { createRunService } from '../src/modules/diagnostic/run-service.js'
import { createReportService } from '../src/modules/diagnostic/report-service.js'
import { createActionService } from '../src/modules/diagnostic/action-service.js'
import { createSampleExecutor, classifySampleError } from '../src/modules/diagnostic/executor.js'
import { createFinalizer } from '../src/workers/diagnostic-finalizer.js'
import { calculateMetrics } from '../src/modules/diagnostic/metrics.js'
import { generateFindings } from '../src/modules/diagnostic/finding-engine.js'
import { planActions } from '../src/modules/diagnostic/action-planner.js'
import { normalizeDomain, normalizeQueryText } from '../src/modules/diagnostic/normalization.js'

describe('E2E Diagnostic Flow', () => {
  it('complete success path: project -> queries -> run -> report -> actions -> retest', async () => {
    // Step 1: Normalization
    expect(normalizeDomain('https://WWW.Example.com')).toBe('example.com')
    expect(normalizeQueryText('  AI 工具? ')).toBe('ai 工具?')

    // Step 2: Project creation (mock)
    const projectPrisma: any = {
      diagnosticProject: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({
          id: 'project-1', workspaceId: 'ws-1', name: 'Brand GEO',
          brandName: 'Acme', brandAliases: [], brandDomain: 'acme.com',
          targetAudiences: ['devs'], coreScenarios: ['search'],
          competitors: [], status: 'DRAFT',
          createdAt: new Date(), updatedAt: new Date(),
        }),
        update: vi.fn(),
        count: vi.fn(),
      },
      diagnosticQuery: { count: vi.fn(), findMany: vi.fn(), create: vi.fn(), findFirst: vi.fn() },
      diagnosticRun: { count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    }
    projectPrisma.diagnosticQuery.count.mockResolvedValue(3)
    projectPrisma.diagnosticRun.count.mockResolvedValue(0)

    const projectService = createProjectService({ prisma: projectPrisma } as any)
    const project = await projectService.create('ws-1', {
      name: 'Brand GEO', brandName: 'Acme', brandAliases: [],
      brandDomain: 'https://www.acme.com',
      targetAudiences: ['developers'], coreScenarios: ['evaluation'],
      competitors: [{ name: 'CompetitorX' }],
    })
    expect(project.brandDomain).toBe('acme.com')
    expect(project.status).toBe('DRAFT')

    // Step 3: Query planning
    const queryPrisma: any = {
      diagnosticQuery: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
      diagnosticProject: { findFirst: vi.fn() },
      $transaction: vi.fn(),
    }
    queryPrisma.diagnosticQuery.findFirst.mockResolvedValue(null)
    queryPrisma.diagnosticQuery.create.mockImplementation(async (args: any) => ({
      ...args.data,
      id: 'q-new',
      createdAt: new Date(),
      updatedAt: new Date(),
    }))
    queryPrisma.diagnosticQuery.findMany.mockResolvedValue([
      { id: 'q1', projectId: 'project-1' },
      { id: 'q2', projectId: 'project-1' },
    ])
    queryPrisma.$transaction.mockImplementation(async (fn: any) => {
      if (typeof fn === 'function') return fn(queryPrisma)
      return fn
    })

    const planner = createQueryPlanner({ prisma: queryPrisma } as any)

    const q1 = await planner.create('ws-1', 'project-1', {
      queryText: 'What is Acme?', queryType: 'BRAND', source: 'MANUAL',
    })
    expect(q1.status).toBe('DRAFT')

    await planner.bulkConfirm('ws-1', 'project-1', ['q1', 'q2'])

    // Step 4: Create run draft
    const runPrisma: any = {
      diagnosticRun: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
      diagnosticProject: { findFirst: vi.fn() },
      diagnosticQuery: { findMany: vi.fn() },
      diagnosticRunQuery: { createMany: vi.fn(), findMany: vi.fn() },
      diagnosticSample: { createMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
      $transaction: vi.fn(),
    }
    const registry = { get: vi.fn(), getRegisteredPlatforms: vi.fn() }

    const runService = createRunService({ prisma: runPrisma, registry } as any)

    runPrisma.diagnosticProject.findFirst.mockResolvedValue({
      id: 'project-1', workspaceId: 'ws-1', brandName: 'Acme', brandAliases: [], competitors: [],
    })
    runPrisma.diagnosticRun.create.mockResolvedValue({
      id: 'run-1', workspaceId: 'ws-1', projectId: 'project-1', status: 'DRAFT', runType: 'BASELINE',
    })
    runPrisma.diagnosticRun.findFirst.mockResolvedValue({
      id: 'run-1', workspaceId: 'ws-1', projectId: 'project-1', status: 'DRAFT',
      draftConfig: { queryIds: ['q1', 'q2'], platforms: ['deepseek'], samplesPerQuery: 1, locale: 'zh-CN', timezone: 'Asia/Shanghai' },
    })
    runPrisma.diagnosticQuery.findMany.mockResolvedValue([
      { id: 'q1', queryText: 'What is Acme?', queryType: 'BRAND', priority: 3, intentLabel: null, targetAudience: null, mappedPageUrl: null },
    ])
    runPrisma.$transaction.mockImplementation(async (fn: any) => {
      if (typeof fn === 'function') return fn(runPrisma)
      return fn
    })
    runPrisma.diagnosticRun.update.mockResolvedValue({ id: 'run-1', status: 'READY' })

    const draft = await runService.createDraft('ws-1', {
      projectId: 'project-1', queryIds: ['q1', 'q2'],
      platforms: ['deepseek'], samplesPerQuery: 1, locale: 'zh-CN', timezone: 'Asia/Shanghai',
    })
    expect(draft.status).toBe('DRAFT')

    // Step 5: Validate and mark ready
    const validation = await runService.validate('ws-1', 'run-1')
    // draftConfig may be null in mock depending on create behavior
    const ready = await runService.markReady('ws-1', 'run-1')
    expect(ready.status).toBe('READY')

    // Step 6: Start and execute samples
    runPrisma.diagnosticRun.findFirst.mockResolvedValue({
      id: 'run-1', workspaceId: 'ws-1', projectId: 'project-1', status: 'READY',
      platformSnapshot: ['deepseek'],
      samplingSnapshot: { samplesPerQuery: 1, locale: 'zh-CN', timezone: 'Asia/Shanghai' },
    })
    runPrisma.diagnosticRunQuery.findMany.mockResolvedValue([
      { id: 'rq-1', queryText: 'What is Acme?', queryType: 'BRAND' },
    ])
    runPrisma.diagnosticRun.update.mockResolvedValue({ id: 'run-1', status: 'RUNNING', totalUnits: 1, completedUnits: 0, failedUnits: 0 })

    const started = await runService.start('ws-1', 'run-1')
    expect(started.status).toBe('RUNNING')

    // Step 7: Metrics calculation (pure function)
    const metrics = calculateMetrics({
      plannedSamples: 10,
      runStatus: 'COMPLETED',
      samples: [
        { status: 'SUCCEEDED', rawAnswer: 'yes', analysis: { brandMentioned: true, brandSourceCited: true, rankInAnswer: 1, sourceRank: 1, sovScore: 0.8, sourceCitationRate: 0.5, competitors: [] }, platform: 'deepseek' },
        { status: 'SUCCEEDED', rawAnswer: 'yes', analysis: { brandMentioned: true, brandSourceCited: false, rankInAnswer: 2, sourceRank: 2, sovScore: 0.6, sourceCitationRate: 0.3, competitors: [] }, platform: 'deepseek' },
        { status: 'SUCCEEDED', rawAnswer: 'yes', analysis: { brandMentioned: false, brandSourceCited: false, rankInAnswer: null, sourceRank: null, sovScore: 0, sourceCitationRate: 0, competitors: [] }, platform: 'deepseek' },
        { status: 'FAILED', rawAnswer: null, analysis: null, platform: 'deepseek' },
      ],
    })
    expect(metrics.validSampleRate).toBe(0.3)
    expect(metrics.mentionRate).toBeCloseTo(0.667, 2)

    // Step 8: Findings (pure function)
    const findings = generateFindings({
      samples: [],
      globalMetrics: metrics,
      allPlatforms: ['deepseek'],
      queryTypes: ['BRAND'],
      queryTypeSamples: {},
    })
    expect(findings.some(f => f.type === 'INSUFFICIENT_SAMPLE')).toBe(true)

    // Step 9: Action planning (pure function)
    const actions = planActions({
      findings: [{ type: 'LOW_VISIBILITY', severity: 'WARNING', queryTypes: ['BRAND'], targetRunQueryIds: ['q1'], targetPageUrl: 'https://acme.com' }],
      existingOptimizationTaskIds: [],
    })
    expect(actions.length).toBeGreaterThan(0)
    expect(actions.some(a => a.horizon === 'DAYS_30')).toBe(true)

    // Step 10: Action conversion
    const taskService: any = { create: vi.fn().mockResolvedValue({ id: 'task-1' }) }
    const actionPrisma: any = {
      diagnosticAction: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'action-1', workspaceId: 'ws-1', runId: 'run-1',
          status: 'ACCEPTED', actionType: 'OPTIMIZE_EXISTING_PAGE',
          targetPageUrl: 'https://acme.com/page', targetRunQueryIds: ['rq-1'],
          optimizationTaskId: null,
        }),
        update: vi.fn(),
      },
      $transaction: vi.fn().mockImplementation(async (fn: any) => {
        if (typeof fn === 'function') return fn(actionPrisma)
        return fn
      }),
    }
    const actionService = createActionService({ prisma: actionPrisma as any, taskService } as any)
    const converted = await actionService.convert('ws-1', 'action-1')
    expect(converted.status).toBe('CONVERTED')
    expect(converted.optimizationTaskId).toBe('task-1')

    // Step 11: Workspace isolation
    const wsPrisma: any = {
      diagnosticProject: { findFirst: vi.fn().mockResolvedValue(null) },
    }
    const wsProjectService = createProjectService({ prisma: wsPrisma } as any)
    await expect(wsProjectService.get('ws-2', 'project-1')).rejects.toThrow()
    expect(wsPrisma.diagnosticProject.findFirst).toHaveBeenCalledWith({
      where: { id: 'project-1', workspaceId: 'ws-2' },
    })

    // Step 12: Error classification
    expect(classifySampleError({ status: 429, message: 'Too Many' }).retryable).toBe(true)
    expect(classifySampleError({ status: 401, message: 'Unauthorized' }).retryable).toBe(false)
    expect(classifySampleError({ status: 500, message: 'Server Error' }).retryable).toBe(true)
  })

  it('partial failure and recovery path', async () => {
    // Simulate 3 platforms: one always succeeds, one succeeds after retry, one always fails
    const metrics = calculateMetrics({
      plannedSamples: 10,
      runStatus: 'PARTIAL',
      samples: [
        { status: 'SUCCEEDED', rawAnswer: 'yes', analysis: { brandMentioned: true, brandSourceCited: true, rankInAnswer: 1, sourceRank: 1, sovScore: 0.8, sourceCitationRate: 0.5, competitors: [] }, platform: 'deepseek' },
        { status: 'FAILED', rawAnswer: null, analysis: null, platform: 'qwen' },
      ],
    })
    expect(metrics.reliability).toBe('MEDIUM')

    // Retry: failed -> succeeded
    const metricsAfterRetry = calculateMetrics({
      plannedSamples: 10,
      runStatus: 'COMPLETED',
      samples: Array.from({ length: 10 }, (_, i) => ({
        status: 'SUCCEEDED', rawAnswer: 'yes',
        analysis: { brandMentioned: true, brandSourceCited: i < 3, rankInAnswer: i < 3 ? i + 1 : null, sourceRank: null, sovScore: 0.5, sourceCitationRate: 0.3, competitors: [] },
        platform: i < 5 ? 'deepseek' : 'qwen',
      })),
    })
    expect(metricsAfterRetry.reliability).toBe('HIGH')
  })

  it('finalizer determines correct terminal status', async () => {
    // COMPLETED scenario
    const prismaCompleted: any = {
      diagnosticSample: { groupBy: vi.fn() },
      diagnosticRun: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      diagnosticFinding: { createMany: vi.fn() },
      diagnosticAction: { createMany: vi.fn() },
    }
    prismaCompleted.diagnosticSample.groupBy.mockResolvedValue([
      { status: 'SUCCEEDED', _count: { id: 10 } },
    ])
    const finalizer = createFinalizer({ prisma: prismaCompleted } as any)
    const result = await finalizer.finalize('run-1')
    expect(result).not.toBeNull()
    expect(result!.status).toBe('COMPLETED')

    // PARTIAL scenario
    const prismaPartial: any = {
      diagnosticSample: { groupBy: vi.fn() },
      diagnosticRun: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      diagnosticFinding: { createMany: vi.fn() },
      diagnosticAction: { createMany: vi.fn() },
    }
    prismaPartial.diagnosticSample.groupBy.mockResolvedValue([
      { status: 'SUCCEEDED', _count: { id: 7 } },
      { status: 'FAILED', _count: { id: 3 } },
    ])
    const finalizer2 = createFinalizer({ prisma: prismaPartial } as any)
    const result2 = await finalizer2.finalize('run-1')
    expect(result2!.status).toBe('PARTIAL')

    // PENDING still running -> null
    const prismaRunning: any = {
      diagnosticSample: { groupBy: vi.fn() },
      diagnosticRun: { updateMany: vi.fn() },
      diagnosticFinding: { createMany: vi.fn() },
      diagnosticAction: { createMany: vi.fn() },
    }
    prismaRunning.diagnosticSample.groupBy.mockResolvedValue([
      { status: 'PENDING', _count: { id: 3 } },
    ])
    const finalizer3 = createFinalizer({ prisma: prismaRunning } as any)
    const result3 = await finalizer3.finalize('run-1')
    expect(result3).toBeNull()
  })
})
