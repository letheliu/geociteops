import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { PrismaClient, User } from '@prisma/client'
import { billingRouter } from './billing-router.js'
import { shanghaiMonthWindow } from './entitlement-merge.js'
import type { EntitlementService } from './entitlement-service.js'

// ---------------------------------------------------------------------------
// billing-router 最小 mock 测试（任务 14 裁定：只测两个端点的核心投影/聚合，
// 权限矩阵由 orgProcedure 家族既有测试覆盖）：
// - subscriptions：join plan 的薄投影（planName/status/起止时间）；
// - entitlements：limits 透传 getLimits + 四个计量键当月 Σquantity 聚合 +
//   maxWorkspaces=非 ARCHIVED workspace 计数 + samplesPerRun 恒 0。
// ---------------------------------------------------------------------------

const NOW = new Date('2026-10-15T08:00:00.000Z')

function makeUser(overrides: Record<string, unknown> = {}): User {
  return {
    id: 'user-1',
    username: 'member',
    displayName: 'Member',
    email: null,
    phone: null,
    passwordHash: 'x',
    userType: 'CUSTOMER',
    platformRole: null,
    organizationId: 'org-1',
    orgRole: 'ORG_MEMBER',
    status: 'ACTIVE',
    mustChangePassword: false,
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as unknown as User
}

function makePrisma() {
  return {
    subscription: { findMany: vi.fn() },
    usageRecord: { aggregate: vi.fn() },
    workspace: { count: vi.fn() },
  } as unknown as PrismaClient & Record<string, Record<string, ReturnType<typeof vi.fn>>>
}

function makeEntitlements() {
  return {
    recompute: vi.fn(),
    getLimits: vi.fn(),
  } as unknown as EntitlementService & Record<string, ReturnType<typeof vi.fn>>
}

let prisma: ReturnType<typeof makePrisma>
let entitlements: ReturnType<typeof makeEntitlements>

beforeEach(() => {
  prisma = makePrisma()
  entitlements = makeEntitlements()
})

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    actor: {
      kind: 'user',
      user: makeUser(),
      session: { id: 'sess-1' },
    },
    requestMeta: {
      ip: '1.2.3.4',
      requestId: 'req-1',
      method: 'GET',
      headers: { 'x-geo-csrf': 'test' },
    },
    services: { prisma, entitlements },
    ...overrides,
  } as any
}

describe('billingRouter.subscriptions（orgProcedure()：本 org 订阅薄投影）', () => {
  it('join plan 投影 id/planId/planName/status/startAt/endAt；where 恒为本企业', async () => {
    prisma.subscription.findMany.mockResolvedValue([
      {
        id: 'sub-1',
        planId: 'plan-1',
        status: 'ACTIVE',
        startAt: NOW,
        endAt: new Date('2027-10-15T00:00:00.000Z'),
        createdAt: NOW,
        plan: { id: 'plan-1', name: '专业版年付' },
      },
    ])
    const caller = billingRouter.createCaller(makeCtx())
    const result = await caller.subscriptions()
    expect(prisma.subscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-1' } }),
    )
    expect(result).toEqual({
      items: [
        {
          id: 'sub-1',
          planId: 'plan-1',
          planName: '专业版年付',
          status: 'ACTIVE',
          startAt: NOW,
          endAt: new Date('2027-10-15T00:00:00.000Z'),
          // M2 §3.0：正式套餐快照无内部策略键 → trial=false
          trial: false,
        },
      ],
    })
  })

  it('试用订阅：快照带 _suppressReminder/_graceDays → trial=true（前端横幅数据源）', async () => {
    prisma.subscription.findMany.mockResolvedValue([
      {
        id: 'sub-trial',
        planId: 'plan_trial',
        status: 'ACTIVE',
        startAt: NOW,
        endAt: new Date('2026-10-25T00:00:00.000Z'),
        createdAt: NOW,
        plan: { id: 'plan_trial', name: '试用套餐' },
        entitlements: { maxWorkspaces: 1, maxQueries: 10, _graceDays: 90, _suppressReminder: true },
      },
    ] as never)
    const caller = billingRouter.createCaller(makeCtx())
    const result = await caller.subscriptions()
    expect(result.items[0].trial).toBe(true)
  })

  it('ORG_VIEWER 亦可见（orgProcedure() 无权限点）；未挂靠企业 → FORBIDDEN', async () => {
    const viewerCaller = billingRouter.createCaller(
      makeCtx({ actor: { kind: 'user', user: makeUser({ orgRole: 'ORG_VIEWER' }), session: { id: 's' } } }),
    )
    prisma.subscription.findMany.mockResolvedValue([])
    await expect(viewerCaller.subscriptions()).resolves.toEqual({ items: [] })

    const orphanCaller = billingRouter.createCaller(
      makeCtx({
        actor: {
          kind: 'user',
          user: makeUser({ organizationId: null }),
          session: { id: 's' },
        },
      }),
    )
    await expect(orphanCaller.subscriptions()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('billingRouter.entitlements（limits + 当月用量聚合）', () => {
  it('四计量键 Σquantity by kind + maxWorkspaces=非 ARCHIVED 计数 + samplesPerRun 恒 0；limits 透传 getLimits', async () => {
    entitlements.getLimits.mockResolvedValue({
      limits: {
        maxWorkspaces: 5,
        maxQueries: 1000,
        maxPages: 200,
        diagnosticRunsPerMonth: 20,
        samplesPerRun: 50,
        optimizationsPerMonth: 100,
        allowedPlatforms: ['deepseek'],
      },
      periodStart: NOW,
      periodEnd: new Date('2026-11-01T00:00:00+08:00'),
    })
    // kind → Σquantity（QUERY_ADDED=120 超限展示负进度由前端处理）
    prisma.usageRecord.aggregate.mockImplementation(async (args: any) => ({
      _sum: {
        quantity: { QUERY_ADDED: 120, PAGE_CREATED: 8, DIAGNOSTIC_RUN: 3, OPTIMIZATION_CREATED: 25 }[
          args.where.kind
        ],
      },
    }))
    prisma.workspace.count.mockResolvedValue(2)

    const caller = billingRouter.createCaller(makeCtx())
    const result = await caller.entitlements()

    // 四个计量键各聚一次（并行），窗口为当月自然月（gte/lt 同锚）：与路由实现
    // 同源计算 shanghaiMonthWindow，钉住 occurredAt 两条边界（gte=月初，lt=次月月初）
    const window = shanghaiMonthWindow(new Date())
    expect(prisma.usageRecord.aggregate).toHaveBeenCalledTimes(4)
    for (const kind of ['QUERY_ADDED', 'PAGE_CREATED', 'DIAGNOSTIC_RUN', 'OPTIMIZATION_CREATED']) {
      expect(prisma.usageRecord.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          _sum: { quantity: true },
          where: {
            organizationId: 'org-1',
            kind,
            occurredAt: { gte: window.periodStart, lt: window.periodEnd },
          },
        }),
      )
    }
    expect(prisma.workspace.count).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', status: { not: 'ARCHIVED' } },
    })
    expect(result.usage).toEqual({
      maxWorkspaces: 2,
      maxQueries: 120,
      maxPages: 8,
      diagnosticRunsPerMonth: 3,
      samplesPerRun: 0,
      optimizationsPerMonth: 25,
      // M2 §3.0：单次运行上限无月度量，用量恒 0（前端展示"—/上限"）
      monitorSampleCountMax: 0,
    })
    expect(result.limits.maxWorkspaces).toBe(5)
    expect(result.limits.allowedPlatforms).toEqual(['deepseek'])
    // 遗留 D4：periodStart/periodEnd 返回 usage 实际聚合的新鲜窗口（与 getLimits
    // 透传的 OE 存量窗口解耦——跨月未 recompute 时标签不滞后），两条边界同锚
    expect(result.periodStart).toEqual(window.periodStart)
    expect(result.periodEnd).toEqual(window.periodEnd)
  })
})
