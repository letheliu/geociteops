import { describe, it, expect, vi } from 'vitest'
import { createPageService } from './page-service.js'
import { createEntitlementGuard } from '../../platform/billing/entitlement-guard.js'
import { createUsageMeter } from '../../platform/billing/usage-meter.js'

// ---------------------------------------------------------------------------
// 任务 9：content 页创建 maxPages 软限检查点 + PAGE_CREATED 计量。
// upsert 语义：create 分支检查/计量，update 分支不消耗配额；
// updateContent=false（orchestrator 复跑）不回写 pageType/currentContent。
// ---------------------------------------------------------------------------

const LIMITS = { maxWorkspaces: 10, maxPages: 30 }

function makePage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'page-1',
    workspaceId: 'w1',
    url: 'https://example.com',
    pageType: 'landing',
    currentContent: '内容',
    optimizedContent: null,
    optimizationScore: null,
    status: 'DRAFT',
    ...overrides,
  }
}

function assemble(opts: {
  enforcement: () => boolean
  monthlyUsage?: number
  existingPage?: Record<string, unknown> | null
}) {
  const prisma: any = {
    contentPage: {
      findUnique: vi.fn(async () =>
        opts.existingPage === undefined ? null : opts.existingPage,
      ),
      upsert: vi.fn(async ({ create }: any) => makePage(create)),
    },
    workspace: {
      findUnique: vi.fn(async () => ({ id: 'w1', organizationId: 'org-1' })),
    },
    organizationEntitlement: {
      findUnique: vi.fn(async () => ({ organizationId: 'org-1', limits: LIMITS })),
    },
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
  const svc = createPageService({ prisma, billing: { guard, meter } })
  return { prisma, svc, meter, meterAudit, meterPrisma }
}

describe('PageService 计费检查点（任务 9）', () => {
  it('新建页（不存在同 url）：enforcement on 未超额 → upsert + PAGE_CREATED 计量', async () => {
    const { prisma, svc, meter, meterAudit, meterPrisma } = assemble({
      enforcement: () => true,
      monthlyUsage: 3,
    })
    const page = await svc.upsert({
      workspaceId: 'w1',
      url: 'https://example.com',
      pageType: 'landing',
      currentContent: '内容',
    })
    expect(page.id).toBe('page-1')
    expect(meterAudit.record).not.toHaveBeenCalled()
    await meter.flush()
    const rows = meterPrisma.usageRecord.createMany.mock.calls[0][0].data
    expect(rows[0]).toMatchObject({
      organizationId: 'org-1',
      workspaceId: 'w1',
      kind: 'PAGE_CREATED',
      quantity: 1,
    })
    // upsert 形状：create 分支带必填字段
    const args = prisma.contentPage.upsert.mock.calls[0][0]
    expect(args.create).toMatchObject({ workspaceId: 'w1', url: 'https://example.com', pageType: 'landing' })
    expect(args.update).toEqual({ pageType: 'landing', currentContent: '内容' })
  })

  it('新建页 + 月度超额：软限不拦截——页照常创建，audit quota.soft_exceeded', async () => {
    const { prisma, svc, meter, meterAudit } = assemble({
      enforcement: () => true,
      monthlyUsage: 30,
    })
    await svc.upsert({ workspaceId: 'w1', url: 'https://example.com', pageType: 'landing', currentContent: 'c' })
    expect(prisma.contentPage.upsert).toHaveBeenCalledTimes(1)
    expect(meterAudit.record).toHaveBeenCalledWith({
      actorType: 'SYSTEM',
      action: 'quota.soft_exceeded',
      organizationId: 'org-1',
      diff: { kind: 'maxPages', current: 30, limit: 30, organizationId: 'org-1' },
    })
    expect(meter.pending()).toBe(1)
  })

  it('已存在页更新：不检查不计量（不消耗配额）', async () => {
    const { prisma, svc, meter, meterAudit } = assemble({
      enforcement: () => true,
      monthlyUsage: 999,
      existingPage: makePage(),
    })
    await svc.upsert({ workspaceId: 'w1', url: 'https://example.com', pageType: 'blog', currentContent: '新' })
    expect(prisma.contentPage.findUnique).toHaveBeenCalledTimes(1)
    expect(prisma.organizationEntitlement.findUnique).not.toHaveBeenCalled()
    expect(meterAudit.record).not.toHaveBeenCalled()
    expect(meter.pending()).toBe(0)
  })

  it('orchestrator 复跑（updateContent=false）：update 分支只写优化结果，不回写内容', async () => {
    const { prisma, svc } = assemble({
      enforcement: () => true,
      existingPage: makePage(),
    })
    await svc.upsert({
      workspaceId: 'w1',
      url: 'https://example.com',
      pageType: 'landing',
      currentContent: '新内容',
      optimizedContent: '{"score":85}',
      optimizationScore: 85,
      updateContent: false,
    })
    const args = prisma.contentPage.upsert.mock.calls[0][0]
    expect(args.update).toEqual({ optimizedContent: '{"score":85}', optimizationScore: 85 })
  })

  it('enforcement off：不查配额不告警，计量照记（Ruling 1）', async () => {
    const { prisma, svc, meter, meterAudit } = assemble({ enforcement: () => false, monthlyUsage: 9999 })
    await svc.upsert({ workspaceId: 'w1', url: 'https://example.com', pageType: 'landing', currentContent: 'c' })
    expect(prisma.organizationEntitlement.findUnique).not.toHaveBeenCalled()
    expect(meterAudit.record).not.toHaveBeenCalled()
    expect(meter.pending()).toBe(1)
  })

  it('未注入 billing（存量装配）：零检查，行为与任务 9 前一致', async () => {
    const prisma: any = {
      contentPage: {
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async ({ create }: any) => makePage(create)),
      },
    }
    const svc = createPageService({ prisma })
    const page = await svc.upsert({ workspaceId: 'w1', url: 'https://example.com', pageType: 'landing', currentContent: 'c' })
    expect(page.id).toBe('page-1')
    expect(prisma.contentPage.findUnique).not.toHaveBeenCalled()
    expect(prisma.contentPage.upsert).toHaveBeenCalledTimes(1)
  })
})
