import { describe, it, expect, vi } from 'vitest'
import { createRunService } from './run-service.js'
import { DiagnosticError } from './errors.js'
import {
  createEntitlementGuard,
  QuotaExceededError,
} from '../../platform/billing/entitlement-guard.js'
import { createUsageMeter } from '../../platform/billing/usage-meter.js'

function mockDeps() {
  const prisma: any = {
    diagnosticRun: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    diagnosticProject: {
      findFirst: vi.fn(),
    },
    diagnosticQuery: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    diagnosticRunQuery: {
      createMany: vi.fn(),
      findMany: vi.fn(),
    },
    diagnosticSample: {
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn(),
  }
  const registry = {
    get: vi.fn(),
    getRegisteredPlatforms: vi.fn(),
  }
  return { prisma, registry }
}

describe('RunService', () => {
  it('createDraft creates a draft run', async () => {
    const deps = mockDeps()
    const svc = createRunService(deps as any)
    deps.prisma.diagnosticProject.findFirst.mockResolvedValue({ id: 'project-1', workspaceId: 'ws-1' })
    deps.prisma.diagnosticRun.create.mockResolvedValue({
      id: 'run-1', workspaceId: 'ws-1', projectId: 'project-1',
      status: 'DRAFT', runType: 'BASELINE',
      draftConfig: null,
      createdAt: new Date(), updatedAt: new Date(),
    })

    const result = await svc.createDraft('ws-1', {
      projectId: 'project-1',
      queryIds: ['q1', 'q2'],
      platforms: ['deepseek'],
      samplesPerQuery: 1,
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
    })
    expect(result.status).toBe('DRAFT')
  })

  it('updateDraft works when run is DRAFT', async () => {
    const deps = mockDeps()
    const svc = createRunService(deps as any)
    deps.prisma.diagnosticRun.findFirst.mockResolvedValue({
      id: 'run-1', workspaceId: 'ws-1', status: 'DRAFT',
    })
    deps.prisma.diagnosticRun.update.mockResolvedValue({ id: 'run-1', status: 'DRAFT' })

    await svc.updateDraft('ws-1', 'run-1', { queryIds: ['q1'], platforms: ['deepseek'], samplesPerQuery: 2, locale: 'en', timezone: 'UTC' })
    expect(deps.prisma.diagnosticRun.update).toHaveBeenCalled()
  })

  it('rejects updateDraft when run is READY', async () => {
    const deps = mockDeps()
    const svc = createRunService(deps as any)
    deps.prisma.diagnosticRun.findFirst.mockResolvedValue({
      id: 'run-1', workspaceId: 'ws-1', status: 'READY',
    })

    await expect(svc.updateDraft('ws-1', 'run-1', { queryIds: ['q1'], platforms: ['deepseek'], samplesPerQuery: 1, locale: 'en', timezone: 'UTC' }))
      .rejects.toThrow(DiagnosticError)
  })

  it('rejects scope > 500 during validate', async () => {
    const deps = mockDeps()
    const svc = createRunService(deps as any)
    deps.prisma.diagnosticRun.findFirst.mockResolvedValue({
      id: 'run-1', workspaceId: 'ws-1', status: 'DRAFT',
      draftConfig: { queryIds: Array.from({ length: 100 }, (_, i) => `q${i}`), platforms: ['deepseek', 'qwen', 'doubao', 'ernie', 'chatgpt', 'gemini'], samplesPerQuery: 3, locale: 'zh-CN', timezone: 'Asia/Shanghai' },
      projectId: 'project-1',
    })
    deps.prisma.diagnosticProject.findFirst.mockResolvedValue({
      id: 'project-1', workspaceId: 'ws-1',
      brandName: 'Test', brandAliases: [], competitors: [],
    })

    const result = await svc.validate('ws-1', 'run-1')
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors.some(e => e.code === 'RUN_SCOPE_TOO_LARGE')).toBe(true)
  })

  it('markReady freezes snapshots in transaction', async () => {
    const deps = mockDeps()
    const svc = createRunService(deps as any)
    deps.prisma.diagnosticRun.findFirst.mockResolvedValue({
      id: 'run-1', workspaceId: 'ws-1', projectId: 'project-1', status: 'DRAFT',
      draftConfig: { queryIds: ['q1', 'q2'], platforms: ['deepseek'], samplesPerQuery: 1, locale: 'zh-CN', timezone: 'Asia/Shanghai' },
    })
    deps.prisma.diagnosticProject.findFirst.mockResolvedValue({
      id: 'project-1', workspaceId: 'ws-1',
      brandName: 'Test', brandAliases: [], brandDomain: 'test.com', competitors: [],
    })
    deps.prisma.diagnosticQuery.findMany.mockResolvedValue([
      { id: 'q1', queryText: 'what is X?', queryType: 'BRAND', intentLabel: null, targetAudience: null, mappedPageUrl: null, priority: 3 },
      { id: 'q2', queryText: 'who uses Y?', queryType: 'CATEGORY', intentLabel: null, targetAudience: null, mappedPageUrl: null, priority: 3 },
    ])
    deps.prisma.$transaction.mockImplementation(async (fn: any) => {
      if (typeof fn === 'function') return fn(deps.prisma)
      return fn
    })
    deps.prisma.diagnosticRun.update.mockResolvedValue({ id: 'run-1', status: 'READY' })

    const result = await svc.markReady('ws-1', 'run-1')
    expect(result.status).toBe('READY')
    expect(deps.prisma.$transaction).toHaveBeenCalled()
  })

  it('start creates samples and updates status', async () => {
    const deps = mockDeps()
    const dispatchRun = vi.fn().mockResolvedValue(undefined)
    const svc = createRunService({ ...deps, dispatchRun } as any)
    deps.prisma.diagnosticRun.findFirst.mockResolvedValue({
      id: 'run-1', workspaceId: 'ws-1', projectId: 'project-1', status: 'READY',
      platformSnapshot: ['deepseek'],
      samplingSnapshot: { samplesPerQuery: 1, locale: 'zh-CN', timezone: 'Asia/Shanghai' },
    })
    deps.prisma.diagnosticRunQuery.findMany.mockResolvedValue([
      { id: 'rq-1', queryText: 'what is X?', queryType: 'BRAND' },
    ])
    deps.prisma.$transaction.mockImplementation(async (fn: any) => {
      if (typeof fn === 'function') return fn(deps.prisma)
      return fn
    })
    deps.prisma.diagnosticRun.update.mockResolvedValue({
      id: 'run-1', status: 'RUNNING', totalUnits: 1,
    })

    const result = await svc.start('ws-1', 'run-1')
    expect(result.status).toBe('RUNNING')
  })

  it('cancel sets PENDING samples to CANCELLED', async () => {
    const deps = mockDeps()
    const svc = createRunService(deps as any)
    deps.prisma.diagnosticRun.findFirst.mockResolvedValue({
      id: 'run-1', workspaceId: 'ws-1', status: 'RUNNING',
    })
    deps.prisma.diagnosticRun.update.mockResolvedValue({ id: 'run-1', status: 'CANCELLED' })
    deps.prisma.diagnosticSample.updateMany.mockResolvedValue({ count: 5 })

    const result = await svc.cancel('ws-1', 'run-1')
    expect(result.status).toBe('CANCELLED')
    expect(deps.prisma.diagnosticSample.updateMany).toHaveBeenCalled()
  })

  it('rejects cancel from COMPLETED status', async () => {
    const deps = mockDeps()
    const svc = createRunService(deps as any)
    deps.prisma.diagnosticRun.findFirst.mockResolvedValue({
      id: 'run-1', workspaceId: 'ws-1', status: 'COMPLETED',
    })

    await expect(svc.cancel('ws-1', 'run-1')).rejects.toThrow(DiagnosticError)
  })

  it('validates NOT_FOUND for other workspace', async () => {
    const deps = mockDeps()
    const svc = createRunService(deps as any)
    deps.prisma.diagnosticRun.findFirst.mockResolvedValue(null)

    await expect(svc.get('ws-2', 'run-1')).rejects.toThrow(DiagnosticError)
  })

  it('rejects markReady from non-DRAFT status', async () => {
    const deps = mockDeps()
    const svc = createRunService(deps as any)
    deps.prisma.diagnosticRun.findFirst.mockResolvedValue({
      id: 'run-1', workspaceId: 'ws-1', status: 'RUNNING',
    })

    await expect(svc.markReady('ws-1', 'run-1')).rejects.toThrow(DiagnosticError)
  })
})

// ---------------------------------------------------------------------------
// 任务 9：计费检查点——diagnosticRunsPerMonth 软限 + samplesPerRun 上限 +
// DIAGNOSTIC_RUN 计量（enforcement on 超限/告警、off 放行且计量照记）
// ---------------------------------------------------------------------------

describe('RunService 计费检查点（任务 9）', () => {
  const LIMITS = {
    maxWorkspaces: 10,
    diagnosticRunsPerMonth: 50,
    samplesPerRun: 5,
    allowedPlatforms: [],
  }

  function assemble(opts: {
    enforcement: () => boolean
    monthlyUsage?: number
    oeRow?: Record<string, unknown> | null
  }) {
    const deps = mockDeps()
    deps.prisma.workspace = {
      findUnique: vi.fn(async () => ({ id: 'ws-1', organizationId: 'org-1' })),
    }
    deps.prisma.organizationEntitlement = {
      findUnique: vi.fn(async () =>
        opts.oeRow === undefined ? { organizationId: 'org-1', limits: LIMITS } : opts.oeRow,
      ),
    }
    const meterPrisma: any = {
      usageRecord: {
        createMany: vi.fn(async () => ({ count: 0 })),
        aggregate: vi.fn(async () => ({ _sum: { quantity: opts.monthlyUsage ?? 0 } })),
      },
    }
    const meterAudit = { record: vi.fn(async () => {}), list: vi.fn(async () => ({ items: [], total: 0 })) }
    const meter = createUsageMeter({ prisma: meterPrisma })
    const guard = createEntitlementGuard({
      prisma: deps.prisma as any,
      meter,
      audit: meterAudit as any,
      enforcement: opts.enforcement,
    })
    const svc = createRunService({ ...deps, billing: { guard, meter } } as any)
    return { deps, svc, meter, meterAudit, meterPrisma }
  }

  const DRAFT_INPUT = {
    projectId: 'project-1',
    queryIds: ['q1'],
    platforms: ['deepseek'],
    samplesPerQuery: 3,
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
  }

  it('enforcement on 且 samplesPerQuery > samplesPerRun → 硬拒 QuotaExceededError，不建 run', async () => {
    const { deps, svc } = assemble({ enforcement: () => true })
    deps.prisma.diagnosticRun.create.mockResolvedValue({ id: 'run-1', status: 'DRAFT' })

    await expect(svc.createDraft('ws-1', { ...DRAFT_INPUT, samplesPerQuery: 6 })).rejects.toThrow(
      QuotaExceededError,
    )
    expect(deps.prisma.diagnosticRun.create).not.toHaveBeenCalled()
  })

  it('enforcement on 月度超额：软限不拦截——run 照常创建 + audit 告警 + meter 计量', async () => {
    const { deps, svc, meter, meterAudit } = assemble({
      enforcement: () => true,
      monthlyUsage: 50,
    })
    deps.prisma.diagnosticRun.create.mockResolvedValue({ id: 'run-1', status: 'DRAFT' })

    const run = await svc.createDraft('ws-1', DRAFT_INPUT)
    expect(run.status).toBe('DRAFT')
    expect(deps.prisma.diagnosticRun.create).toHaveBeenCalledTimes(1)
    expect(meterAudit.record).toHaveBeenCalledWith({
      actorType: 'SYSTEM',
      action: 'quota.soft_exceeded',
      organizationId: 'org-1',
      diff: { kind: 'diagnosticRunsPerMonth', current: 50, limit: 50, organizationId: 'org-1' },
    })
    expect(meter.pending()).toBe(1)
  })

  it('enforcement on 未超额：不告警，照常计量 DIAGNOSTIC_RUN', async () => {
    const { deps, svc, meter, meterAudit, meterPrisma } = assemble({
      enforcement: () => true,
      monthlyUsage: 4,
    })
    deps.prisma.diagnosticRun.create.mockResolvedValue({ id: 'run-1', status: 'DRAFT' })

    await svc.createDraft('ws-1', DRAFT_INPUT)
    expect(meterAudit.record).not.toHaveBeenCalled()
    await meter.flush()
    const rows = meterPrisma.usageRecord.createMany.mock.calls[0][0].data
    expect(rows[0]).toMatchObject({
      organizationId: 'org-1',
      workspaceId: 'ws-1',
      kind: 'DIAGNOSTIC_RUN',
      quantity: 1,
    })
  })

  it('enforcement off：不查配额不告警（samplesPerRun 也不拦），计量照记（Ruling 1）', async () => {
    const { deps, svc, meter, meterAudit } = assemble({ enforcement: () => false })
    deps.prisma.diagnosticRun.create.mockResolvedValue({ id: 'run-1', status: 'DRAFT' })

    const run = await svc.createDraft('ws-1', { ...DRAFT_INPUT, samplesPerQuery: 999 })
    expect(run.status).toBe('DRAFT')
    expect(deps.prisma.organizationEntitlement.findUnique).not.toHaveBeenCalled()
    expect(meterAudit.record).not.toHaveBeenCalled()
    expect(meter.pending()).toBe(1)
  })

  it('createRetest 同走检查点：基线采样数超限 → 硬拒', async () => {
    const { deps, svc } = assemble({ enforcement: () => true })
    deps.prisma.diagnosticRun.findFirst.mockResolvedValue({
      id: 'run-base',
      workspaceId: 'ws-1',
      status: 'COMPLETED',
      projectId: 'project-1',
      draftConfig: { samplesPerQuery: 9 },
    })

    await expect(svc.createRetest('ws-1', 'run-base')).rejects.toThrow(QuotaExceededError)
    expect(deps.prisma.diagnosticRun.create).not.toHaveBeenCalled()
  })

  it('审查补漏（Important-2）：创建时 samplesPerQuery 通过，updateDraft 抬高超过 samplesPerRun → 硬拒', async () => {
    const { deps, svc } = assemble({ enforcement: () => true })
    // 创建时 samplesPerQuery=3（<= limit 5）通过
    deps.prisma.diagnosticRun.create.mockResolvedValue({ id: 'run-1', status: 'DRAFT' })
    await svc.createDraft('ws-1', DRAFT_INPUT)
    expect(deps.prisma.diagnosticRun.create).toHaveBeenCalledTimes(1)

    // 草稿更新把 samplesPerQuery 抬到 6（> limit 5）→ QuotaExceededError，不落 update
    deps.prisma.diagnosticRun.findFirst.mockResolvedValue({
      id: 'run-1',
      workspaceId: 'ws-1',
      status: 'DRAFT',
      draftConfig: null,
    })
    deps.prisma.diagnosticRun.update.mockResolvedValue({ id: 'run-1', status: 'DRAFT' })
    await expect(
      svc.updateDraft('ws-1', 'run-1', {
        queryIds: ['q1'],
        platforms: ['deepseek'],
        samplesPerQuery: 6,
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
      }),
    ).rejects.toThrow(QuotaExceededError)
    expect(deps.prisma.diagnosticRun.update).not.toHaveBeenCalled()

    // 抬到 limit 内（5）放行
    await expect(
      svc.updateDraft('ws-1', 'run-1', {
        queryIds: ['q1'],
        platforms: ['deepseek'],
        samplesPerQuery: 5,
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
      }),
    ).resolves.toBeDefined()
    expect(deps.prisma.diagnosticRun.update).toHaveBeenCalledTimes(1)
  })

  it('审查补漏（Important-2）回归：enforcement off 时 updateDraft 不复查采样上限', async () => {
    const { deps, svc } = assemble({ enforcement: () => false })
    deps.prisma.diagnosticRun.findFirst.mockResolvedValue({
      id: 'run-1',
      workspaceId: 'ws-1',
      status: 'DRAFT',
      draftConfig: null,
    })
    deps.prisma.diagnosticRun.update.mockResolvedValue({ id: 'run-1', status: 'DRAFT' })
    await expect(
      svc.updateDraft('ws-1', 'run-1', {
        queryIds: ['q1'],
        platforms: ['deepseek'],
        samplesPerQuery: 999,
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
      }),
    ).resolves.toBeDefined()
    expect(deps.prisma.organizationEntitlement.findUnique).not.toHaveBeenCalled()
  })
})
