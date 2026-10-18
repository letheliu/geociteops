import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueryLibraryService } from './query-library.js'
import { createEntitlementGuard } from '../../platform/billing/entitlement-guard.js'
import { createUsageMeter } from '../../platform/billing/usage-meter.js'

function mockPrisma() {
  return {
    citationQuery: {
      create: vi.fn().mockImplementation(async (args: any) => ({
        id: 'q-1',
        ...args.data,
        status: 'ACTIVE',
      })),
      findMany: vi.fn().mockResolvedValue([
        { id: 'q1', queryText: 'AI设计工具', status: 'ACTIVE', workspaceId: 'w1' },
      ]),
      update: vi.fn().mockImplementation(async (args: any) => ({
        id: args.where.id,
        ...args.data,
      })),
      delete: vi.fn().mockResolvedValue({ id: 'q1' }),
    },
    // M2 §3.0：generateQueries 先查组织来源判试用租户（缺省正式组织 = 既有行为不受影响）
    workspace: {
      findUnique: vi.fn().mockResolvedValue({ id: 'w1', organizationId: 'org-1' }),
    },
    organization: {
      findUnique: vi.fn().mockResolvedValue({ id: 'org-1', source: 'PLATFORM' }),
    },
  } as any
}

describe('query library service', () => {
  let prisma: ReturnType<typeof mockPrisma>
  beforeEach(() => {
    prisma = mockPrisma()
  })

  it('addQuery 创建 MANUAL query', async () => {
    const svc = createQueryLibraryService(prisma)
    const q = await svc.addQuery({
      workspaceId: 'w1',
      queryText: 'AI设计工具',
      source: 'MANUAL',
    })
    expect(q.id).toBe('q-1')
    expect(prisma.citationQuery.create).toHaveBeenCalled()
    const data = prisma.citationQuery.create.mock.calls[0][0].data
    expect(data.source).toBe('MANUAL')
    expect(data.status).toBe('ACTIVE')
  })

  it('listActive 返回 ACTIVE 状态 query', async () => {
    const svc = createQueryLibraryService(prisma)
    const list = await svc.listActive('w1')
    expect(list).toHaveLength(1)
    expect(list[0].queryText).toBe('AI设计工具')
    expect(prisma.citationQuery.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'w1', status: 'ACTIVE' },
    })
  })

  it('pauseQuery 设置状态为 PAUSED', async () => {
    const svc = createQueryLibraryService(prisma)
    await svc.pauseQuery('q1')
    expect(prisma.citationQuery.update).toHaveBeenCalledWith({
      where: { id: 'q1' },
      data: { status: 'PAUSED' },
    })
  })

  it('resumeQuery 应将状态设回 ACTIVE', async () => {
    const svc = createQueryLibraryService(prisma)
    await svc.resumeQuery('q1')
    expect(prisma.citationQuery.update).toHaveBeenCalledWith({
      where: { id: 'q1' },
      data: { status: 'ACTIVE' },
    })
  })

  it('generateQueries 调用 LLM 并批量创建', async () => {
    const llm = {
      name: 'test',
      chat: vi.fn().mockResolvedValue({
        text: JSON.stringify(['Q1', 'Q2', 'Q3']),
      }),
      embed: vi.fn(),
    }
    const svc = createQueryLibraryService(prisma, llm as any)
    const result = await svc.generateQueries({
      workspaceId: 'w1',
      topic: 'AI设计工具',
      count: 3,
    })
    expect(result).toHaveLength(3)
    expect(llm.chat).toHaveBeenCalled()
    expect(prisma.citationQuery.create).toHaveBeenCalledTimes(3)
  })

  it('generateQueries 解析结构化 LLM 输出', async () => {
    const llm = {
      name: 'test',
      chat: vi.fn().mockResolvedValue({
        text: JSON.stringify([
          {
            queryText: 'AI 设计工具哪个好',
            intentType: 'comparison',
            cluster: 'ai-design-tools',
            mappedPageUrl: 'https://zoomer.top/features',
            priority: 1,
          },
        ]),
      }),
      embed: vi.fn(),
    }
    const svc = createQueryLibraryService(prisma, llm as any)
    const result = await svc.generateQueries({
      workspaceId: 'w1',
      topic: 'AI 设计工具',
      count: 1,
    })

    expect(result).toHaveLength(1)
    expect(prisma.citationQuery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 'w1',
        queryText: 'AI 设计工具哪个好',
        source: 'LLM_GENERATED',
        status: 'ACTIVE',
        intentType: 'comparison',
        cluster: 'ai-design-tools',
        mappedPageUrl: 'https://zoomer.top/features',
        priority: 1,
      }),
    })
  })

  it('generateQueries 兼容旧格式字符串数组', async () => {
    const llm = {
      name: 'test',
      chat: vi.fn().mockResolvedValue({
        text: JSON.stringify(['AI 设计工具推荐']),
      }),
      embed: vi.fn(),
    }
    const svc = createQueryLibraryService(prisma, llm as any)
    const result = await svc.generateQueries({
      workspaceId: 'w1',
      topic: 'AI 设计工具',
      count: 1,
    })

    expect(result).toHaveLength(1)
    expect(prisma.citationQuery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        queryText: 'AI 设计工具推荐',
        intentType: 'other',
        priority: 3,
      }),
    })
  })

  it('addQuery 支持结构化字段', async () => {
    const svc = createQueryLibraryService(prisma)
    await svc.addQuery({
      workspaceId: 'w1',
      queryText: 'AI设计工具',
      source: 'MANUAL',
      intentType: 'comparison',
      cluster: 'ai-design',
      mappedPageUrl: 'https://zoomer.top',
      priority: 1,
    })

    expect(prisma.citationQuery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        intentType: 'comparison',
        cluster: 'ai-design',
        mappedPageUrl: 'https://zoomer.top',
        priority: 1,
      }),
    })
  })
})

// ---------------------------------------------------------------------------
// 任务 9：计费检查点——新增词 maxQueries 软限（先检查后计量、超额告警不拦截）
// ---------------------------------------------------------------------------

describe('query library 计费检查点（任务 9）', () => {
  const LIMITS = { maxWorkspaces: 10, maxQueries: 100, allowedPlatforms: [] }

  function mockBillingPrisma() {
    return {
      usageRecord: {
        createMany: vi.fn(async () => ({ count: 0 })),
        aggregate: vi.fn(async () => ({ _sum: { quantity: 0 } })),
      },
    } as any
  }

  function assemble(
    opts: { enforcement: () => boolean; monthlyUsage?: number; oeRow?: Record<string, unknown> | null },
  ) {
    const prisma: any = mockPrisma()
    prisma.workspace = {
      findUnique: vi.fn(async () => ({ id: 'w1', organizationId: 'org-1' })),
    }
    prisma.organizationEntitlement = {
      findUnique: vi.fn(async () =>
        opts.oeRow === undefined ? { organizationId: 'org-1', limits: LIMITS } : opts.oeRow,
      ),
    }
    const meterPrisma = mockBillingPrisma()
    meterPrisma.usageRecord.aggregate.mockImplementation(async () => ({
      _sum: { quantity: opts.monthlyUsage ?? 0 },
    }))
    const meterAudit = { record: vi.fn(async () => {}), list: vi.fn(async () => ({ items: [], total: 0 })) }
    const meter = createUsageMeter({ prisma: meterPrisma })
    const guard = createEntitlementGuard({
      prisma,
      meter,
      audit: meterAudit as any,
      enforcement: opts.enforcement,
    })
    const svc = createQueryLibraryService(prisma, undefined, undefined, { guard, meter })
    return { prisma, svc, meter, meterAudit, meterPrisma }
  }

  it('enforcement on 超额：软限不拦截——query 照常创建，audit quota.soft_exceeded + meter 计量', async () => {
    const { prisma, svc, meter, meterAudit } = assemble({
      enforcement: () => true,
      monthlyUsage: 150,
    })
    const q = await svc.addQuery({ workspaceId: 'w1', queryText: 'AI设计工具', source: 'MANUAL' })
    expect(q.id).toBe('q-1')
    expect(prisma.citationQuery.create).toHaveBeenCalledTimes(1)
    expect(meterAudit.record).toHaveBeenCalledWith({
      actorType: 'SYSTEM',
      action: 'quota.soft_exceeded',
      organizationId: 'org-1',
      diff: { kind: 'maxQueries', current: 150, limit: 100, organizationId: 'org-1' },
    })
    // 计量缓冲 1 条 QUERY_ADDED
    expect(meter.pending()).toBe(1)
  })

  it('enforcement on 未超额：不告警，照常计量 QUERY_ADDED', async () => {
    const { prisma, svc, meter, meterAudit, meterPrisma } = assemble({
      enforcement: () => true,
      monthlyUsage: 10,
    })
    await svc.addQuery({ workspaceId: 'w1', queryText: 'q', source: 'MANUAL' })
    expect(prisma.citationQuery.create).toHaveBeenCalledTimes(1)
    expect(meterAudit.record).not.toHaveBeenCalled()
    await meter.flush()
    const rows = meterPrisma.usageRecord.createMany.mock.calls[0][0].data
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ organizationId: 'org-1', workspaceId: 'w1', kind: 'QUERY_ADDED', quantity: 1 })
  })

  it('enforcement off：不查配额不告警，但计量照记（Ruling 1）', async () => {
    const { prisma, svc, meter, meterAudit, meterPrisma } = assemble({
      enforcement: () => false,
      monthlyUsage: 9999,
    })
    await svc.addQuery({ workspaceId: 'w1', queryText: 'q', source: 'MANUAL' })
    expect(prisma.organizationEntitlement.findUnique).not.toHaveBeenCalled()
    expect(meterPrisma.usageRecord.aggregate).not.toHaveBeenCalled()
    expect(meterAudit.record).not.toHaveBeenCalled()
    expect(meter.pending()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// M2 §3.0：试用租户（Organization.source='TRIAL'）的生成禁用 + maxQueries 软限钉子
// ---------------------------------------------------------------------------

describe('query library 试用租户策略（M2 §3.0）', () => {
  function assembleTrial(source: string | null) {
    const prisma: any = mockPrisma()
    prisma.workspace = { findUnique: vi.fn(async () => ({ id: 'w1', organizationId: 'org-1' })) }
    prisma.organization = { findUnique: vi.fn(async () => (source === null ? null : { id: 'org-1', source })) }
    const llm = { chat: vi.fn(async () => ({ text: '["AI设计工具"]', usage: null })) }
    const svc = createQueryLibraryService(prisma, llm as any)
    return { prisma, svc, llm }
  }

  it('TRIAL 组织：generateQueries 明确拒绝「试用版请手动添加查询」，且不触达 LLM', async () => {
    const { svc, llm } = assembleTrial('TRIAL')
    await expect(svc.generateQueries({ workspaceId: 'w1', topic: 'AI设计', count: 5 })).rejects.toMatchObject({
      name: 'TRIAL_GENERATION_DISABLED',
      message: '试用版请手动添加查询',
    })
    expect(llm.chat).not.toHaveBeenCalled()
  })

  it('回归：正式组织（source=PLATFORM）生成不受影响', async () => {
    const { svc, llm } = assembleTrial('PLATFORM')
    const created = await svc.generateQueries({ workspaceId: 'w1', topic: 'AI设计', count: 1 })
    expect(llm.chat).toHaveBeenCalledTimes(1)
    expect(created).toHaveLength(1)
  })

  it('maxQueries 软限钉子：试用配额 10、已用 10，第 11 条仍创建成功（软限只审计）', async () => {
    const prisma: any = mockPrisma()
    prisma.workspace = { findUnique: vi.fn(async () => ({ id: 'w1', organizationId: 'org-1' })) }
    prisma.organizationEntitlement = {
      findUnique: vi.fn(async () => ({
        organizationId: 'org-1',
        limits: { maxWorkspaces: 1, maxQueries: 10, allowedPlatforms: [], monitorSampleCountMax: 3 },
      })),
    }
    const meterPrisma = {
      usageRecord: {
        createMany: vi.fn(async () => ({ count: 0 })),
        aggregate: vi.fn(async () => ({ _sum: { quantity: 10 } })),
      },
    } as any
    const meterAudit = { record: vi.fn(async () => {}), list: vi.fn(async () => ({ items: [], total: 0 })) }
    const meter = createUsageMeter({ prisma: meterPrisma })
    const guard = createEntitlementGuard({
      prisma,
      meter,
      audit: meterAudit as any,
      enforcement: () => true,
    })
    const svc = createQueryLibraryService(prisma, undefined, undefined, { guard, meter })

    const q = await svc.addQuery({ workspaceId: 'w1', queryText: '第 11 条', source: 'MANUAL' })

    expect(q.id).toBe('q-1')
    expect(prisma.citationQuery.create).toHaveBeenCalledTimes(1)
    expect(meterAudit.record).toHaveBeenCalledWith({
      actorType: 'SYSTEM',
      action: 'quota.soft_exceeded',
      organizationId: 'org-1',
      diff: { kind: 'maxQueries', current: 10, limit: 10, organizationId: 'org-1' },
    })
    await meter.flush()
    const rows = meterPrisma.usageRecord.createMany.mock.calls[0][0].data
    expect(rows[0]).toMatchObject({ kind: 'QUERY_ADDED', quantity: 1 })
  })
})
