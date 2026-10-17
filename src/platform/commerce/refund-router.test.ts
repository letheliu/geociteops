import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { PrismaClient, User } from '@prisma/client'
import { PLATFORM_ROLE_PERMISSIONS } from '../../core/trpc/init.js'
import { orderRouter } from './order-router.js'
import { adminRefundRouter } from './refund-router.js'
import { createOrderService } from './order-service.js'
import { createRefundService } from './refund-service.js'
import type { FilesService } from './files.js'

/**
 * 任务 12：退款路由（客户侧 orders.refundRequest 与平台侧 admin.refunds.*）。
 * 模式照 order-router.test.ts：子树 createCaller + mock ctx，services 注入
 * 真实 OrderService + 真实 RefundService（建在 mock prisma 上）——权限矩阵 /
 * 越权 / 审计断言穿透 router 触达 service 逻辑。
 */

const NOW = new Date('2026-10-15T12:00:00.000Z')

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
// fixtures（形状同 refund-service.test.ts）
// ---------------------------------------------------------------------------

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    orderNo: 'GEO261015ab12cd34',
    organizationId: 'org-1',
    status: 'COMPLETED',
    totalCents: 30000,
    discountCents: 0,
    payableCents: 30000,
    refundedCents: 0,
    currency: 'CNY',
    paymentMethod: 'WECHAT',
    dueAt: null,
    paidAt: new Date('2026-10-05T12:00:00.000Z'),
    remark: null,
    createdAt: new Date('2026-10-05T12:00:00.000Z'),
    updatedAt: new Date('2026-10-05T12:00:00.000Z'),
    ...overrides,
  }
}

function makeSub(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    organizationId: 'org-1',
    planId: 'plan-1',
    sourceOrderId: 'order-1',
    startAt: new Date('2026-10-05T12:00:00.000Z'),
    endAt: new Date('2026-11-04T12:00:00.000Z'),
    status: 'ACTIVE',
    entitlements: { maxWorkspaces: 5, maxQueries: 10, allowedPlatforms: ['baidu'] },
    createdAt: new Date('2026-10-05T12:00:00.000Z'),
    updatedAt: new Date('2026-10-05T12:00:00.000Z'),
    ...overrides,
  }
}

function makePayment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pay-1',
    orderId: 'order-1',
    method: 'WECHAT',
    amountCents: 30000,
    currency: 'CNY',
    status: 'SUCCEEDED',
    channelTxnNo: 'mock-txn-order-no-1',
    channelOrderNo: 'mock-order-no-1',
    voucherFileKey: null,
    confirmedById: 'fin-1',
    rawPayload: null,
    createdAt: new Date('2026-10-05T12:00:00.000Z'),
    ...overrides,
  }
}

function makeRefund(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rf-1',
    orderId: 'order-1',
    paymentId: 'pay-1',
    amountCents: 20000,
    currency: 'CNY',
    reason: '产品不满意',
    status: 'PENDING',
    requestedById: 'user-1',
    approvedById: null,
    channelRefundNo: null,
    executedAt: null,
    createdAt: new Date('2026-10-15T10:00:00.000Z'),
    order: makeOrder({ status: 'REFUNDING' }),
    payment: makePayment(),
    ...overrides,
  }
}

const SUB_ITEMS = [
  {
    id: 'item-1',
    orderId: 'order-1',
    planId: 'plan-1',
    workspaceId: null,
    quantity: 1,
    unitPriceCents: 30000,
    planSnapshot: {
      name: '专业版',
      kind: 'SUBSCRIPTION',
      priceCents: 30000,
      billingPeriod: 'MONTH',
      entitlements: {},
      deliverables: [],
    },
  },
]

// ---------------------------------------------------------------------------
// mock prisma + 真实 OrderService / RefundService + mock audit / channel
// ---------------------------------------------------------------------------

function makePrisma() {
  const prisma: any = {
    order: {
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...makeOrder(), ...data })),
    },
    orderEvent: {
      findFirst: vi.fn(async () => ({ fromStatus: 'COMPLETED' })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'evt-1',
        createdAt: NOW,
        ...data,
      })),
    },
    orderItem: {
      findMany: vi.fn(async () => SUB_ITEMS),
    },
    paymentTransaction: {
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    refundTransaction: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'rf-new-1',
        createdAt: NOW,
        ...data,
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    subscription: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...makeSub(), ...data })),
    },
    serviceDelivery: {
      findFirst: vi.fn(async () => null),
    },
    workspace: {
      updateMany: vi.fn(async () => ({ count: 2 })),
    },
    // 行锁串行化（Important 修复）：approve 首步 SELECT ... FOR UPDATE 的 mock，
    // 默认 rf-1/PENDING；不存在/已执行的用例按需 override
    $queryRaw: vi.fn(async () => [{ id: 'rf-1', status: 'PENDING' }]),
  }
  prisma.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma))
  return prisma as PrismaClient & any
}

function makeFiles(): FilesService {
  return { put: vi.fn(), remove: vi.fn(async () => {}), resolvePath: vi.fn() }
}

function makeChannelResolver() {
  const refund = vi.fn(async () => ({ channelRefundNo: 'mock-rf-123', status: 'EXECUTED' as const }))
  const resolver = vi.fn(() => ({ refund }))
  return { resolver, refund }
}

let prisma: ReturnType<typeof makePrisma>
let audit: ReturnType<typeof makeAudit>
let channel: ReturnType<typeof makeChannelResolver>
let entitlements: { recompute: ReturnType<typeof vi.fn> }

function makeAudit() {
  return { record: vi.fn(async () => {}), list: vi.fn() }
}

beforeEach(() => {
  prisma = makePrisma()
  audit = makeAudit()
  channel = makeChannelResolver()
  entitlements = { recompute: vi.fn(async () => ({})) }
})

function buildRefundService() {
  const orders = createOrderService({ prisma, now: () => NOW, files: makeFiles() })
  return createRefundService({
    prisma,
    orders,
    channelResolver: channel.resolver as never,
    entitlements: entitlements as never,
    audit: audit as never,
    now: () => NOW,
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
    services: { prisma, refunds: buildRefundService(), audit },
    ...overrides,
  } as any
}

/** 按企业角色构造客户用户 ctx（organizationId 默认 org-1） */
function ctxWithOrgRole(orgRole: string | null) {
  return makeCtx({
    actor: { kind: 'user', user: makeUser({ orgRole }), session: { id: 'sess-1' } },
  })
}

/** 按平台角色构造平台员工 ctx（无企业挂靠） */
function ctxWithPlatformRole(platformRole: string | null) {
  return makeCtx({
    actor: {
      kind: 'user',
      user: makeUser({
        id: 'fin-1',
        username: 'finance',
        userType: 'PLATFORM',
        platformRole,
        organizationId: null,
        orgRole: null,
      }),
      session: { id: 'sess-1' },
    },
  })
}

// ---------------------------------------------------------------------------
// 权限常量表（§2.2）
// ---------------------------------------------------------------------------

describe('PLATFORM_ROLE_PERMISSIONS：refund.manage 归属', () => {
  it('FINANCE = order.view/payment.confirm/refund.manage/invoice.manage；OPERATOR/SUPPORT 无 refund.manage', () => {
    expect(PLATFORM_ROLE_PERMISSIONS.FINANCE).toEqual([
      'order.view',
      'payment.confirm',
      'refund.manage',
      'invoice.manage',
    ])
    expect(PLATFORM_ROLE_PERMISSIONS.OPERATOR).not.toContain('refund.manage')
    expect(PLATFORM_ROLE_PERMISSIONS.SUPPORT).not.toContain('refund.manage')
  })
})

// ---------------------------------------------------------------------------
// admin.refunds.*：权限矩阵 + 工作台
// ---------------------------------------------------------------------------

describe('adminRefundRouter：权限矩阵（platformProcedure(refund.manage)）', () => {
  it('OPERATOR 调 approve / reject / list → FORBIDDEN（资金域），不触 service/prisma', async () => {
    const caller = adminRefundRouter.createCaller(ctxWithPlatformRole('OPERATOR'))
    await expect(caller.approve({ refundId: 'rf-1' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(caller.reject({ refundId: 'rf-1', reason: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(caller.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(prisma.refundTransaction.updateMany).not.toHaveBeenCalled()
    expect(prisma.refundTransaction.findMany).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('SUPPORT 调 list → FORBIDDEN（仅 order.view）', async () => {
    const caller = adminRefundRouter.createCaller(ctxWithPlatformRole('SUPPORT'))
    await expect(caller.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('客户账号（无平台角色）调 approve → FORBIDDEN', async () => {
    const caller = adminRefundRouter.createCaller(makeCtx())
    await expect(caller.approve({ refundId: 'rf-1' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('adminRefundRouter.list（FINANCE 工作台）', () => {
  it('缺省 PENDING 筛选 + createdAt asc（FIFO）+ 分页；行带 suggestedAmountCents（proration 同源）', async () => {
    prisma.refundTransaction.findMany.mockResolvedValue([makeRefund()])
    prisma.refundTransaction.count.mockResolvedValue(1)
    prisma.subscription.findFirst.mockImplementation(async ({ where }: never) =>
      where?.sourceOrderId !== undefined ? makeSub() : null,
    )
    const caller = adminRefundRouter.createCaller(ctxWithPlatformRole('FINANCE'))

    const result = await caller.list()

    expect(prisma.refundTransaction.findMany).toHaveBeenCalledWith({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
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
            refundedCents: true,
          },
        },
        payment: { select: { id: true, method: true, status: true, channelOrderNo: true } },
      },
    })
    expect(result.total).toBe(1)
    expect(result.items[0]).toMatchObject({
      id: 'rf-1',
      status: 'PENDING',
      amountCents: 20000,
      payment: { method: 'WECHAT' },
    })
    // payable 30000 / 30 天已用 10 天 → 建议执行金额 20000
    expect(result.items[0].suggestedAmountCents).toBe(20000)
  })

  it('organizationId 筛选透传到关联 order；status 筛选透传', async () => {
    prisma.refundTransaction.findMany.mockResolvedValue([])
    prisma.refundTransaction.count.mockResolvedValue(0)
    const caller = adminRefundRouter.createCaller(ctxWithPlatformRole('FINANCE'))

    await caller.list({ organizationId: 'org-9', status: 'EXECUTED', page: 2, pageSize: 50 })

    expect(prisma.refundTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'EXECUTED', order: { organizationId: 'org-9' } },
        skip: 50,
        take: 50,
      }),
    )
  })
})

describe('adminRefundRouter.approve / reject（FINANCE 放行）', () => {
  it('FINANCE approve 全额：渠道退款 + 订阅过期 + workspace 暂停 + recompute + audit refund.approve（service 层）', async () => {
    prisma.refundTransaction.findUnique.mockResolvedValue(makeRefund())
    prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'REFUNDING' }))
    prisma.paymentTransaction.findFirst.mockResolvedValue(makePayment())
    prisma.subscription.findFirst.mockImplementation(async ({ where }: never) =>
      where?.sourceOrderId !== undefined ? makeSub() : null,
    )
    const caller = adminRefundRouter.createCaller(ctxWithPlatformRole('FINANCE'))

    const result = await caller.approve({ refundId: 'rf-1' })

    expect(channel.refund).toHaveBeenCalledWith({ channelOrderNo: 'mock-order-no-1', amountCents: 20000 })
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: { in: ['REFUNDING'] } },
      data: { status: 'REFUNDED' },
    })
    expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', status: 'ACTIVE' },
      data: { status: 'SUSPENDED', suspendReason: '订阅到期' },
    })
    expect(entitlements.recompute).toHaveBeenCalledWith('org-1')
    expect(result).toMatchObject({ full: true, online: true, executeAmountCents: 20000 })
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'refund.approve', actorId: 'fin-1', organizationId: 'org-1' }),
    )
  })

  it('FINANCE reject：回退申请前状态 COMPLETED + 流水 REJECTED', async () => {
    prisma.refundTransaction.findUnique.mockResolvedValue(makeRefund())
    prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'REFUNDING' }))
    prisma.orderEvent.findFirst.mockResolvedValue({ fromStatus: 'COMPLETED' })
    const caller = adminRefundRouter.createCaller(ctxWithPlatformRole('FINANCE'))

    const result = await caller.reject({ refundId: 'rf-1', reason: '不符合退款条件' })

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: { in: ['REFUNDING'] } },
      data: { status: 'COMPLETED' },
    })
    expect(prisma.refundTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'rf-1', status: 'PENDING' },
      data: { status: 'REJECTED', approvedById: 'fin-1' },
    })
    expect(result.refund).toMatchObject({ status: 'REJECTED' })
  })

  it('流水不存在 → NOT_FOUND（RefundNotFoundError 映射）', async () => {
    prisma.refundTransaction.findUnique.mockResolvedValue(null)
    prisma.$queryRaw.mockResolvedValue([])
    const caller = adminRefundRouter.createCaller(ctxWithPlatformRole('FINANCE'))
    await expect(caller.approve({ refundId: 'rf-x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('金额超可退上限 → BAD_REQUEST（RefundAmountExceededError 映射）', async () => {
    prisma.refundTransaction.findUnique.mockResolvedValue(makeRefund({ amountCents: 25000 }))
    prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'REFUNDING', refundedCents: 8000 }))
    prisma.subscription.findFirst.mockImplementation(async ({ where }: never) =>
      where?.sourceOrderId !== undefined ? makeSub() : null,
    )
    const caller = adminRefundRouter.createCaller(ctxWithPlatformRole('FINANCE'))
    await expect(
      caller.approve({ refundId: 'rf-1', executeAmountCents: 25000 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(channel.refund).not.toHaveBeenCalled()
  })

  it('原支付流水未收款（账期应收 PENDING）→ BAD_REQUEST（RefundNotPaidError 映射，终审 I3）', async () => {
    prisma.refundTransaction.findUnique.mockResolvedValue(
      makeRefund({ payment: makePayment({ method: 'CONTRACT_CREDIT', status: 'PENDING' }) }),
    )
    prisma.order.findUnique.mockResolvedValue(
      makeOrder({ status: 'REFUNDING', paymentMethod: 'CONTRACT_CREDIT' }),
    )
    const caller = adminRefundRouter.createCaller(ctxWithPlatformRole('FINANCE'))
    await expect(caller.approve({ refundId: 'rf-1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('款项未到账'),
    })
    expect(channel.refund).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 客户侧 orders.refundRequest：权限 + 企业边界
// ---------------------------------------------------------------------------

describe('orderRouter.refundRequest（orgProcedure(order.create)）', () => {
  it('属本企业 COMPLETED 订单：refund.request 迁移 + PENDING 流水（金额缺省=proration 全额可退额）', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'COMPLETED' }))
    prisma.paymentTransaction.findFirst.mockResolvedValue(makePayment())
    prisma.subscription.findFirst.mockImplementation(async ({ where }: never) =>
      where?.sourceOrderId !== undefined ? makeSub() : null,
    )
    const caller = orderRouter.createCaller(makeCtx())

    const result = await caller.refundRequest({ orderId: 'order-1', reason: '产品不满意' })

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: { in: ['COMPLETED', 'FULFILLING'] } },
      data: { status: 'REFUNDING' },
    })
    expect(prisma.refundTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-1',
        paymentId: 'pay-1',
        amountCents: 20000,
        status: 'PENDING',
        requestedById: 'user-1',
      }),
    })
    expect(result.refundableCents).toBe(20000)
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'refund.request', actorId: 'user-1', organizationId: 'org-1' }),
    )
  })

  it('越权：org A 成员对 org B 订单申请 → NOT_FOUND，不触 service（无迁移无流水）', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder({ organizationId: 'org-2' }))
    const caller = orderRouter.createCaller(makeCtx())

    await expect(
      caller.refundRequest({ orderId: 'order-1', reason: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(prisma.refundTransaction.create).not.toHaveBeenCalled()
  })

  it('订单不存在 → NOT_FOUND（不区分"属他企业"与"不存在"）', async () => {
    prisma.order.findUnique.mockResolvedValue(null)
    const caller = orderRouter.createCaller(makeCtx())
    await expect(caller.refundRequest({ orderId: 'order-x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('ORG_MEMBER 调 refundRequest → FORBIDDEN（与下单同权限点 order.create）', async () => {
    const caller = orderRouter.createCaller(ctxWithOrgRole('ORG_MEMBER'))
    await expect(
      caller.refundRequest({ orderId: 'order-1', reason: 'x' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(prisma.order.findUnique).not.toHaveBeenCalled()
  })

  it('金额超上限 → BAD_REQUEST（RefundAmountExceededError 映射）', async () => {
    prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'COMPLETED' }))
    prisma.subscription.findFirst.mockImplementation(async ({ where }: never) =>
      where?.sourceOrderId !== undefined ? makeSub() : null,
    )
    prisma.paymentTransaction.findFirst.mockResolvedValue(makePayment())
    const caller = orderRouter.createCaller(makeCtx())

    await expect(
      caller.refundRequest({ orderId: 'order-1', reason: 'x', amountCents: 20001 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(prisma.refundTransaction.create).not.toHaveBeenCalled()
  })
})
