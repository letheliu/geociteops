import { describe, expect, it, vi } from 'vitest'
import { createEntitlementService } from './entitlement-service.js'

// ---------------------------------------------------------------------------
// 测试基建：mock prisma（照 member-service.test.ts / order-service.test.ts 模式）
// 交互式事务把 prisma 自身作为 tx 传回（委托同源）。
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date('2026-10-15T02:00:00+08:00') // = 2026-10-14T18:00:00Z
const FUTURE = new Date('2026-11-01T00:00:00+08:00')

/** 简报月度窗口用例锚点（当月 1 日 ~ 次月 1 日，上海语义 / UTC 存储） */
const OCTOBER_WINDOW = {
  periodStart: new Date('2026-09-30T16:00:00.000Z'),
  periodEnd: new Date('2026-10-31T16:00:00.000Z'),
}

const ZERO_LIMITS = {
  maxWorkspaces: 0,
  maxQueries: 0,
  maxPages: 0,
  diagnosticRunsPerMonth: 0,
  samplesPerRun: 0,
  optimizationsPerMonth: 0,
  allowedPlatforms: [],
}

function makeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    organizationId: 'org-1',
    planId: 'plan-1',
    sourceOrderId: 'o1',
    startAt: new Date('2026-10-01T00:00:00.000Z'),
    endAt: FUTURE,
    status: 'ACTIVE',
    entitlements: { maxQueries: 100, allowedPlatforms: ['wechat'] },
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    plan: {
      id: 'plan-1',
      productId: 'prod-1',
      product: { id: 'prod-1', code: 'pro', kind: 'SUBSCRIPTION' },
    },
    ...overrides,
  }
}

function makeOE(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1',
    limits: { ...ZERO_LIMITS },
    periodStart: OCTOBER_WINDOW.periodStart,
    periodEnd: OCTOBER_WINDOW.periodEnd,
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  }
}

function makePrisma(
  opts: {
    /** getLimits / 已存在行场景的 OE 行（undefined = 视为 null） */
    oeRow?: Record<string, unknown> | null
    /** FOR UPDATE 行锁查询返回的行；缺省为当月窗口行（upsert 后必有一行） */
    lockedRows?: Record<string, unknown>[]
    subscriptions?: Record<string, unknown>[]
  } = {},
) {
  const prisma: any = {
    organizationEntitlement: {
      findUnique: vi.fn(async () => (opts.oeRow === undefined ? null : opts.oeRow)),
      upsert: vi.fn(async () => ({})),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        organizationId: 'org-1',
        ...data,
      })),
    },
    subscription: {
      findMany: vi.fn(async () => opts.subscriptions ?? []),
    },
    // 默认锁回当月窗口行：upsert 在同事务先建行，FOR UPDATE 恒返回一行；
    // 窗口滚动用例显式传过期窗口行
    $queryRaw: vi.fn(async () => opts.lockedRows ?? [makeOE()]),
  }
  // 交互式事务：把 prisma 自身作为 tx 传回（mock 委托同源）
  prisma.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma))
  return prisma
}

function makeService(prisma: any, now: () => Date = () => FIXED_NOW) {
  return createEntitlementService({ prisma, now })
}

// ---------------------------------------------------------------------------
// recompute：事务 + 行锁 + 订阅合并 + limits/窗口写回
// ---------------------------------------------------------------------------

describe('entitlementService.recompute', () => {
  it('交互式事务内完成：$transaction 恰一次，upsert/行锁/订阅查询/update 均在事务回调中执行', async () => {
    const prisma = makePrisma()
    const service = makeService(prisma)
    await service.recompute('org-1')

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(prisma.organizationEntitlement.upsert).toHaveBeenCalledTimes(1)
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
    expect(prisma.subscription.findMany).toHaveBeenCalledTimes(1)
    expect(prisma.organizationEntitlement.update).toHaveBeenCalledTimes(1)
    // 事务回调收到的 tx 即 prisma 自身（委托同源 mock）
    expect(prisma.$transaction.mock.calls[0][0]).toBeTypeOf('function')
  })

  it('先 upsert 空行再行锁：upsert 调用序先于 $queryRaw（不存在则先建再锁）', async () => {
    const prisma = makePrisma()
    const service = makeService(prisma)
    await service.recompute('org-1')

    expect(prisma.organizationEntitlement.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.$queryRaw.mock.invocationCallOrder[0],
    )
  })

  it('行锁 SQL：参数化 organizationId，SELECT ... FOR UPDATE 锁 "OrganizationEntitlement" 行', async () => {
    const prisma = makePrisma()
    const service = makeService(prisma)
    await service.recompute('org-1')

    // $queryRaw 是 tagged template：calls[0][0] 为模板字符串数组，后续为插值参数
    const call = prisma.$queryRaw.mock.calls[0]
    const sql = (call[0] as readonly string[]).join('$?')
    expect(sql).toContain('FOR UPDATE')
    expect(sql).toContain('"OrganizationEntitlement"')
    expect(sql).toContain('"organizationId"')
    // 参数化（无字符串拼接注入面）
    expect(call[1]).toBe('org-1')
    expect(sql).not.toContain("'org-1'")
  })

  it('upsert 形状：where 复合键 + create（limits 全 0 + 当月窗口）+ update 空对象（已存在不动）', async () => {
    const prisma = makePrisma()
    const service = makeService(prisma)
    await service.recompute('org-1')

    expect(prisma.organizationEntitlement.upsert).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      create: {
        organizationId: 'org-1',
        limits: { ...ZERO_LIMITS },
        periodStart: OCTOBER_WINDOW.periodStart,
        periodEnd: OCTOBER_WINDOW.periodEnd,
      },
      update: {},
    })
  })

  it('月度窗口用例：now=2026-10-15T02:00+08 → periodStart=2026-09-30T16:00Z、periodEnd=2026-10-31T16:00Z（UTC 存储、上海语义）', async () => {
    const prisma = makePrisma()
    const service = makeService(prisma)
    await service.recompute('org-1')

    const create = prisma.organizationEntitlement.upsert.mock.calls[0][0].create
    expect(create.periodStart.toISOString()).toBe('2026-09-30T16:00:00.000Z')
    expect(create.periodEnd.toISOString()).toBe('2026-10-31T16:00:00.000Z')
  })

  it('订阅查询形状：where organizationId + include plan→product（planKind 不在订阅行，须 join）', async () => {
    const prisma = makePrisma()
    const service = makeService(prisma)
    await service.recompute('org-1')

    expect(prisma.subscription.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      include: { plan: { include: { product: true } } },
    })
  })

  it('合并结果落库并返回：订阅 100+200 取 max 200 + ADDON 500 → maxQueries 700', async () => {
    const prisma = makePrisma({
      subscriptions: [
        makeSubscription({ id: 'sub-1', entitlements: { maxQueries: 100, allowedPlatforms: ['wechat'] } }),
        makeSubscription({
          id: 'sub-2',
          planId: 'plan-2',
          sourceOrderId: 'o2',
          entitlements: { maxQueries: 200, allowedPlatforms: ['llm'] },
        }),
        makeSubscription({
          id: 'sub-3',
          planId: 'plan-3',
          sourceOrderId: 'o3',
          entitlements: { maxQueries: 500 },
          plan: { id: 'plan-3', productId: 'prod-3', product: { id: 'prod-3', code: 'addon', kind: 'ADDON' } },
        }),
      ],
    })
    const service = makeService(prisma)
    const limits = await service.recompute('org-1')

    expect(limits).toEqual({
      ...ZERO_LIMITS,
      maxQueries: 700,
      allowedPlatforms: ['llm', 'wechat'],
    })
    expect(prisma.organizationEntitlement.update).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      data: { limits: limits },
    })
  })

  it('过期订阅不参与：endAt ≤ now 的订阅行被过滤', async () => {
    const prisma = makePrisma({
      subscriptions: [
        makeSubscription({ endAt: new Date('2026-10-01T00:00:00+08:00') }),
        makeSubscription({
          id: 'sub-2',
          planId: 'plan-2',
          sourceOrderId: 'o2',
          entitlements: { maxQueries: 300 },
        }),
      ],
    })
    const service = makeService(prisma)
    const limits = await service.recompute('org-1')
    expect(limits.maxQueries).toBe(300)
  })

  it('无订阅 org：重算得全 0 且写库全 0（limits 六字段 + 空平台）', async () => {
    const prisma = makePrisma({ subscriptions: [] })
    const service = makeService(prisma)
    const limits = await service.recompute('org-1')

    expect(limits).toEqual({ ...ZERO_LIMITS })
    expect(prisma.organizationEntitlement.update).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      data: { limits: { ...ZERO_LIMITS } },
    })
  })

  it('窗口滚动：锁行 periodEnd < now → update data 附当月新窗口', async () => {
    const staleWindow = {
      periodStart: new Date('2026-08-31T16:00:00.000Z'),
      periodEnd: new Date('2026-09-30T16:00:00.000Z'), // 9 月窗口已过期（< now=10-15）
    }
    const prisma = makePrisma({ lockedRows: [makeOE(staleWindow)] })
    const service = makeService(prisma)
    await service.recompute('org-1')

    expect(prisma.organizationEntitlement.update).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      data: {
        limits: { ...ZERO_LIMITS },
        periodStart: OCTOBER_WINDOW.periodStart,
        periodEnd: OCTOBER_WINDOW.periodEnd,
      },
    })
  })

  it('窗口未过期：锁行 periodEnd ≥ now → update data 只写 limits，不动 periodStart/periodEnd（月中统计窗口不重置）', async () => {
    const prisma = makePrisma({ lockedRows: [makeOE()] })
    const service = makeService(prisma)
    await service.recompute('org-1')

    const data = prisma.organizationEntitlement.update.mock.calls[0][0].data
    expect(data).toEqual({ limits: { ...ZERO_LIMITS } })
    expect('periodStart' in data).toBe(false)
    expect('periodEnd' in data).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getLimits：读路径（无行 → 全 0 默认，periodStart/periodEnd null）
// ---------------------------------------------------------------------------

describe('entitlementService.getLimits', () => {
  it('无行 → 全 0 默认对象 + periodStart/periodEnd null（不重算、不建行）', async () => {
    const prisma = makePrisma({ oeRow: null })
    const service = makeService(prisma)
    const view = await service.getLimits('org-1')

    expect(view).toEqual({ limits: { ...ZERO_LIMITS }, periodStart: null, periodEnd: null })
    expect(prisma.organizationEntitlement.findUnique).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
    })
    expect(prisma.organizationEntitlement.upsert).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('有行 → limits 按存储 Json 同规投影，periodStart/periodEnd 原样返回', async () => {
    const periodStart = new Date('2026-09-30T16:00:00.000Z')
    const periodEnd = new Date('2026-10-31T16:00:00.000Z')
    const prisma = makePrisma({
      oeRow: makeOE({
        limits: { maxQueries: 700, maxWorkspaces: 12, allowedPlatforms: ['wechat', 'llm'] },
        periodStart,
        periodEnd,
      }),
    })
    const service = makeService(prisma)
    const view = await service.getLimits('org-1')

    expect(view).toEqual({
      limits: {
        ...ZERO_LIMITS,
        maxQueries: 700,
        maxWorkspaces: 12,
        allowedPlatforms: ['llm', 'wechat'],
      },
      periodStart,
      periodEnd,
    })
  })

  it('存储 limits 脏数据（非对象）→ 全 0 容错不抛错', async () => {
    const prisma = makePrisma({ oeRow: makeOE({ limits: 'garbage' as unknown as object }) })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const service = makeService(prisma)
    const view = await service.getLimits('org-1')
    expect(view.limits).toEqual({ ...ZERO_LIMITS })
    warnSpy.mockRestore()
  })
})
