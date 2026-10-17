import { describe, it, expect, vi } from 'vitest'
import { createKgExtractor } from './extractor.js'
import type { PrismaClient } from '@prisma/client'
import type { EntityExtractorService } from '../../core/extract/entity-extractor.js'
import type { KgAdapterService } from '../../core/extract/adapters/kg-adapter.js'
import { createEntitlementGuard } from '../../platform/billing/entitlement-guard.js'
import { createUsageMeter } from '../../platform/billing/usage-meter.js'

function mockPrisma() {
  return {
    contentPage: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'page-1',
        workspaceId: 'w1',
        url: 'https://x.com/landing',
        currentContent: 'zoomer AI 是 AI 设计工具',
      }),
    },
    optimizationTask: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({
        id: 'task-1', ...data,
      })),
    },
  } as unknown as PrismaClient
}

describe('KgExtractor', () => {
  it('extractFromPage 抽取实体 + 适配 + 创建 UPDATE_KG PENDING 任务', async () => {
    const prisma = mockPrisma()
    const extractor: EntityExtractorService = {
      extract: vi.fn().mockResolvedValue({
        entities: [
          { name: 'zoomer AI', rawType: 'AI 设计工具', properties: { url: 'https://x.com' } },
          { name: 'Notion', rawType: '笔记软件', properties: {} },
        ],
        relations: [{ fromName: 'zoomer AI', toName: 'Notion', relationType: 'competitor' }],
      }),
    }
    const adapter: KgAdapterService = {
      adapt: vi.fn().mockReturnValue([
        { name: 'zoomer AI', type: 'AI 设计工具', properties: { url: 'https://x.com' } },
        { name: 'Notion', type: '笔记软件', properties: {} },
      ]),
    }
    const kgExtractor = createKgExtractor({ prisma, extractor, kgAdapter: adapter })
    const { proposals, task } = await kgExtractor.extractFromPage('page-1')

    expect(proposals.entities).toHaveLength(2)
    expect(proposals.relations).toHaveLength(1)
    expect(task.type).toBe('UPDATE_KG')
    expect(task.status).toBe('PENDING')
    expect(task.pageId).toBe('page-1')
    expect((task as any).extractionProposals).toEqual(proposals)
    expect(prisma.optimizationTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'UPDATE_KG',
        status: 'PENDING',
        pageId: 'page-1',
      }),
    })
  })

  it('页面不存在时抛错', async () => {
    const prisma = mockPrisma()
    ;(prisma.contentPage.findUnique as any).mockResolvedValue(null)
    const extractor: EntityExtractorService = { extract: vi.fn() }
    const adapter: KgAdapterService = { adapt: vi.fn() }
    const kgExtractor = createKgExtractor({ prisma, extractor, kgAdapter: adapter })
    await expect(kgExtractor.extractFromPage('missing')).rejects.toThrow(/Page not found/)
  })
})

// ---------------------------------------------------------------------------
// 任务 9 审查补漏（Important-1）：UPDATE_KG 任务创建挂 optimizationsPerMonth
// 软限 + OPTIMIZATION_CREATED 计量（此前直连 prisma 绕过检查点）
// ---------------------------------------------------------------------------

describe('KgExtractor 计费检查点（任务 9 补漏）', () => {
  const LIMITS = { maxWorkspaces: 10, optimizationsPerMonth: 5 }

  function makeDeps() {
    const extractor: EntityExtractorService = { extract: vi.fn().mockResolvedValue({ entities: [], relations: [] }) }
    const adapter: KgAdapterService = { adapt: vi.fn().mockReturnValue([]) }
    return { extractor, adapter }
  }

  function assemble(opts: { enforcement: () => boolean; monthlyUsage?: number }) {
    const prisma: any = mockPrisma()
    prisma.workspace = {
      findUnique: vi.fn(async () => ({ id: 'w1', organizationId: 'org-1' })),
    }
    prisma.organizationEntitlement = {
      findUnique: vi.fn(async () => ({ organizationId: 'org-1', limits: LIMITS })),
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
      prisma,
      meter,
      audit: meterAudit as any,
      enforcement: opts.enforcement,
    })
    const { extractor, adapter } = makeDeps()
    const svc = createKgExtractor({ prisma, extractor, kgAdapter: adapter, billing: { guard, meter } })
    return { prisma, svc, meter, meterAudit, meterPrisma, extractor, adapter }
  }

  it('enforcement on 月度超额：软限不拦截——任务照常创建 + audit 告警 + meter 计量', async () => {
    const { prisma, svc, meter, meterAudit } = assemble({ enforcement: () => true, monthlyUsage: 5 })
    const { task } = await svc.extractFromPage('page-1')
    expect(task.type).toBe('UPDATE_KG')
    expect(prisma.optimizationTask.create).toHaveBeenCalledTimes(1)
    expect(meterAudit.record).toHaveBeenCalledWith({
      actorType: 'SYSTEM',
      action: 'quota.soft_exceeded',
      organizationId: 'org-1',
      diff: { kind: 'optimizationsPerMonth', current: 5, limit: 5, organizationId: 'org-1' },
    })
    expect(meter.pending()).toBe(1)
  })

  it('enforcement on 未超额：不告警，计量 OPTIMIZATION_CREATED（workspace 取自页面归属）', async () => {
    const { svc, meter, meterAudit, meterPrisma } = assemble({ enforcement: () => true, monthlyUsage: 1 })
    await svc.extractFromPage('page-1')
    expect(meterAudit.record).not.toHaveBeenCalled()
    await meter.flush()
    const rows = meterPrisma.usageRecord.createMany.mock.calls[0][0].data
    expect(rows[0]).toMatchObject({
      organizationId: 'org-1',
      workspaceId: 'w1',
      kind: 'OPTIMIZATION_CREATED',
      quantity: 1,
    })
  })

  it('enforcement off：不查配额不告警，计量照记（Ruling 1）；未注入 billing 零检查', async () => {
    const { prisma, svc, meter, meterAudit } = assemble({ enforcement: () => false, monthlyUsage: 9999 })
    await svc.extractFromPage('page-1')
    expect(prisma.organizationEntitlement.findUnique).not.toHaveBeenCalled()
    expect(meterAudit.record).not.toHaveBeenCalled()
    expect(meter.pending()).toBe(1)

    const barePrisma: any = mockPrisma()
    const { extractor, adapter } = makeDeps()
    const bare = createKgExtractor({ prisma: barePrisma, extractor, kgAdapter: adapter })
    await expect(bare.extractFromPage('page-1')).resolves.toMatchObject({
      task: { type: 'UPDATE_KG', status: 'PENDING' },
    })
    expect(barePrisma.workspace).toBeUndefined()
  })
})
