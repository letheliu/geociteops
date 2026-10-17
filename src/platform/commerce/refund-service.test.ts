import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createOrderService } from './order-service.js'
import type { FilesService } from './files.js'
import {
  createRefundService,
  RefundAlreadyExecutedError,
  RefundAmountExceededError,
  RefundNotFoundError,
  RefundNotPaidError,
  RefundStateError,
} from './refund-service.js'

// ---------------------------------------------------------------------------
// 测试基建：mock prisma + 真实 OrderService（状态机复用）+ 注入 deps
// （模式照 order-service.test.ts：$transaction 把 prisma 自身作为 tx 传回）
// ---------------------------------------------------------------------------

const FIXED_NOW = () => new Date('2026-10-15T12:00:00.000Z')

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'o1',
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

/** 订阅行（sourceOrderId=o1）：默认 30 天周期、已用 10 天未消耗 20 天 */
function makeSub(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    organizationId: 'org-1',
    planId: 'plan-1',
    sourceOrderId: 'o1',
    startAt: new Date('2026-10-05T12:00:00.000Z'),
    endAt: new Date('2026-11-04T12:00:00.000Z'),
    status: 'ACTIVE',
    entitlements: { maxWorkspaces: 5, maxQueries: 10 },
    createdAt: new Date('2026-10-05T12:00:00.000Z'),
    updatedAt: new Date('2026-10-05T12:00:00.000Z'),
    ...overrides,
  }
}

function makePayment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pay-1',
    orderId: 'o1',
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
    orderId: 'o1',
    paymentId: 'pay-1',
    amountCents: 20000,
    currency: 'CNY',
    reason: '产品不满意',
    status: 'PENDING',
    requestedById: 'u1',
    approvedById: null,
    channelRefundNo: null,
    executedAt: null,
    createdAt: new Date('2026-10-15T10:00:00.000Z'),
    ...overrides,
  }
}

/** 行项（默认一个 SUBSCRIPTION 行，驱动 proration 分支） */
function makeItems(kind: 'SUBSCRIPTION' | 'SERVICE' = 'SUBSCRIPTION') {
  return [
    {
      id: 'item-1',
      orderId: 'o1',
      planId: 'plan-1',
      workspaceId: null,
      quantity: 1,
      unitPriceCents: 30000,
      planSnapshot: { name: '专业版', kind, priceCents: 30000, billingPeriod: 'MONTH', entitlements: {}, deliverables: [] },
    },
  ]
}

interface PrismaOpts {
  order?: Record<string, unknown> | null
  sub?: Record<string, unknown> | null
  /** 聚合判定：org 的其他有效订阅行（null = 无其他有效服务 → 暂停） */
  otherActiveSub?: Record<string, unknown> | null
  payment?: Record<string, unknown> | null
  refund?: Record<string, unknown> | null
  items?: Record<string, unknown>[]
}

function makePrisma(opts: PrismaOpts = {}) {
  const prisma: any = {
    order: {
      findUnique: vi.fn(async () => (opts.order === undefined ? null : opts.order)),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...(opts.order ?? makeOrder()),
        ...data,
      })),
    },
    orderEvent: {
      // refund.reject（Ruling 12）回退目标解析：默认 COMPLETED
      findFirst: vi.fn(async () => ({ fromStatus: 'COMPLETED' })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'evt-1',
        createdAt: FIXED_NOW(),
        ...data,
      })),
    },
    orderItem: {
      findMany: vi.fn(async () => opts.items ?? makeItems()),
    },
    paymentTransaction: {
      findFirst: vi.fn(async () => (opts.payment === undefined ? null : opts.payment)),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    refundTransaction: {
      findUnique: vi.fn(async () => (opts.refund === undefined ? null : opts.refund)),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'rf-new-1',
        createdAt: FIXED_NOW(),
        ...data,
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    subscription: {
      // calcRefundable 按 sourceOrderId 查；聚合判定按 organizationId 查（分流 mock）
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where && where.sourceOrderId !== undefined) return opts.sub ?? null
        return opts.otherActiveSub ?? null
      }),
      findMany: vi.fn(async () => (opts.sub ? [opts.sub] : [])),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...(opts.sub ?? makeSub()), ...data })),
    },
    serviceDelivery: {
      findFirst: vi.fn(async () => null),
    },
    workspace: {
      updateMany: vi.fn(async () => ({ count: 2 })),
    },
    // 行锁串行化（Important 修复）：approve 首步 SELECT ... FOR UPDATE 的 mock——
    // 默认按 opts.refund 状态回显；并发用例用 mockImplementation 状态化推进
    $queryRaw: vi.fn(async () =>
      opts.refund ? [{ id: opts.refund.id, status: opts.refund.status }] : [],
    ),
  }
  prisma.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma))
  return prisma
}

function makeFiles(): FilesService {
  return { put: vi.fn(), remove: vi.fn(async () => {}), resolvePath: vi.fn() }
}

/** 线上渠道 mock 工厂：resolver(method) → { refund } */
function makeChannelResolver() {
  const refund = vi.fn(async () => ({ channelRefundNo: 'mock-rf-123', status: 'EXECUTED' as const }))
  const resolver = vi.fn(() => ({ refund }))
  return { resolver, refund }
}

let entitlements: { recompute: ReturnType<typeof vi.fn> }
let audit: { record: ReturnType<typeof vi.fn> }

beforeEach(() => {
  entitlements = { recompute: vi.fn(async () => ({})) }
  audit = { record: vi.fn(async () => {}) }
})

function makeService(prisma: any, channel?: (method: string) => { refund: unknown }) {
  const orders = createOrderService({ prisma, now: FIXED_NOW, files: makeFiles() })
  return createRefundService({
    prisma,
    orders,
    ...(channel ? { channelResolver: channel as never } : {}),
    entitlements: entitlements as never,
    audit: audit as never,
    now: FIXED_NOW,
  })
}

// ---------------------------------------------------------------------------
// calcRefundable：proration 数值用例（§6.2 四舍五入到分）
// ---------------------------------------------------------------------------

describe('calcRefundable：SUBSCRIPTION proration（规格 §6.2）', () => {
  it('用例 1：payable 30000 分 / 30 天周期已用 10 天 → 20000（四舍五入到分）', async () => {
    const prisma = makePrisma({ sub: makeSub() })
    const service = makeService(prisma)
    // startAt=10-05, endAt=11-04（30 天），now=10-15 → 未消耗 20 天
    await expect(service.calcRefundable(makeOrder())).resolves.toBe(20000)
  })

  it('用例 2：payable 99900 分 / 31 天周期未消耗 20 天 → 64452', async () => {
    const prisma = makePrisma({
      sub: makeSub({
        startAt: new Date('2026-10-04T12:00:00.000Z'),
        endAt: new Date('2026-11-04T12:00:00.000Z'),
      }),
    })
    const service = makeService(prisma)
    await expect(
      service.calcRefundable(makeOrder({ payableCents: 99900 })),
    ).resolves.toBe(64452)
  })

  it('上限 = payableCents - refundedCents：proration 超上限时取上限（部分退款后上限递减）', async () => {
    const prisma = makePrisma({ sub: makeSub() })
    const service = makeService(prisma)
    // proration 20000 > cap 30000-12000=18000 → 18000
    await expect(
      service.calcRefundable(makeOrder({ refundedCents: 12000 })),
    ).resolves.toBe(18000)
  })

  it('订阅已完全消耗（endAt ≤ now）→ 未消耗 0 天 → 0', async () => {
    const prisma = makePrisma({
      sub: makeSub({ startAt: new Date('2026-09-15T12:00:00.000Z'), endAt: new Date('2026-10-15T12:00:00.000Z') }),
    })
    const service = makeService(prisma)
    await expect(service.calcRefundable(makeOrder())).resolves.toBe(0)
  })

  it('SERVICE 类订单：P2 恒全额（= 上限，Ruling 5——P4 按未完成里程碑精确化）', async () => {
    const prisma = makePrisma({ items: makeItems('SERVICE'), sub: makeSub() })
    const service = makeService(prisma)
    // SERVICE 不走 proration（即使存在订阅行也不参考）
    await expect(service.calcRefundable(makeOrder())).resolves.toBe(30000)
  })

  it('SUBSCRIPTION 订单找不到订阅行（数据异常）→ 回退全额上限', async () => {
    const prisma = makePrisma({ sub: null })
    const service = makeService(prisma)
    await expect(service.calcRefundable(makeOrder())).resolves.toBe(30000)
  })
})

// ---------------------------------------------------------------------------
// request：申请退款（状态分流 + 建流水 PENDING）
// ---------------------------------------------------------------------------

describe('request：申请退款', () => {
  it('COMPLETED 订单 → refund.request 分流：迁移 REFUNDING + 同事务建 PENDING 流水（金额缺省=全额可退额）', async () => {
    const prisma = makePrisma({
      order: makeOrder({ status: 'COMPLETED' }),
      sub: makeSub(),
      payment: makePayment(),
    })
    const service = makeService(prisma)

    const result = await service.request('o1', { reason: '产品不满意' }, 'u1')

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', status: { in: ['COMPLETED', 'FULFILLING'] } },
      data: { status: 'REFUNDING' },
    })
    expect(prisma.orderEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ event: 'refund.request', fromStatus: 'COMPLETED', toStatus: 'REFUNDING', actorId: 'u1', note: '产品不满意' }),
    })
    expect(prisma.refundTransaction.create).toHaveBeenCalledWith({
      data: {
        orderId: 'o1',
        paymentId: 'pay-1',
        amountCents: 20000,
        currency: 'CNY',
        reason: '产品不满意',
        status: 'PENDING',
        requestedById: 'u1',
      },
    })
    expect(result.refund).toMatchObject({ status: 'PENDING', amountCents: 20000 })
    expect(result.refundableCents).toBe(20000)
    expect(audit.record).toHaveBeenCalledWith({
      actorType: 'USER',
      actorId: 'u1',
      action: 'refund.request',
      organizationId: 'org-1',
      target: 'Refund:rf-new-1',
      diff: expect.objectContaining({ orderId: 'o1', amountCents: 20000, refundableCents: 20000 }),
    })
  })

  it('PARTIALLY_REFUNDED 再申请 → refund.reopen 分流（from=PARTIALLY_REFUNDED）', async () => {
    const prisma = makePrisma({
      order: makeOrder({ status: 'PARTIALLY_REFUNDED', refundedCents: 12000 }),
      sub: makeSub(),
      payment: makePayment(),
    })
    const service = makeService(prisma)

    await service.request('o1', { reason: '二次退款' }, 'u1')

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', status: { in: ['PARTIALLY_REFUNDED'] } },
      data: { status: 'REFUNDING' },
    })
    expect(prisma.orderEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ event: 'refund.reopen', fromStatus: 'PARTIALLY_REFUNDED' }),
    })
  })

  it('金额超上限（amountCents > 可退额）→ RefundAmountExceededError，不迁移不建流水', async () => {
    const prisma = makePrisma({ order: makeOrder({ status: 'COMPLETED' }), sub: makeSub(), payment: makePayment() })
    const service = makeService(prisma)

    await expect(
      service.request('o1', { reason: 'x', amountCents: 20001 }, 'u1'),
    ).rejects.toThrow(RefundAmountExceededError)
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(prisma.refundTransaction.create).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('可退额为 0 且未显式指定金额 → RefundAmountExceededError（0 分退款无意义）', async () => {
    const prisma = makePrisma({
      order: makeOrder({ status: 'COMPLETED' }),
      sub: makeSub({ startAt: new Date('2026-09-15T12:00:00.000Z'), endAt: new Date('2026-10-15T12:00:00.000Z') }),
      payment: makePayment(),
    })
    const service = makeService(prisma)

    await expect(service.request('o1', { reason: 'x' }, 'u1')).rejects.toThrow(
      RefundAmountExceededError,
    )
  })

  it('订单不存在 → OrderNotFoundError（router 映射 NOT_FOUND）', async () => {
    const prisma = makePrisma({ order: null })
    const service = makeService(prisma)
    await expect(service.request('o-missing', {}, 'u1')).rejects.toThrow(/订单不存在/)
  })
})

// ---------------------------------------------------------------------------
// approve：审批执行（线上渠道 / 线下登记 / 全额 / 部分）
// ---------------------------------------------------------------------------

function refundRow(overrides: Record<string, unknown> = {}) {
  const refund = makeRefund(overrides)
  return {
    ...refund,
    order: makeOrder({ status: 'REFUNDING', ...(overrides.order as Record<string, unknown> | undefined) }),
    payment: makePayment(
      typeof overrides.payment === 'object' && overrides.payment !== null
        ? (overrides.payment as Record<string, unknown>)
        : undefined,
    ),
  }
}

describe('approve：全额执行（线上渠道）', () => {
  it('WECHAT：channel.refund（channelOrderNo+金额）→ 流水 EXECUTED/channelRefundNo + refundedCents 累加 + 原支付 REFUNDED + 订阅 EXPIRED + workspace 暂停（聚合判定无其他有效服务）+ recompute', async () => {
    const prisma = makePrisma({
      order: makeOrder({ status: 'REFUNDING' }),
      sub: makeSub(),
      payment: makePayment(),
      refund: refundRow(),
    })
    const channel = makeChannelResolver()
    const service = makeService(prisma, channel.resolver as never)

    const result = await service.approve('rf-1', {}, 'fin-1')

    // 渠道退款先行（外部副作用不入事务）
    expect(channel.resolver).toHaveBeenCalledWith('WECHAT')
    expect(channel.refund).toHaveBeenCalledWith({ channelOrderNo: 'mock-order-no-1', amountCents: 20000 })
    // 迁移 refund.full（REFUNDING → REFUNDED）
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', status: { in: ['REFUNDING'] } },
      data: { status: 'REFUNDED' },
    })
    expect(prisma.orderEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ event: 'refund.full', fromStatus: 'REFUNDING', toStatus: 'REFUNDED' }),
    })
    // 退款流水条件置 EXECUTED + channelRefundNo + approvedById + executedAt
    expect(prisma.refundTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'rf-1', status: 'PENDING' },
      data: {
        status: 'EXECUTED',
        executedAt: FIXED_NOW(),
        approvedById: 'fin-1',
        channelRefundNo: 'mock-rf-123',
      },
    })
    // 订单 refundedCents 累加
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { refundedCents: { increment: 20000 } },
    })
    // 原支付流水全额冲抵 → REFUNDED
    expect(prisma.paymentTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'pay-1', status: 'SUCCEEDED' },
      data: { status: 'REFUNDED' },
    })
    // 本订单订阅 ACTIVE → EXPIRED
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith({
      where: { sourceOrderId: 'o1', status: 'ACTIVE' },
      data: { status: 'EXPIRED' },
    })
    // 聚合判定：无其他有效服务 → 暂停 org 全部 ACTIVE workspace（原因'订阅到期'）
    expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', status: 'ACTIVE' },
      data: { status: 'SUSPENDED', suspendReason: '订阅到期' },
    })
    expect(entitlements.recompute).toHaveBeenCalledWith('org-1')
    expect(result).toMatchObject({
      executeAmountCents: 20000,
      full: true,
      online: true,
      workspaceSuspended: 2,
      organizationId: 'org-1',
    })
    expect(result.refund).toMatchObject({ status: 'EXECUTED', channelRefundNo: 'mock-rf-123', approvedById: 'fin-1' })
    expect(audit.record).toHaveBeenCalledWith({
      actorType: 'USER',
      actorId: 'fin-1',
      action: 'refund.approve',
      organizationId: 'org-1',
      target: 'Refund:rf-1',
      diff: expect.objectContaining({ orderId: 'o1', executeAmountCents: 20000, full: true }),
    })
  })

  it('聚合判定：org 仍有其他有效订阅 → 只过期不暂停 workspace（照任务 11 语义）', async () => {
    const prisma = makePrisma({
      order: makeOrder({ status: 'REFUNDING' }),
      sub: makeSub(),
      payment: makePayment(),
      refund: refundRow(),
      otherActiveSub: { id: 'sub-other' },
    })
    const channel = makeChannelResolver()
    const service = makeService(prisma, channel.resolver as never)

    const result = await service.approve('rf-1', {}, 'fin-1')

    expect(prisma.subscription.updateMany).toHaveBeenCalled() // 本订单订阅仍过期
    expect(prisma.workspace.updateMany).not.toHaveBeenCalled() // 但不暂停
    expect(result.workspaceSuspended).toBe(0)
    expect(entitlements.recompute).toHaveBeenCalledWith('org-1')
  })
})

describe('approve：部分执行（配额回收）', () => {
  it('executeAmountCents 缺省=申请额：refund.partial + refundedCents 累加 + 订阅 entitlements 按比例 floor 缩减（allowedPlatforms 保留）+ 原支付保持 SUCCEEDED + recompute', async () => {
    const prisma = makePrisma({
      order: makeOrder({ status: 'REFUNDING' }),
      sub: makeSub({
        entitlements: {
          maxWorkspaces: 5,
          maxQueries: 10,
          diagnosticRunsPerMonth: 7,
          samplesPerRun: 3,
          allowedPlatforms: ['baidu', 'google'],
          note: '文本字段不动',
        },
      }),
      payment: makePayment(),
      refund: refundRow({ amountCents: 12000 }),
    })
    const channel = makeChannelResolver()
    const service = makeService(prisma, channel.resolver as never)

    const result = await service.approve('rf-1', {}, 'fin-1')

    expect(prisma.orderEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ event: 'refund.partial', toStatus: 'PARTIALLY_REFUNDED' }),
    })
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', status: { in: ['REFUNDING'] } },
      data: { status: 'PARTIALLY_REFUNDED' },
    })
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { refundedCents: { increment: 12000 } },
    })
    // 渠道按执行金额退款
    expect(channel.refund).toHaveBeenCalledWith({ channelOrderNo: 'mock-order-no-1', amountCents: 12000 })
    // ratio = 12000/30000 = 0.4 → 保留 0.6：5→3、10→6、7→floor(4.2)=4、3→floor(1.8)=1
    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 'sub-1' },
      data: {
        entitlements: {
          maxWorkspaces: 3,
          maxQueries: 6,
          diagnosticRunsPerMonth: 4,
          samplesPerRun: 1,
          allowedPlatforms: ['baidu', 'google'],
          note: '文本字段不动',
        },
      },
    })
    // 部分退款：原支付不冲抵、订阅不过期、workspace 不暂停
    expect(prisma.paymentTransaction.updateMany).not.toHaveBeenCalled()
    expect(prisma.subscription.updateMany).not.toHaveBeenCalled()
    expect(prisma.workspace.updateMany).not.toHaveBeenCalled()
    expect(entitlements.recompute).toHaveBeenCalledWith('org-1')
    expect(result).toMatchObject({ executeAmountCents: 12000, full: false })
  })

  it('并发退款后上限递减：executeAmountCents 超当前可退额 → RefundAmountExceededError，渠道未调用', async () => {
    const prisma = makePrisma({
      order: makeOrder({ status: 'REFUNDING', refundedCents: 8000 }),
      sub: makeSub(),
      payment: makePayment(),
      // cap = 30000-8000 = 22000... 申请 25000 > cap → 拒
      refund: refundRow({ amountCents: 25000 }),
    })
    const channel = makeChannelResolver()
    const service = makeService(prisma, channel.resolver as never)

    await expect(
      service.approve('rf-1', { executeAmountCents: 25000 }, 'fin-1'),
    ).rejects.toThrow(RefundAmountExceededError)
    expect(channel.refund).not.toHaveBeenCalled()
    expect(prisma.refundTransaction.updateMany).not.toHaveBeenCalled()
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
  })
})

describe('approve：线下登记路径与幂等', () => {
  it('BANK_TRANSFER：不调渠道（财务线下打款后登记），channelRefundNo=null 直接 EXECUTED', async () => {
    const prisma = makePrisma({
      order: makeOrder({ status: 'REFUNDING', paymentMethod: 'BANK_TRANSFER' }),
      sub: makeSub(),
      payment: makePayment({ method: 'BANK_TRANSFER', channelOrderNo: null, channelTxnNo: null }),
      refund: refundRow({ payment: { method: 'BANK_TRANSFER', channelOrderNo: null, channelTxnNo: null } }),
    })
    const channel = makeChannelResolver()
    const service = makeService(prisma, channel.resolver as never)

    const result = await service.approve('rf-1', {}, 'fin-1')

    expect(channel.resolver).not.toHaveBeenCalled()
    expect(prisma.refundTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'rf-1', status: 'PENDING' },
      data: expect.objectContaining({ status: 'EXECUTED', channelRefundNo: null }),
    })
    expect(result.online).toBe(false)
    expect(result.full).toBe(true)
  })

  it('线上重复执行（已 EXECUTED）→ RefundAlreadyExecutedError，渠道不再退款', async () => {
    const prisma = makePrisma({
      order: makeOrder({ status: 'REFUNDED' }),
      sub: makeSub(),
      payment: makePayment(),
      refund: refundRow({ status: 'EXECUTED', channelRefundNo: 'mock-rf-123', executedAt: FIXED_NOW() }),
    })
    const channel = makeChannelResolver()
    const service = makeService(prisma, channel.resolver as never)

    await expect(service.approve('rf-1', {}, 'fin-1')).rejects.toThrow(RefundAlreadyExecutedError)
    expect(channel.refund).not.toHaveBeenCalled()
  })

  it('并发双 approve（两次顺序获锁）：首笔执行成功，第二笔获锁后见 EXECUTED 抛 RefundAlreadyExecutedError，渠道退款恰一次（不双发）', async () => {
    const prisma = makePrisma({
      order: makeOrder({ status: 'REFUNDING' }),
      sub: makeSub(),
      payment: makePayment(),
      refund: refundRow(),
    })
    // 状态化 mock 模拟行锁串行化：$queryRaw（锁内 pre-check）反映最新状态，
    // refundTransaction.updateMany 推进状态——第二笔 approve 获锁时已见 EXECUTED
    let status = 'PENDING'
    prisma.$queryRaw.mockImplementation(async () => [{ id: 'rf-1', status }])
    prisma.refundTransaction.updateMany.mockImplementation(
      async ({ data }: { data: { status?: string } }) => {
        if (data?.status === 'EXECUTED') status = 'EXECUTED'
        return { count: 1 }
      },
    )
    const channel = makeChannelResolver()
    const service = makeService(prisma, channel.resolver as never)

    const first = await service.approve('rf-1', {}, 'fin-1')
    expect(first.full).toBe(true)
    expect(first.refund.status).toBe('EXECUTED')

    await expect(service.approve('rf-1', {}, 'fin-2')).rejects.toThrow(RefundAlreadyExecutedError)
    // 渠道退款恰一次：第二笔在行锁 pre-check 即拒，未触达渠道
    expect(channel.refund).toHaveBeenCalledTimes(1)
    expect(channel.refund).toHaveBeenCalledWith({ channelOrderNo: 'mock-order-no-1', amountCents: 20000 })
  })

  it('审批条件更新失闸（refundTransaction.updateMany count=0，防御面）→ RefundStateError 整体回滚：事件/累加/重算/审计未达', async () => {
    const prisma = makePrisma({
      order: makeOrder({ status: 'REFUNDING' }),
      sub: makeSub(),
      payment: makePayment(),
      refund: refundRow(),
    })
    prisma.refundTransaction.updateMany.mockReturnValueOnce({ count: 0 })
    const channel = makeChannelResolver()
    const service = makeService(prisma, channel.resolver as never)

    await expect(service.approve('rf-1', {}, 'fin-1')).rejects.toThrow(RefundStateError)
    // 后续写未达（渠道调用在锁序内先于落库，见 approve ⑤→⑥ 步注释）
    expect(prisma.orderEvent.create).not.toHaveBeenCalled()
    expect(prisma.order.update).not.toHaveBeenCalled()
    expect(entitlements.recompute).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('流水不存在 → RefundNotFoundError', async () => {
    const prisma = makePrisma({ refund: null })
    const service = makeService(prisma)
    await expect(service.approve('rf-x', {}, 'fin-1')).rejects.toThrow(RefundNotFoundError)
  })

  it('channelRefundNo 唯一冲突（遗留 A5）：渠道回调返回已落库单号 → P2002 映射 RefundAlreadyExecutedError（router→CONFLICT），整体回滚不审计不重算', async () => {
    const prisma = makePrisma({
      order: makeOrder({ status: 'REFUNDING' }),
      sub: makeSub(),
      payment: makePayment(),
      refund: refundRow(),
    })
    // 渠道已调用（外部副作用），落库 updateMany 撞 channelRefundNo @unique
    prisma.refundTransaction.updateMany.mockRejectedValue(
      Object.assign(
        new Error('Unique constraint failed on the fields: (`channelRefundNo`)'),
        { code: 'P2002', meta: { target: ['channelRefundNo'] } },
      ),
    )
    const channel = makeChannelResolver()
    const service = makeService(prisma, channel.resolver as never)

    await expect(service.approve('rf-1', {}, 'fin-1')).rejects.toThrow(RefundAlreadyExecutedError)
    // 渠道退款先行已发生（真实驱动下整体事务回滚：迁移/事件/流水全部撤销）
    expect(channel.refund).toHaveBeenCalledTimes(1)
    expect(prisma.orderEvent.create).not.toHaveBeenCalled()
    expect(prisma.order.update).not.toHaveBeenCalled()
    expect(entitlements.recompute).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('channelRefundNo 冲突判定的目标精确性：其它目标的 P2002 原样上抛（不吞成 CONFLICT）', async () => {
    const prisma = makePrisma({
      order: makeOrder({ status: 'REFUNDING' }),
      sub: makeSub(),
      payment: makePayment(),
      refund: refundRow(),
    })
    prisma.refundTransaction.updateMany.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed on the fields: (`otherField`)'), {
        code: 'P2002',
        meta: { target: ['otherField'] },
      }),
    )
    const service = makeService(prisma, makeChannelResolver().resolver as never)

    const err = await service.approve('rf-1', {}, 'fin-1').catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(RefundAlreadyExecutedError)
    expect((err as { code?: string }).code).toBe('P2002')
  })

  it('已驳回（REJECTED）再审批 → RefundStateError', async () => {
    const prisma = makePrisma({ refund: refundRow({ status: 'REJECTED', approvedById: 'fin-2' }) })
    const service = makeService(prisma)
    await expect(service.approve('rf-1', {}, 'fin-1')).rejects.toThrow(RefundStateError)
  })
})

describe('approve：原支付流水收款校验（终审 I3，统一四通道 status === SUCCEEDED）', () => {
  it('未收款账期单（CONTRACT_CREDIT/PENDING 应收）→ RefundNotPaidError（REFUND_NOT_PAID），行锁内拒、零写入零渠道调用', async () => {
    const prisma = makePrisma({
      order: makeOrder({ status: 'REFUNDING', paymentMethod: 'CONTRACT_CREDIT' }),
      payment: makePayment({ method: 'CONTRACT_CREDIT', status: 'PENDING' }),
      refund: refundRow({ payment: { method: 'CONTRACT_CREDIT', status: 'PENDING' } }),
    })
    const channel = makeChannelResolver()
    const service = makeService(prisma, channel.resolver as never)

    const err = await service.approve('rf-1', {}, 'fin-1').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(RefundNotPaidError)
    expect((err as Error).name).toBe('REFUND_NOT_PAID')
    expect((err as Error).message).toContain('款项未到账')
    // 行锁内前置拒：迁移/事件/流水/累加全部未达，渠道未调用
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(prisma.orderEvent.create).not.toHaveBeenCalled()
    expect(prisma.refundTransaction.updateMany).not.toHaveBeenCalled()
    expect(prisma.order.update).not.toHaveBeenCalled()
    expect(channel.resolver).not.toHaveBeenCalled()
    expect(entitlements.recompute).not.toHaveBeenCalled()
  })

  it('未确认的转账单（BANK_TRANSFER/PENDING 回单待确认）同理拒；FAILED 终态流水也拒', async () => {
    const prisma = makePrisma({
      order: makeOrder({ status: 'REFUNDING', paymentMethod: 'BANK_TRANSFER' }),
      payment: makePayment({ method: 'BANK_TRANSFER', status: 'PENDING' }),
      refund: refundRow({ payment: { method: 'BANK_TRANSFER', status: 'PENDING' } }),
    })
    const service = makeService(prisma)
    await expect(service.approve('rf-1', {}, 'fin-1')).rejects.toThrow(RefundNotPaidError)

    const prismaFailed = makePrisma({
      order: makeOrder({ status: 'REFUNDING' }),
      payment: makePayment({ status: 'FAILED' }),
      refund: refundRow({ payment: { status: 'FAILED' } }),
    })
    await expect(makeService(prismaFailed).approve('rf-1', {}, 'fin-1')).rejects.toThrow(
      RefundNotPaidError,
    )
  })

  it('申请侧不拦（request 可留痕）：账期应收 PENDING 流水仍可提交退款申请建 PENDING 审批单', async () => {
    const prisma = makePrisma({
      order: makeOrder({ status: 'FULFILLING', paymentMethod: 'CONTRACT_CREDIT' }),
      payment: makePayment({ method: 'CONTRACT_CREDIT', status: 'PENDING' }),
    })
    const service = makeService(prisma)

    const result = await service.request('o1', { reason: '服务未达预期，申请退款' }, 'u1')

    // 申请建立（refund.request 迁移 + PENDING 退款单），锚定该应收流水待财务处置
    expect(result.event).toMatchObject({ event: 'refund.request', toStatus: 'REFUNDING' })
    expect(result.refund).toMatchObject({
      paymentId: 'pay-1',
      amountCents: 30000,
      status: 'PENDING',
    })
    expect(prisma.refundTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ orderId: 'o1', paymentId: 'pay-1', status: 'PENDING' }),
    })
  })
})

// ---------------------------------------------------------------------------
// reject：财务驳回（回退状态由 OrderEvent 解析，Ruling 12）
// ---------------------------------------------------------------------------

describe('reject：驳回退款', () => {
  it('REFUNDING → 回退申请前状态（OrderEvent 最近 toStatus=REFUNDING 的 fromStatus）+ 流水 REJECTED + approvedById', async () => {
    const prisma = makePrisma({
      order: makeOrder({ status: 'REFUNDING' }),
      sub: makeSub(),
      payment: makePayment(),
      refund: refundRow(),
    })
    prisma.orderEvent.findFirst.mockResolvedValue({ fromStatus: 'COMPLETED' })
    const service = makeService(prisma)

    const result = await service.reject('rf-1', '不符合退款条件', 'fin-1')

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', status: { in: ['REFUNDING'] } },
      data: { status: 'COMPLETED' },
    })
    expect(prisma.orderEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ event: 'refund.reject', fromStatus: 'REFUNDING', toStatus: 'COMPLETED', note: '不符合退款条件' }),
    })
    expect(prisma.refundTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'rf-1', status: 'PENDING' },
      data: { status: 'REJECTED', approvedById: 'fin-1' },
    })
    expect(result.refund).toMatchObject({ status: 'REJECTED', approvedById: 'fin-1' })
    expect(audit.record).toHaveBeenCalledWith({
      actorType: 'USER',
      actorId: 'fin-1',
      action: 'refund.reject',
      organizationId: 'org-1',
      target: 'Refund:rf-1',
      diff: expect.objectContaining({ orderId: 'o1', reason: '不符合退款条件' }),
    })
  })

  it('非 PENDING（EXECUTED）→ RefundStateError，不迁移', async () => {
    const prisma = makePrisma({
      refund: refundRow({ status: 'EXECUTED' }),
    })
    const service = makeService(prisma)
    await expect(service.reject('rf-1', '晚了', 'fin-1')).rejects.toThrow(RefundStateError)
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
  })

  it('驳回条件更新失闸（refundTransaction.updateMany count=0 竞态）→ RefundStateError，审计未达', async () => {
    const prisma = makePrisma({
      order: makeOrder({ status: 'REFUNDING' }),
      sub: makeSub(),
      payment: makePayment(),
      refund: refundRow(),
    })
    prisma.orderEvent.findFirst.mockResolvedValue({ fromStatus: 'COMPLETED' })
    prisma.refundTransaction.updateMany.mockReturnValueOnce({ count: 0 })
    const service = makeService(prisma)

    await expect(service.reject('rf-1', '竞态', 'fin-1')).rejects.toThrow(RefundStateError)
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('锁序统一（遗留 A6）：顺序 approve + reject 都以 RefundTransaction 行锁（$queryRaw）先行、订单写（order.updateMany）在后——同序不成环', async () => {
    // 场景：同订单两笔退款（部分退款后二次申请），财务先 approve 一笔、再 reject
    // 另一笔——原实现的反序锁（reject 经 transition 先锁 Order）在此交错下可死锁
    const prisma = makePrisma({
      order: makeOrder({ status: 'REFUNDING' }),
      sub: makeSub(),
      payment: makePayment(),
      refund: refundRow(),
    })
    prisma.orderEvent.findFirst.mockResolvedValue({ fromStatus: 'COMPLETED' })
    const channel = makeChannelResolver()
    const service = makeService(prisma, channel.resolver as never)

    const approved = await service.approve('rf-1', {}, 'fin-1')
    expect(approved.refund.status).toBe('EXECUTED')
    const rejected = await service.reject('rf-1', '客户撤回申请', 'fin-2')
    expect(rejected.refund.status).toBe('REJECTED')

    // mock 层面验证锁获取顺序一致：两次 $queryRaw（流水行锁）各自先于其后第一笔
    // order.updateMany（订单行写）。invocationCallOrder 为全局递增序号
    const lockCalls = prisma.$queryRaw.mock.invocationCallOrder
    const orderWrites = prisma.order.updateMany.mock.invocationCallOrder
    expect(lockCalls).toHaveLength(2)
    expect(orderWrites).toHaveLength(2)
    expect(lockCalls[0]).toBeLessThan(orderWrites[0]) // approve：流水锁 → 订单写
    expect(lockCalls[1]).toBeLessThan(orderWrites[1]) // reject：流水锁 → 订单写（原为反序）
  })
})
