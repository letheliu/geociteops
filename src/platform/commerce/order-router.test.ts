import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { PrismaClient, User } from '@prisma/client'
import { appRouter } from '../../router.js'
import { ORG_ROLE_PERMISSIONS } from '../../core/trpc/init.js'
import { orderRouter, parseBankInfo } from './order-router.js'
import { adminOrderRouter } from './admin-order-router.js'
import { adminPaymentRouter } from './admin-payment-router.js'
import { createOrderService, ORDER_ACTIVATION_SEND_OPTIONS } from './order-service.js'
import type { FilesService } from './files.js'

/**
 * 任务 4：订单路由（客户侧 orders.* 与平台代客 admin.orders.*）。
 *
 * 模式照 org/catalog router 测试：子树（或 appRouter）createCaller + mock ctx，
 * services 注入真实 OrderService（建在 mock prisma 上）——权限矩阵/越权/审计
 * 断言需穿透 router 触达 service 逻辑（任务 3 的校验与状态机复用）。
 */

// 任务 6 修复配套：createPayment 走默认装配路径 resolveChannel(process.env)，
// PAY_MOCK_SECRET fail-closed 后测试进程需显式设置（与生产/dev 启动要求一致）
process.env.PAY_MOCK_SECRET ||= 'test-mock-secret'

const NOW = new Date('2026-10-15T08:00:00.000Z')

function makeUser(overrides: Record<string, unknown> = {}): User {
  return {
    id: 'user-1',
    username: 'owner',
    displayName: '企业所有者',
    email: null,
    phone: null,
    passwordHash: 'x',
    userType: 'CUSTOMER',
    platformRole: null,
    organizationId: 'org-1',
    orgRole: 'ORG_OWNER',
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

// ---------------------------------------------------------------------------
// fixtures：订单 / 行项 / 事件 / 套餐（形状同 order-service.test.ts）
// ---------------------------------------------------------------------------

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    orderNo: 'GEO261015ab12cd34',
    organizationId: 'org-1',
    status: 'PENDING_PAYMENT',
    totalCents: 15000,
    discountCents: 0,
    payableCents: 15000,
    refundedCents: 0,
    currency: 'CNY',
    paymentMethod: null,
    dueAt: null,
    paidAt: null,
    remark: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function makeOrderItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    orderId: 'order-1',
    planId: 'plan-1',
    workspaceId: null,
    quantity: 1,
    unitPriceCents: 10000,
    planSnapshot: {
      name: '专业版',
      kind: 'SUBSCRIPTION',
      priceCents: 10000,
      billingPeriod: 'MONTH',
      entitlements: { maxWorkspaces: 3 },
      deliverables: [],
    },
    ...overrides,
  }
}

function makeOrderEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    orderId: 'order-1',
    event: 'create',
    fromStatus: null,
    toStatus: 'PENDING_PAYMENT',
    actorId: 'user-1',
    note: null,
    createdAt: NOW,
    ...overrides,
  }
}

const SUB_PLAN = {
  id: 'plan-1',
  productId: 'prod-1',
  name: '专业版',
  priceCents: 10000,
  billingPeriod: 'MONTH',
  entitlements: { maxWorkspaces: 3 },
  deliverables: [],
  active: true,
  createdAt: NOW,
  updatedAt: NOW,
  product: {
    id: 'prod-1',
    code: 'pro',
    name: '专业版',
    kind: 'SUBSCRIPTION',
    description: '',
    active: true,
    createdAt: NOW,
    updatedAt: NOW,
  },
}

const ADDON_PLAN = {
  id: 'plan-2',
  productId: 'prod-2',
  name: '加购包',
  priceCents: 5000,
  billingPeriod: null,
  entitlements: { extraQueries: 1000 },
  deliverables: [],
  active: true,
  createdAt: NOW,
  updatedAt: NOW,
  product: {
    id: 'prod-2',
    code: 'addon',
    name: '加购包',
    kind: 'ADDON',
    description: '',
    active: true,
    createdAt: NOW,
    updatedAt: NOW,
  },
}

// ---------------------------------------------------------------------------
// mock prisma + 真实 OrderService + mock audit
// ---------------------------------------------------------------------------

function makePayment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pay-1',
    orderId: 'order-1',
    method: 'BANK_TRANSFER',
    amountCents: 15000,
    currency: 'CNY',
    status: 'PENDING',
    channelTxnNo: null,
    channelOrderNo: null,
    voucherFileKey: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.png',
    confirmedById: null,
    rawPayload: null,
    createdAt: NOW,
    ...overrides,
  }
}

function makePrisma(opts: { plans?: Record<string, unknown>[] } = {}) {
  let itemSeq = 0
  const prisma: any = {
    // 遗留 B1：下单组织存在性校验——默认任意 id 命中（组织存在）；用例可覆写为 null
    organization: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })),
    },
    productPlan: {
      findMany: vi.fn(async () => opts.plans ?? []),
    },
    order: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...makeOrder(),
        ...data,
      })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'order-1',
        createdAt: NOW,
        updatedAt: NOW,
        ...data,
      })),
    },
    orderItem: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: `item-${++itemSeq}`,
        ...data,
      })),
    },
    orderEvent: {
      findFirst: vi.fn(async () => undefined),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'evt-1',
        createdAt: NOW,
        ...data,
      })),
    },
    paymentTransaction: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'pay-1',
        createdAt: NOW,
        ...data,
      })),
      // 条件更新（修复轮）：默认命中 1 行
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    workspace: {
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  }
  // 交互式事务：把 prisma 自身作为 tx 传回（mock 委托同源，照 order-service.test.ts）
  prisma.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma))
  return prisma as PrismaClient & any
}

function makeFiles(): FilesService {
  return {
    put: vi.fn(async () => '0f1e2d3c4b5a69788776655443322110.png'),
    remove: vi.fn(async () => {}),
    resolvePath: vi.fn(),
  }
}

function makeBoss() {
  return {
    createQueue: vi.fn(async () => ({})),
    send: vi.fn(async () => ({})),
  }
}

function makeAudit() {
  return {
    record: vi.fn(async () => {}),
    list: vi.fn(),
  }
}

let prisma: ReturnType<typeof makePrisma>
let audit: ReturnType<typeof makeAudit>
let files: ReturnType<typeof makeFiles>
let boss: ReturnType<typeof makeBoss>

beforeEach(() => {
  prisma = makePrisma()
  audit = makeAudit()
  files = makeFiles()
  boss = makeBoss()
})

/** 真实 OrderService（mock prisma + mock files/boss + 固定 now/熵源 → orderNo 确定） */
function buildService() {
  return createOrderService({
    prisma,
    now: () => NOW,
    randomSuffix: () => 'ab12cd34',
    files,
    boss,
  })
}

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
      method: 'POST',
      headers: { 'x-geo-csrf': 'test' },
    },
    services: { prisma, orders: buildService(), audit },
    ...overrides,
  } as any
}

/** 按企业角色构造客户用户 ctx（organizationId 默认 org-1） */
function ctxWithOrgRole(orgRole: string | null, overrides: Record<string, unknown> = {}) {
  return makeCtx({
    actor: {
      kind: 'user',
      user: makeUser({ orgRole }),
      session: { id: 'sess-1' },
    },
    ...overrides,
  })
}

/** 按平台角色构造平台员工 ctx（无企业挂靠） */
function ctxWithPlatformRole(platformRole: string | null, overrides: Record<string, unknown> = {}) {
  return makeCtx({
    actor: {
      kind: 'user',
      user: makeUser({
        id: 'admin-1',
        username: 'admin',
        userType: 'PLATFORM',
        platformRole,
        organizationId: null,
        orgRole: null,
      }),
      session: { id: 'sess-1' },
    },
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// 权限常量表（Ruling 14）
// ---------------------------------------------------------------------------

describe('ORG_ROLE_PERMISSIONS：任务 4 扩展（Ruling 14）', () => {
  it("ORG_MEMBER = ['order.view']；ORG_OWNER '*' / ORG_VIEWER [] 不动", () => {
    expect(ORG_ROLE_PERMISSIONS.ORG_OWNER).toEqual(['*'])
    expect(ORG_ROLE_PERMISSIONS.ORG_MEMBER).toEqual(['order.view'])
    expect(ORG_ROLE_PERMISSIONS.ORG_VIEWER).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 客户侧 orders.*：权限矩阵
// ---------------------------------------------------------------------------

describe('orderRouter：权限矩阵（orgProcedure）', () => {
  it('ORG_MEMBER 调 orders.create → FORBIDDEN（无 order.create），不触达 service/prisma', async () => {
    const caller = orderRouter.createCaller(ctxWithOrgRole('ORG_MEMBER'))
    await expect(
      caller.create({ items: [{ planId: 'plan-1', quantity: 1 }] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(prisma.productPlan.findMany).not.toHaveBeenCalled()
    expect(prisma.order.create).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('ORG_VIEWER 调 orders.list / orders.get → FORBIDDEN（无 order.view），不触达 prisma', async () => {
    const caller = orderRouter.createCaller(ctxWithOrgRole('ORG_VIEWER'))
    await expect(caller.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(caller.get({ orderId: 'order-1' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(prisma.order.findMany).not.toHaveBeenCalled()
    expect(prisma.order.findUnique).not.toHaveBeenCalled()
  })

  it('ORG_MEMBER 调 orders.list / orders.get → 放行（order.view 已入成员权限表）', async () => {
    prisma.order.findMany.mockResolvedValue([{ ...makeOrder(), items: [makeOrderItem()] }])
    prisma.order.count.mockResolvedValue(1)
    prisma.order.findUnique.mockResolvedValue({
      ...makeOrder(),
      items: [makeOrderItem()],
      events: [makeOrderEvent()],
    })
    const caller = orderRouter.createCaller(ctxWithOrgRole('ORG_MEMBER'))

    await expect(caller.list()).resolves.toMatchObject({ total: 1 })
    await expect(caller.get({ orderId: 'order-1' })).resolves.toMatchObject({
      order: { id: 'order-1' },
    })
  })
})

// ---------------------------------------------------------------------------
// 客户侧 orders.create
// ---------------------------------------------------------------------------

describe('orderRouter.create（orgProcedure(order.create)，ORG_OWNER）', () => {
  it('下单成功：organizationId 由 actor 派生 + items 透传 + 快照固化；audit order.create；返回 { order, items, events }', async () => {
    prisma.productPlan.findMany.mockResolvedValue([SUB_PLAN, ADDON_PLAN])
    const caller = orderRouter.createCaller(makeCtx())

    const result = await caller.create({
      items: [
        { planId: 'plan-1', quantity: 1 },
        { planId: 'plan-2', quantity: 2, workspaceId: 'ws-1' },
      ],
      remark: '首单备注',
    })

    expect(prisma.order.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderNo: 'GEO261015ab12cd34',
        organizationId: 'org-1',
        status: 'PENDING_PAYMENT',
        totalCents: 20000,
        discountCents: 0,
        payableCents: 20000,
        remark: '首单备注',
      }),
    })
    expect(prisma.orderItem.create).toHaveBeenCalledTimes(2)
    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'user-1',
      actorType: 'USER',
      action: 'order.create',
      organizationId: 'org-1',
      target: 'Order:order-1',
      diff: {
        orderNo: 'GEO261015ab12cd34',
        totalCents: 20000,
        discountCents: 0,
        payableCents: 20000,
      },
    })
    expect(result.order.organizationId).toBe('org-1')
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({ planSnapshot: { name: '专业版' } })
    expect(result.events).toHaveLength(1)
  })

  it('客户侧传 discountCents（改价为平台代客专属能力）→ zod strict 拒绝，不触达 service', async () => {
    const caller = orderRouter.createCaller(makeCtx())
    await expect(
      caller.create({
        items: [{ planId: 'plan-1', quantity: 1 }],
        discountCents: 100,
      } as any),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(prisma.productPlan.findMany).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('items 空数组 / quantity=0 / planId 空串 → zod 拒绝，不触达 service', async () => {
    const caller = orderRouter.createCaller(makeCtx())
    await expect(caller.create({ items: [] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      caller.create({ items: [{ planId: 'plan-1', quantity: 0 }] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      caller.create({ items: [{ planId: '', quantity: 1 }] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(prisma.productPlan.findMany).not.toHaveBeenCalled()
  })

  it('套餐不存在（service ProductPlanNotFoundError）→ NOT_FOUND，不落库不审计', async () => {
    prisma.productPlan.findMany.mockResolvedValue([])
    const caller = orderRouter.createCaller(makeCtx())

    await expect(
      caller.create({ items: [{ planId: 'plan-x', quantity: 1 }] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(prisma.order.create).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 客户侧 orders.list / orders.get
// ---------------------------------------------------------------------------

describe('orderRouter.list（只查本企业 + 分页投影）', () => {
  it('where 恒为本企业 + createdAt 倒序 + 默认分页（page 1/pageSize 20）；item 投影含快照名 items', async () => {
    prisma.order.findMany.mockResolvedValue([{ ...makeOrder(), items: [makeOrderItem()] }])
    prisma.order.count.mockResolvedValue(1)
    const caller = orderRouter.createCaller(makeCtx())

    const result = await caller.list()

    expect(prisma.order.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      orderBy: { createdAt: 'desc' },
      skip: 0,
      take: 20,
      include: {
        items: {
          select: {
            id: true,
            planId: true,
            quantity: true,
            unitPriceCents: true,
            planSnapshot: true,
          },
        },
      },
    })
    expect(prisma.order.count).toHaveBeenCalledWith({ where: { organizationId: 'org-1' } })
    expect(result).toEqual({
      items: [
        {
          id: 'order-1',
          orderNo: 'GEO261015ab12cd34',
          organizationId: 'org-1',
          status: 'PENDING_PAYMENT',
          totalCents: 15000,
          discountCents: 0,
          payableCents: 15000,
          refundedCents: 0,
          paymentMethod: null,
          dueAt: null,
          paidAt: null,
          createdAt: NOW,
          items: [
            {
              id: 'item-1',
              planId: 'plan-1',
              quantity: 1,
              unitPriceCents: 10000,
              name: '专业版',
            },
          ],
        },
      ],
      total: 1,
    })
  })

  it('分页参数透传（page 2/pageSize 50 → skip 50/take 50）；pageSize>100 → zod 拒', async () => {
    prisma.order.findMany.mockResolvedValue([])
    prisma.order.count.mockResolvedValue(0)
    const caller = orderRouter.createCaller(makeCtx())

    await caller.list({ page: 2, pageSize: 50 })
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 50, take: 50 }),
    )

    await expect(caller.list({ pageSize: 101 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('orderRouter.get', () => {
  it('属本企业：返回 { order, items, payments, events }（order 不含关系字段；events 时间线 asc）', async () => {
    prisma.order.findUnique.mockResolvedValue({
      ...makeOrder(),
      items: [makeOrderItem()],
      payments: [makePayment()],
      events: [makeOrderEvent()],
    })
    const caller = orderRouter.createCaller(makeCtx())

    const result = await caller.get({ orderId: 'order-1' })

    expect(prisma.order.findUnique).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      include: {
        items: { orderBy: { id: 'asc' } },
        payments: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] },
        events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    })
    expect(result.order).toEqual(makeOrder())
    expect(result.items).toEqual([makeOrderItem()])
    expect(result.payments).toEqual([makePayment()])
    expect(result.events).toEqual([makeOrderEvent()])
  })

  it('越权：org A 成员 get org B 订单 → NOT_FOUND（不泄露存在性）', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder({ organizationId: 'org-2' }))
    const caller = orderRouter.createCaller(makeCtx())

    await expect(caller.get({ orderId: 'order-1' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('越权（遗留 C13）：org A MEMBER（order.view 持有者）get org B 订单 → NOT_FOUND——成员读权限不越企业边界', async () => {
    prisma.order.findUnique.mockResolvedValue({
      ...makeOrder({ organizationId: 'org-2' }),
      items: [makeOrderItem()],
      payments: [makePayment()],
      events: [makeOrderEvent()],
    })
    const caller = orderRouter.createCaller(ctxWithOrgRole('ORG_MEMBER'))

    await expect(caller.get({ orderId: 'order-1' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('订单不存在 → NOT_FOUND', async () => {
    prisma.order.findUnique.mockResolvedValue(null)
    const caller = orderRouter.createCaller(makeCtx())

    await expect(caller.get({ orderId: 'order-x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

// ---------------------------------------------------------------------------
// 客户侧 orders.cancel
// ---------------------------------------------------------------------------

describe('orderRouter.cancel（orgProcedure(order.create)）', () => {
  it('属本企业 PENDING_PAYMENT：transition cancel（乐观并发 updateMany + OrderEvent note=reason）', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder())
    const caller = orderRouter.createCaller(makeCtx())

    const result = await caller.cancel({ orderId: 'order-1', reason: '买错了' })

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: { in: ['PENDING_PAYMENT'] } },
      data: { status: 'CANCELLED' },
    })
    expect(prisma.orderEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-1',
        event: 'cancel',
        fromStatus: 'PENDING_PAYMENT',
        toStatus: 'CANCELLED',
        actorId: 'user-1',
        note: '买错了',
      }),
    })
    expect(result).toMatchObject({ event: 'cancel', toStatus: 'CANCELLED' })
  })

  it('越权：org A 成员 cancel org B 订单 → NOT_FOUND，transition 未触达', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder({ organizationId: 'org-2' }))
    const caller = orderRouter.createCaller(makeCtx())

    await expect(caller.cancel({ orderId: 'order-1' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(prisma.orderEvent.create).not.toHaveBeenCalled()
  })

  it('订单不存在 → NOT_FOUND（不区分"属他企业"与"不存在"）', async () => {
    prisma.order.findUnique.mockResolvedValue(null)
    const caller = orderRouter.createCaller(makeCtx())

    await expect(caller.cancel({ orderId: 'order-x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
  })

  it('已支付订单（PAID）取消 → CONFLICT（OrderTransitionError → 409）', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'PAID' }))
    const caller = orderRouter.createCaller(makeCtx())

    await expect(caller.cancel({ orderId: 'order-1' })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
  })

  it('ORG_MEMBER 调 cancel → FORBIDDEN（cancel 与 create 同权限点）', async () => {
    const caller = orderRouter.createCaller(ctxWithOrgRole('ORG_MEMBER'))
    await expect(caller.cancel({ orderId: 'order-1' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(prisma.order.findUnique).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 平台侧 admin.orders.*：权限矩阵
// ---------------------------------------------------------------------------

describe('adminOrderRouter：权限矩阵（platformProcedure）', () => {
  it('FINANCE 调 create → FORBIDDEN（无 order.manage），不触达 service/prisma', async () => {
    const caller = adminOrderRouter.createCaller(ctxWithPlatformRole('FINANCE'))
    await expect(
      caller.create({ organizationId: 'org-9', items: [{ planId: 'plan-1', quantity: 1 }] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(prisma.productPlan.findMany).not.toHaveBeenCalled()
    expect(prisma.order.create).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('SUPPORT 调 create → FORBIDDEN（无 order.manage）', async () => {
    const caller = adminOrderRouter.createCaller(ctxWithPlatformRole('SUPPORT'))
    await expect(
      caller.create({ organizationId: 'org-9', items: [{ planId: 'plan-1', quantity: 1 }] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(prisma.productPlan.findMany).not.toHaveBeenCalled()
  })

  it('FINANCE 调 list → 放行（order.view；任务 2 遗留用例：真实端点而非探针）', async () => {
    prisma.order.findMany.mockResolvedValue([])
    prisma.order.count.mockResolvedValue(0)
    const caller = adminOrderRouter.createCaller(ctxWithPlatformRole('FINANCE'))

    await expect(caller.list()).resolves.toEqual({ items: [], total: 0 })
  })

  it('SUPPORT 调 list → 放行（order.view）', async () => {
    prisma.order.findMany.mockResolvedValue([])
    prisma.order.count.mockResolvedValue(0)
    const caller = adminOrderRouter.createCaller(ctxWithPlatformRole('SUPPORT'))

    await expect(caller.list()).resolves.toEqual({ items: [], total: 0 })
  })

  it('客户用户（无平台角色）调 admin.orders.* → FORBIDDEN', async () => {
    const caller = adminOrderRouter.createCaller(ctxWithPlatformRole(null))
    await expect(caller.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(caller.get({ orderId: 'order-1' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      caller.create({ organizationId: 'org-9', items: [{ planId: 'plan-1', quantity: 1 }] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(caller.cancel({ orderId: 'order-1' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(prisma.order.findMany).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 平台侧 admin.orders.create（代客下单）
// ---------------------------------------------------------------------------

describe('adminOrderRouter.create（platformProcedure(order.manage)，代客下单）', () => {
  it('OPERATOR 代客下单：organizationId 必填透传 + actorId=平台员工；audit order.create（organizationId=目标企业）', async () => {
    prisma.productPlan.findMany.mockResolvedValue([SUB_PLAN])
    const caller = adminOrderRouter.createCaller(ctxWithPlatformRole('OPERATOR'))

    const result = await caller.create({
      organizationId: 'org-9',
      items: [{ planId: 'plan-1', quantity: 1 }],
    })

    expect(prisma.order.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-9',
        status: 'PENDING_PAYMENT',
        totalCents: 10000,
        discountCents: 0,
        payableCents: 10000,
      }),
    })
    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'admin-1',
      actorType: 'USER',
      action: 'order.create',
      organizationId: 'org-9',
      target: 'Order:order-1',
      diff: {
        orderNo: 'GEO261015ab12cd34',
        totalCents: 10000,
        discountCents: 0,
        payableCents: 10000,
      },
    })
    expect(result.order.organizationId).toBe('org-9')
  })

  it('organizationId 缺失/空串 → zod BAD_REQUEST，不触达 service', async () => {
    const caller = adminOrderRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))
    await expect(
      caller.create({ items: [{ planId: 'plan-1', quantity: 1 }] } as any),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      caller.create({ organizationId: '', items: [{ planId: 'plan-1', quantity: 1 }] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(prisma.productPlan.findMany).not.toHaveBeenCalled()
  })

  it('遗留 B1：organizationId 指向不存在组织 → OrganizationNotFoundError 映射 BAD_REQUEST，不落库不审计', async () => {
    prisma.productPlan.findMany.mockResolvedValue([SUB_PLAN])
    prisma.organization.findUnique.mockResolvedValue(null)
    const caller = adminOrderRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))

    await expect(
      caller.create({ organizationId: 'org-ghost', items: [{ planId: 'plan-1', quantity: 1 }] }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('org-ghost'),
    })
    expect(prisma.order.create).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('改价 remark 必填联动（复用任务 3 校验）：discountCents>0 缺 remark → BAD_REQUEST，不落库不审计', async () => {
    prisma.productPlan.findMany.mockResolvedValue([SUB_PLAN])
    const caller = adminOrderRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))

    await expect(
      caller.create({
        organizationId: 'org-9',
        items: [{ planId: 'plan-1', quantity: 1 }],
        discountCents: 2000,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(prisma.order.create).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('discountCents>0 带 remark → 成功：payable = total - discount 落库 + remark 固化 + 审计含改价', async () => {
    prisma.productPlan.findMany.mockResolvedValue([SUB_PLAN])
    const caller = adminOrderRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))

    const result = await caller.create({
      organizationId: 'org-9',
      items: [{ planId: 'plan-1', quantity: 1 }],
      discountCents: 2000,
      remark: '老客户优惠',
    })

    expect(prisma.order.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        totalCents: 10000,
        discountCents: 2000,
        payableCents: 8000,
        remark: '老客户优惠',
      }),
    })
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'order.create',
        organizationId: 'org-9',
        diff: {
          orderNo: 'GEO261015ab12cd34',
          totalCents: 10000,
          discountCents: 2000,
          payableCents: 8000,
        },
      }),
    )
    expect(result.order.payableCents).toBe(8000)
  })

  it('discountCents 负数/非整数 → zod 拒绝（物理闸在路由层）', async () => {
    const caller = adminOrderRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))
    await expect(
      caller.create({
        organizationId: 'org-9',
        items: [{ planId: 'plan-1', quantity: 1 }],
        discountCents: -1,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      caller.create({
        organizationId: 'org-9',
        items: [{ planId: 'plan-1', quantity: 1 }],
        discountCents: 100.5,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(prisma.productPlan.findMany).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 平台侧 admin.orders.list / get / cancel
// ---------------------------------------------------------------------------

describe('adminOrderRouter.list（状态机视图筛选 + 分页）', () => {
  it('无参：where {} + 默认分页（page 1/pageSize 20）；跨企业全量可见', async () => {
    prisma.order.findMany.mockResolvedValue([])
    prisma.order.count.mockResolvedValue(0)
    const caller = adminOrderRouter.createCaller(ctxWithPlatformRole('SUPPORT'))

    await caller.list()

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {}, skip: 0, take: 20 }),
    )
    expect(prisma.order.count).toHaveBeenCalledWith({ where: {} })
  })

  it('筛选透传：status / organizationId / q（orderNo contains）+ 分页（page 3/pageSize 50 → skip 100）', async () => {
    prisma.order.findMany.mockResolvedValue([])
    prisma.order.count.mockResolvedValue(0)
    const caller = adminOrderRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))

    await caller.list({
      status: 'PENDING_PAYMENT',
      organizationId: 'org-9',
      q: 'GEO2610',
      page: 3,
      pageSize: 50,
    })

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'PENDING_PAYMENT',
          organizationId: 'org-9',
          orderNo: { contains: 'GEO2610' },
        },
        skip: 100,
        take: 50,
      }),
    )
    expect(prisma.order.count).toHaveBeenCalledWith({
      where: {
        status: 'PENDING_PAYMENT',
        organizationId: 'org-9',
        orderNo: { contains: 'GEO2610' },
      },
    })
  })

  it('status 非法值 / pageSize>100 → zod 拒绝', async () => {
    const caller = adminOrderRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))
    await expect(caller.list({ status: 'WHATEVER' as any })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await expect(caller.list({ pageSize: 101 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(prisma.order.findMany).not.toHaveBeenCalled()
  })
})

describe('adminOrderRouter.get / cancel', () => {
  it('get：他企业订单也可见（平台侧无企业边界），返回 { order, items, events }', async () => {
    prisma.order.findUnique.mockResolvedValue({
      ...makeOrder({ organizationId: 'org-2' }),
      items: [makeOrderItem()],
      events: [makeOrderEvent()],
    })
    const caller = adminOrderRouter.createCaller(ctxWithPlatformRole('FINANCE'))

    const result = await caller.get({ orderId: 'order-1' })

    expect(result.order.organizationId).toBe('org-2')
    expect(result.items).toEqual([makeOrderItem()])
    expect(result.events).toEqual([makeOrderEvent()])
  })

  it('get：订单不存在 → NOT_FOUND', async () => {
    prisma.order.findUnique.mockResolvedValue(null)
    const caller = adminOrderRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))

    await expect(caller.get({ orderId: 'order-x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('cancel：transition + reason→note；返回迁移事件', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder())
    const caller = adminOrderRouter.createCaller(ctxWithPlatformRole('OPERATOR'))

    const result = await caller.cancel({ orderId: 'order-1', reason: '客户要求取消' })

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: { in: ['PENDING_PAYMENT'] } },
      data: { status: 'CANCELLED' },
    })
    expect(prisma.orderEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        event: 'cancel',
        actorId: 'admin-1',
        note: '客户要求取消',
      }),
    })
    expect(result).toMatchObject({ event: 'cancel', toStatus: 'CANCELLED' })
  })

  it('cancel：订单不存在（service OrderNotFoundError）→ NOT_FOUND', async () => {
    prisma.order.findUnique.mockResolvedValue(null)
    const caller = adminOrderRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))

    await expect(caller.cancel({ orderId: 'order-x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

// ---------------------------------------------------------------------------
// appRouter 挂载冒烟：orders.* 与 admin.orders.* 端点可达
// ---------------------------------------------------------------------------

describe('appRouter 挂载冒烟', () => {
  it('客户侧 orders.list 与平台侧 admin.orders.list 经 appRouter 可达（services 注入生效）', async () => {
    prisma.order.findMany.mockResolvedValue([])
    prisma.order.count.mockResolvedValue(0)

    const orgCaller = appRouter.createCaller(makeCtx())
    await expect(orgCaller.orders.list()).resolves.toEqual({ items: [], total: 0 })

    const adminCaller = appRouter.createCaller(ctxWithPlatformRole('SUPPORT'))
    await expect(adminCaller.admin.orders.list()).resolves.toEqual({ items: [], total: 0 })
  })

  it('任务 5：admin.payments.list 经 appRouter 可达', async () => {
    prisma.paymentTransaction.findMany.mockResolvedValue([])
    prisma.paymentTransaction.count.mockResolvedValue(0)

    const adminCaller = appRouter.createCaller(ctxWithPlatformRole('FINANCE'))
    await expect(adminCaller.admin.payments.list()).resolves.toEqual({ items: [], total: 0 })
  })
})

// ---------------------------------------------------------------------------
// 任务 5：客户侧 orders.uploadVoucher（对公转账回单上传）
// ---------------------------------------------------------------------------

const VOUCHER_B64 = Buffer.from('voucher-bytes').toString('base64')

describe('orderRouter.uploadVoucher（orgProcedure(order.create)）', () => {
  it('ORG_OWNER 属本企业订单上传成功：files.put + transition + PENDING 流水 + audit order.voucher_upload', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'PENDING_PAYMENT' }))
    const caller = orderRouter.createCaller(makeCtx())

    const result = await caller.uploadVoucher({
      orderId: 'order-1',
      fileName: 'receipt.png',
      contentBase64: VOUCHER_B64,
    })

    expect(files.put).toHaveBeenCalledWith(expect.any(Buffer), 'png')
    expect(prisma.paymentTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-1',
        method: 'BANK_TRANSFER',
        status: 'PENDING',
        amountCents: 15000,
        voucherFileKey: '0f1e2d3c4b5a69788776655443322110.png',
      }),
    })
    expect(result.event).toMatchObject({ event: 'voucher.upload', toStatus: 'PENDING_CONFIRMATION' })
    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'user-1',
      actorType: 'USER',
      action: 'order.voucher_upload',
      organizationId: 'org-1',
      target: 'Order:order-1',
      diff: {
        paymentId: 'pay-1',
        voucherFileKey: '0f1e2d3c4b5a69788776655443322110.png',
        amountCents: 15000,
      },
    })
  })

  it('越权：org A 成员上传 org B 订单回单 → NOT_FOUND，service 未触达（不写盘不建流水）', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder({ organizationId: 'org-2' }))
    const caller = orderRouter.createCaller(makeCtx())

    await expect(
      caller.uploadVoucher({ orderId: 'order-1', fileName: 'r.png', contentBase64: VOUCHER_B64 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(files.put).not.toHaveBeenCalled()
    expect(prisma.paymentTransaction.create).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('订单不存在 → NOT_FOUND（不区分"属他企业"与"不存在"）', async () => {
    prisma.order.findUnique.mockResolvedValue(null)
    const caller = orderRouter.createCaller(makeCtx())

    await expect(
      caller.uploadVoucher({ orderId: 'order-x', fileName: 'r.png', contentBase64: VOUCHER_B64 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('ORG_MEMBER 上传 → FORBIDDEN（uploadVoucher 与下单同权限点，成员不可打款凭证）', async () => {
    const caller = orderRouter.createCaller(ctxWithOrgRole('ORG_MEMBER'))
    await expect(
      caller.uploadVoucher({ orderId: 'order-1', fileName: 'r.png', contentBase64: VOUCHER_B64 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(prisma.order.findUnique).not.toHaveBeenCalled()
    expect(files.put).not.toHaveBeenCalled()
  })

  it('回单文件超 7MB → BAD_REQUEST（InvalidVoucherError 映射），不建流水不审计', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'PENDING_PAYMENT' }))
    const caller = orderRouter.createCaller(makeCtx())
    const oversized = Buffer.alloc(7 * 1024 * 1024 + 1).toString('base64')

    await expect(
      caller.uploadVoucher({ orderId: 'order-1', fileName: 'r.png', contentBase64: oversized }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(files.put).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('白名单外扩展名（r.gif）→ BAD_REQUEST，不写盘', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'PENDING_PAYMENT' }))
    const caller = orderRouter.createCaller(makeCtx())

    await expect(
      caller.uploadVoucher({ orderId: 'order-1', fileName: 'r.gif', contentBase64: VOUCHER_B64 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(files.put).not.toHaveBeenCalled()
  })

  it('contentBase64 非法 → BAD_REQUEST', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'PENDING_PAYMENT' }))
    const caller = orderRouter.createCaller(makeCtx())

    await expect(
      caller.uploadVoucher({ orderId: 'order-1', fileName: 'r.png', contentBase64: '!!!' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})

// ---------------------------------------------------------------------------
// 任务 5：admin.orders.openOnCredit（合同账期开通，platformProcedure(order.manage)）
// ---------------------------------------------------------------------------

describe('adminOrderRouter.openOnCredit（platformProcedure(order.manage)，Ruling 11）', () => {
  it('OPERATOR 开通账期：dueAt 落库 + 应收流水 + enqueue order.activate + audit order.credit_open', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'PENDING_PAYMENT' }))
    const caller = adminOrderRouter.createCaller(ctxWithPlatformRole('OPERATOR'))

    const result = await caller.openOnCredit({ orderId: 'order-1', dueDays: 30 })

    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: {
        paymentMethod: 'CONTRACT_CREDIT',
        dueAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000),
      },
    })
    expect(prisma.paymentTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-1',
        method: 'CONTRACT_CREDIT',
        status: 'PENDING',
        amountCents: 15000,
      }),
    })
    expect(boss.send).toHaveBeenCalledWith('order.activate', { orderId: 'order-1' }, ORDER_ACTIVATION_SEND_OPTIONS)
    expect(result.event).toMatchObject({ event: 'credit.open', toStatus: 'FULFILLING' })
    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'admin-1',
      actorType: 'USER',
      action: 'order.credit_open',
      organizationId: 'org-1',
      target: 'Order:order-1',
      diff: {
        dueDays: 30,
        dueAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000),
        paymentId: 'pay-1',
        payableCents: 15000,
      },
    })
  })

  it('FINANCE 调 openOnCredit → FORBIDDEN（无 order.manage；账期开通是运营动作而非资金确认）', async () => {
    const caller = adminOrderRouter.createCaller(ctxWithPlatformRole('FINANCE'))
    await expect(
      caller.openOnCredit({ orderId: 'order-1', dueDays: 30 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(prisma.paymentTransaction.create).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('dueDays 0 / 非整数 → zod BAD_REQUEST，不触达 service', async () => {
    const caller = adminOrderRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))
    await expect(
      caller.openOnCredit({ orderId: 'order-1', dueDays: 0 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      caller.openOnCredit({ orderId: 'order-1', dueDays: 1.5 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
  })

  it('订单不存在 → NOT_FOUND', async () => {
    prisma.order.findUnique.mockResolvedValue(null)
    const caller = adminOrderRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))
    await expect(
      caller.openOnCredit({ orderId: 'order-x', dueDays: 30 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

// ---------------------------------------------------------------------------
// 任务 5：admin.payments.*（platformProcedure(payment.confirm)）
// ---------------------------------------------------------------------------

describe('adminPaymentRouter：权限矩阵（platformProcedure(payment.confirm)）', () => {
  it('FINANCE 调 confirm → 放行（payment.confirm 资金域权限）', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'PENDING_CONFIRMATION' }))
    prisma.paymentTransaction.findUnique.mockResolvedValue(
      makePayment({
        orderId: 'order-1',
        status: 'PENDING',
        order: makeOrder({ id: 'order-1', status: 'PENDING_CONFIRMATION', organizationId: 'org-1' }),
      }),
    )
    const caller = adminPaymentRouter.createCaller(ctxWithPlatformRole('FINANCE'))

    const result = await caller.confirm({ paymentId: 'pay-1' })

    expect(result).toMatchObject({ orderId: 'order-1', organizationId: 'org-1' })
    expect(boss.send).toHaveBeenCalledWith('order.activate', { orderId: 'order-1' }, ORDER_ACTIVATION_SEND_OPTIONS)
  })

  it('OPERATOR 调 confirm → FORBIDDEN（无 payment.confirm），不触库', async () => {
    const caller = adminPaymentRouter.createCaller(ctxWithPlatformRole('OPERATOR'))
    await expect(caller.confirm({ paymentId: 'pay-1' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(prisma.paymentTransaction.findUnique).not.toHaveBeenCalled()
    expect(prisma.paymentTransaction.updateMany).not.toHaveBeenCalled()
    expect(boss.send).not.toHaveBeenCalled()
  })

  it('OPERATOR 调 list / reject → FORBIDDEN', async () => {
    const caller = adminPaymentRouter.createCaller(ctxWithPlatformRole('OPERATOR'))
    await expect(caller.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(caller.reject({ paymentId: 'pay-1', reason: 'x' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(prisma.paymentTransaction.findMany).not.toHaveBeenCalled()
  })

  it('客户用户（无平台角色）调 admin.payments.* → FORBIDDEN', async () => {
    const caller = adminPaymentRouter.createCaller(ctxWithPlatformRole(null))
    await expect(caller.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(caller.confirm({ paymentId: 'pay-1' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('adminPaymentRouter.list（两视图：待确认回单 / 应收账期）', () => {
  it('默认 VOUCHER 视图：method=BANK_TRANSFER + status=PENDING + 订单摘要 + 分页', async () => {
    prisma.paymentTransaction.findMany.mockResolvedValue([
      { ...makePayment(), order: makeOrder({ id: 'order-1', status: 'PENDING_CONFIRMATION' }) },
    ])
    prisma.paymentTransaction.count.mockResolvedValue(1)
    const caller = adminPaymentRouter.createCaller(ctxWithPlatformRole('FINANCE'))

    const result = await caller.list()

    expect(prisma.paymentTransaction.findMany).toHaveBeenCalledWith({
      where: { method: 'BANK_TRANSFER', status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      skip: 0,
      take: 20,
      include: {
        order: {
          select: {
            id: true,
            orderNo: true,
            organizationId: true,
            status: true,
            payableCents: true,
            dueAt: true,
            paidAt: true,
          },
        },
      },
    })
    expect(prisma.paymentTransaction.count).toHaveBeenCalledWith({
      where: { method: 'BANK_TRANSFER', status: 'PENDING' },
    })
    expect(result.total).toBe(1)
    expect(result.items[0]).toMatchObject({
      id: 'pay-1',
      method: 'BANK_TRANSFER',
      status: 'PENDING',
      order: { id: 'order-1', orderNo: 'GEO261015ab12cd34', status: 'PENDING_CONFIRMATION' },
    })
  })

  it('CREDIT 视图：method=CONTRACT_CREDIT + status=PENDING（应收账期）', async () => {
    prisma.paymentTransaction.findMany.mockResolvedValue([])
    prisma.paymentTransaction.count.mockResolvedValue(0)
    const caller = adminPaymentRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))

    await caller.list({ view: 'CREDIT', page: 2, pageSize: 50 })

    expect(prisma.paymentTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { method: 'CONTRACT_CREDIT', status: 'PENDING' },
        skip: 50,
        take: 50,
      }),
    )
  })

  it('view 非法值 → zod BAD_REQUEST', async () => {
    const caller = adminPaymentRouter.createCaller(ctxWithPlatformRole('FINANCE'))
    await expect(caller.list({ view: 'WHATEVER' as any })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })
})

describe('adminPaymentRouter.confirm / reject', () => {
  it('confirm（BANK_TRANSFER）：audit payment.confirm（含 method/orderId/resumedWorkspaces diff）', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'PENDING_CONFIRMATION' }))
    prisma.paymentTransaction.findUnique.mockResolvedValue(
      makePayment({
        orderId: 'order-1',
        status: 'PENDING',
        order: makeOrder({ id: 'order-1', status: 'PENDING_CONFIRMATION', organizationId: 'org-1' }),
      }),
    )
    const caller = adminPaymentRouter.createCaller(ctxWithPlatformRole('FINANCE'))

    await caller.confirm({ paymentId: 'pay-1' })

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'admin-1',
        actorType: 'USER',
        action: 'payment.confirm',
        organizationId: 'org-1',
        target: 'Payment:pay-1',
        diff: {
          orderId: 'order-1',
          method: 'BANK_TRANSFER',
          status: 'SUCCEEDED',
          resumedWorkspaces: 0,
        },
      }),
    )
  })

  it('confirm（CONTRACT_CREDIT）：diff.resumedWorkspaces 携带恢复行数', async () => {
    prisma.paymentTransaction.findUnique.mockResolvedValue(
      makePayment({
        method: 'CONTRACT_CREDIT',
        status: 'PENDING',
        order: makeOrder({ id: 'order-1', status: 'FULFILLING', organizationId: 'org-1' }),
      }),
    )
    prisma.workspace.updateMany.mockResolvedValue({ count: 3 })
    const caller = adminPaymentRouter.createCaller(ctxWithPlatformRole('FINANCE'))

    await caller.confirm({ paymentId: 'pay-1' })

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'payment.confirm',
        diff: {
          orderId: 'order-1',
          method: 'CONTRACT_CREDIT',
          status: 'SUCCEEDED',
          resumedWorkspaces: 3,
        },
      }),
    )
  })

  it('confirm：流水不存在 → NOT_FOUND，不审计', async () => {
    prisma.paymentTransaction.findUnique.mockResolvedValue(null)
    const caller = adminPaymentRouter.createCaller(ctxWithPlatformRole('FINANCE'))

    await expect(caller.confirm({ paymentId: 'pay-x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('reject：finance.reject 迁移 + 流水 FAILED + audit payment.reject（含 reason）', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'PENDING_CONFIRMATION' }))
    prisma.paymentTransaction.findUnique.mockResolvedValue(
      makePayment({
        orderId: 'order-1',
        status: 'PENDING',
        order: makeOrder({ id: 'order-1', status: 'PENDING_CONFIRMATION', organizationId: 'org-1' }),
      }),
    )
    const caller = adminPaymentRouter.createCaller(ctxWithPlatformRole('FINANCE'))

    const result = await caller.reject({ paymentId: 'pay-1', reason: '回单模糊' })

    expect(prisma.paymentTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'pay-1', status: 'PENDING' },
      data: { status: 'FAILED', rawPayload: { reason: '回单模糊' } },
    })
    expect(result.event).toMatchObject({ event: 'finance.reject', toStatus: 'PENDING_PAYMENT' })
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'admin-1',
        action: 'payment.reject',
        organizationId: 'org-1',
        target: 'Payment:pay-1',
        diff: { orderId: 'order-1', reason: '回单模糊', status: 'FAILED' },
      }),
    )
  })

  it('reject：reason 缺省 → zod BAD_REQUEST（驳回必须给因）', async () => {
    const caller = adminPaymentRouter.createCaller(ctxWithPlatformRole('FINANCE'))
    await expect(
      caller.reject({ paymentId: 'pay-1' } as any),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      caller.reject({ paymentId: 'pay-1', reason: '' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(prisma.paymentTransaction.findUnique).not.toHaveBeenCalled()
  })

  it('遗留 B3：audit diff.status 取 service 返回的实际流水终态（非硬编码）——注入 mock service 返回非常规状态可透传', async () => {
    // 用注入 service 携带非常规终态，证明 diff.status 是动态取值而非硬编码字面量
    const exoticPayment = { id: 'pay-1', status: 'EXOTIC_TERMINAL' }
    const ordersMock = {
      confirmPayment: vi.fn(async () => ({
        event: null,
        payment: exoticPayment,
        orderId: 'order-1',
        organizationId: 'org-1',
        paymentMethod: 'BANK_TRANSFER',
        resumedWorkspaces: 0,
      })),
      rejectVoucher: vi.fn(async () => ({
        event: null,
        payment: exoticPayment,
        orderId: 'order-1',
        organizationId: 'org-1',
      })),
    }
    const ctx = ctxWithPlatformRole('FINANCE', { services: { prisma, orders: ordersMock, audit } })
    const caller = adminPaymentRouter.createCaller(ctx)

    await caller.confirm({ paymentId: 'pay-1' })
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'payment.confirm',
        diff: expect.objectContaining({ status: 'EXOTIC_TERMINAL' }),
      }),
    )

    await caller.reject({ paymentId: 'pay-1', reason: 'x' })
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'payment.reject',
        diff: expect.objectContaining({ status: 'EXOTIC_TERMINAL' }),
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// 任务 6：客户侧 orders.createPayment（线上支付发起，微信/支付宝 mock）
// ---------------------------------------------------------------------------

describe('orderRouter.createPayment（orgProcedure(order.create)）', () => {
  it('ORG_OWNER 属本企业 PENDING_PAYMENT 订单：mock 渠道下单 + PENDING 流水（channelOrderNo 回填）+ 返回 { payUrl, channelOrderNo } + audit', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'PENDING_PAYMENT' }))
    const caller = orderRouter.createCaller(makeCtx())

    const result = await caller.createPayment({ orderId: 'order-1', method: 'WECHAT' })

    expect(prisma.paymentTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-1',
        method: 'WECHAT',
        status: 'PENDING',
        amountCents: 15000,
        channelOrderNo: expect.stringMatching(/^mock-/),
      }),
    })
    expect(result.payUrl).toBe(`https://mock.pay/qr/${result.channelOrderNo}`)
    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'user-1',
      actorType: 'USER',
      action: 'order.create_payment',
      organizationId: 'org-1',
      target: 'Order:order-1',
      diff: {
        method: 'WECHAT',
        channelOrderNo: result.channelOrderNo,
        amountCents: 15000,
      },
    })
  })

  it('ALIPAY 通道：method 透传建行', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'PENDING_PAYMENT' }))
    const caller = orderRouter.createCaller(makeCtx())

    await caller.createPayment({ orderId: 'order-1', method: 'ALIPAY' })

    expect(prisma.paymentTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ method: 'ALIPAY', status: 'PENDING' }),
    })
  })

  it('越权：org A 成员对 org B 订单发起支付 → NOT_FOUND，不建流水不审计', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder({ organizationId: 'org-2' }))
    const caller = orderRouter.createCaller(makeCtx())

    await expect(
      caller.createPayment({ orderId: 'order-1', method: 'WECHAT' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(prisma.paymentTransaction.create).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('订单不存在 → NOT_FOUND（不区分"属他企业"与"不存在"）', async () => {
    prisma.order.findUnique.mockResolvedValue(null)
    const caller = orderRouter.createCaller(makeCtx())

    await expect(
      caller.createPayment({ orderId: 'order-x', method: 'WECHAT' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('订单非 PENDING_PAYMENT（如 PAID）→ CONFLICT（PaymentStateError 映射），不建流水', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'PAID' }))
    const caller = orderRouter.createCaller(makeCtx())

    await expect(
      caller.createPayment({ orderId: 'order-1', method: 'WECHAT' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(prisma.paymentTransaction.create).not.toHaveBeenCalled()
  })

  it('ORG_MEMBER 发起支付 → FORBIDDEN（与下单同权限点），不触库', async () => {
    const caller = orderRouter.createCaller(ctxWithOrgRole('ORG_MEMBER'))
    await expect(
      caller.createPayment({ orderId: 'order-1', method: 'WECHAT' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(prisma.order.findUnique).not.toHaveBeenCalled()
    expect(prisma.paymentTransaction.create).not.toHaveBeenCalled()
  })

  it('method 线下通道（BANK_TRANSFER/CONTRACT_CREDIT）→ zod BAD_REQUEST，不触 service', async () => {
    const caller = orderRouter.createCaller(makeCtx())
    await expect(
      caller.createPayment({ orderId: 'order-1', method: 'BANK_TRANSFER' as any }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(prisma.order.findUnique).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 任务 14：orders.bankInfo（平台收款账户信息，authedProcedure 登录即可见）
// ---------------------------------------------------------------------------

describe('orderRouter.bankInfo（authedProcedure：登录即可见，纯展示无企业边界动作）', () => {
  const prevEnv = process.env.PAYMENT_BANK_INFO
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.PAYMENT_BANK_INFO
    else process.env.PAYMENT_BANK_INFO = prevEnv
  })

  it('PAYMENT_BANK_INFO 合法 JSON：返回解析对象（ORG_MEMBER 与无企业挂靠的平台账号均可见——authed 不限角色）', async () => {
    process.env.PAYMENT_BANK_INFO = JSON.stringify({
      accountName: '杭州某某科技有限公司',
      accountNo: '571908888666',
      bankName: '招商银行杭州分行',
    })
    const memberCaller = orderRouter.createCaller(ctxWithOrgRole('ORG_MEMBER'))
    await expect(memberCaller.bankInfo()).resolves.toEqual({
      accountName: '杭州某某科技有限公司',
      accountNo: '571908888666',
      bankName: '招商银行杭州分行',
    })

    const platformCaller = orderRouter.createCaller(ctxWithPlatformRole('SUPPORT'))
    await expect(platformCaller.bankInfo()).resolves.toMatchObject({ bankName: '招商银行杭州分行' })
  })

  it('env 未配置 → null（前端显示"联系顾问获取收款信息"）', async () => {
    delete process.env.PAYMENT_BANK_INFO
    const caller = orderRouter.createCaller(makeCtx())
    await expect(caller.bankInfo()).resolves.toBeNull()
  })

  it('未登录（anonymous actor）→ UNAUTHORIZED（authedProcedure 门禁仍在）', async () => {
    const caller = orderRouter.createCaller(
      makeCtx({ actor: { kind: 'anonymous' }, services: undefined }),
    )
    await expect(caller.bankInfo()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })
})

describe('parseBankInfo（单位导出，遗留 C9）', () => {
  it('合法三字段 JSON → 解析对象；未配置/空串/非法 JSON/数组/null/缺字段/字段类型不符 → null', () => {
    expect(parseBankInfo(JSON.stringify({ accountName: 'a', accountNo: 'b', bankName: 'c' }))).toEqual(
      { accountName: 'a', accountNo: 'b', bankName: 'c' },
    )
    expect(parseBankInfo(undefined)).toBeNull()
    expect(parseBankInfo('')).toBeNull()
    expect(parseBankInfo('不是 JSON')).toBeNull()
    expect(parseBankInfo('[]')).toBeNull()
    expect(parseBankInfo('null')).toBeNull()
    expect(parseBankInfo(JSON.stringify({ accountName: 'a' }))).toBeNull()
    expect(
      parseBankInfo(JSON.stringify({ accountName: 'a', accountNo: 123, bankName: 'c' })),
    ).toBeNull()
  })
})
