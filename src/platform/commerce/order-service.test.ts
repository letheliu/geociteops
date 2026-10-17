import { describe, expect, it, vi } from 'vitest'
import {
  createOrderService,
  enqueueOrderActivation,
  formatOrderNo,
  InvalidDueDaysError,
  InvalidPriceError,
  InvalidQuantityError,
  InvalidVoucherError,
  MultipleSubscriptionItemsError,
  ORDER_ACTIVATION_SEND_OPTIONS,
  OrderNoExhaustedError,
  OrderNotFoundError,
  OrderTransitionError,
  OrganizationNotFoundError,
  PaymentNotFoundError,
  PaymentStateError,
  ProductPlanInactiveError,
  QuantityMustBeOneError,
  randomBase36,
  VOUCHER_MAX_BYTES,
  type OrderEventName,
  type OrderStatusValue,
} from './order-service.js'
import type { FilesService } from './files.js'
import { ProductPlanNotFoundError } from '../catalog/service.js'

// ---------------------------------------------------------------------------
// 测试基建：mock prisma（照 member-service.test.ts 模式）
// ---------------------------------------------------------------------------

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    orderNo: 'GEO261015ab12cd34',
    organizationId: 'org-1',
    status: 'PENDING_PAYMENT',
    totalCents: 10000,
    discountCents: 0,
    payableCents: 10000,
    refundedCents: 0,
    currency: 'CNY',
    paymentMethod: null,
    dueAt: null,
    paidAt: null,
    remark: null,
    createdAt: new Date('2026-10-15T02:00:00.000Z'),
    updatedAt: new Date('2026-10-15T02:00:00.000Z'),
    ...overrides,
  }
}

function makePlan(overrides: Record<string, unknown> = {}) {
  return {
    id: 'plan-1',
    productId: 'prod-1',
    name: '专业版',
    priceCents: 10000,
    billingPeriod: 'MONTH',
    entitlements: { maxWorkspaces: 3 },
    deliverables: [],
    active: true,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    product: {
      id: 'prod-1',
      code: 'pro',
      name: '专业版',
      kind: 'SUBSCRIPTION',
      description: '',
      active: true,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    },
    ...overrides,
  }
}

const SUB_PLAN = makePlan()
const ADDON_PLAN = makePlan({
  id: 'plan-2',
  productId: 'prod-2',
  name: '加购包',
  priceCents: 5000,
  billingPeriod: null,
  product: {
    id: 'prod-2',
    code: 'addon',
    name: '加购包',
    kind: 'ADDON',
    description: '',
    active: true,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  },
})
const SERVICE_PLAN = makePlan({
  id: 'plan-3',
  productId: 'prod-3',
  name: 'SEO 优化服务',
  priceCents: 20000,
  billingPeriod: null,
  deliverables: [{ name: '站群诊断', days: 7 }],
  product: {
    id: 'prod-3',
    code: 'seo',
    name: 'SEO 优化服务',
    kind: 'SERVICE',
    description: '',
    active: true,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  },
})

function makePayment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pay-1',
    orderId: 'o1',
    method: 'BANK_TRANSFER',
    amountCents: 10000,
    currency: 'CNY',
    status: 'PENDING',
    channelTxnNo: null,
    channelOrderNo: null,
    voucherFileKey: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.png',
    confirmedById: null,
    rawPayload: null,
    createdAt: new Date('2026-10-15T02:00:00.000Z'),
    ...overrides,
  }
}

function makeFiles(keys: string[] = []): FilesService {
  const queue = [...keys]
  return {
    put: vi.fn(async () => queue.shift() ?? 'f1e2d3c4b5a6978877665544332211ff.png'),
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

function makePrisma(opts: {
  order?: Record<string, unknown> | null
  plans?: Record<string, unknown>[]
  payment?: Record<string, unknown> | null
  resumeCount?: number
  orderNoConflict?: 'always' | number // always=每次 P2002；number=前 N 次 P2002
  /** 遗留 B1：organization.findUnique 的返回（默认任意 id 命中 { id }，null=组织不存在） */
  organization?: Record<string, unknown> | null
} = {}) {
  let itemSeq = 0
  const prisma: any = {
    organization: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        opts.organization === undefined
          ? { id: where.id }
          : opts.organization,
      ),
    },
    productPlan: {
      findMany: vi.fn(async () => opts.plans ?? []),
    },
    order: {
      findUnique: vi.fn(async () => (opts.order === undefined ? null : opts.order)),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...(opts.order ?? makeOrder()),
        ...data,
      })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'order-1',
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
        createdAt: new Date('2026-10-15T02:00:00.000Z'),
        ...data,
      })),
    },
    paymentTransaction: {
      findUnique: vi.fn(async () => (opts.payment === undefined ? null : opts.payment)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'pay-1',
        createdAt: new Date('2026-10-15T02:00:00.000Z'),
        ...data,
      })),
      // 条件更新（修复轮）：默认命中 1 行；竞态用例 mockResolvedValue({ count: 0 })
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    workspace: {
      updateMany: vi.fn(async () => ({ count: opts.resumeCount ?? 0 })),
    },
  }
  if (opts.orderNoConflict) {
    let conflictsLeft = opts.orderNoConflict === 'always' ? Infinity : opts.orderNoConflict
    prisma.order.create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (conflictsLeft > 0) {
        conflictsLeft -= 1
        throw Object.assign(new Error('Unique constraint failed on the fields: (`orderNo`)'), {
          code: 'P2002',
          meta: { target: ['orderNo'] },
        })
      }
      return { id: 'order-1', ...data }
    })
  }
  // 交互式事务：把 prisma 自身作为 tx 传回（mock 委托同源）
  prisma.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma))
  return prisma
}

const FIXED_NOW = () => new Date('2026-10-15T12:00:00.000Z')

function makeService(
  prisma: any,
  suffix: () => string = () => 'ab12cd34',
  deps: { files?: FilesService; boss?: ReturnType<typeof makeBoss> } = {},
) {
  return createOrderService({
    prisma,
    now: FIXED_NOW,
    randomSuffix: suffix,
    ...(deps.files ? { files: deps.files } : {}),
    ...(deps.boss ? { boss: deps.boss } : {}),
  })
}

// ---------------------------------------------------------------------------
// 规格 §6.2 迁移表穷举（9 状态 × 12 事件 = 108 格，仅 14 格合法）
// ---------------------------------------------------------------------------

const ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'PENDING_CONFIRMATION',
  'PAID',
  'FULFILLING',
  'COMPLETED',
  'CANCELLED',
  'REFUNDING',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const

const ORDER_EVENTS = [
  'cancel',
  'voucher.upload',
  'finance.reject',
  'payment.confirmed',
  'credit.open',
  'activate.start',
  'fulfill.complete',
  'refund.request',
  'refund.full',
  'refund.partial',
  'refund.reopen',
  'refund.reject',
] as const

/** 简报表逐字：12 事件 × 合法 from（多 from 事件拆成多行）→ 14 个合法格子 */
const LEGAL_TRANSITIONS: Array<{
  event: (typeof ORDER_EVENTS)[number]
  from: (typeof ORDER_STATUSES)[number]
  to: OrderStatusValue | null // null = refund.reject 动态目标（测试固定解析为 COMPLETED）
}> = [
  { event: 'cancel', from: 'PENDING_PAYMENT', to: 'CANCELLED' },
  { event: 'voucher.upload', from: 'PENDING_PAYMENT', to: 'PENDING_CONFIRMATION' },
  { event: 'finance.reject', from: 'PENDING_CONFIRMATION', to: 'PENDING_PAYMENT' },
  { event: 'payment.confirmed', from: 'PENDING_PAYMENT', to: 'PAID' },
  { event: 'payment.confirmed', from: 'PENDING_CONFIRMATION', to: 'PAID' },
  { event: 'credit.open', from: 'PENDING_PAYMENT', to: 'FULFILLING' },
  { event: 'activate.start', from: 'PAID', to: 'FULFILLING' },
  { event: 'fulfill.complete', from: 'FULFILLING', to: 'COMPLETED' },
  { event: 'refund.request', from: 'COMPLETED', to: 'REFUNDING' },
  { event: 'refund.request', from: 'FULFILLING', to: 'REFUNDING' },
  { event: 'refund.full', from: 'REFUNDING', to: 'REFUNDED' },
  { event: 'refund.partial', from: 'REFUNDING', to: 'PARTIALLY_REFUNDED' },
  { event: 'refund.reopen', from: 'PARTIALLY_REFUNDED', to: 'REFUNDING' },
  { event: 'refund.reject', from: 'REFUNDING', to: null },
]

/** 某事件的合法 from 全集（updateMany where status IN (...) 的期望值），按简报表顺序 */
function fromSetOf(event: (typeof ORDER_EVENTS)[number]): OrderStatusValue[] {
  return LEGAL_TRANSITIONS.filter((l) => l.event === event).map((l) => l.from)
}

/** 94 个非法格子 = 全集 − 合法格 */
const ILLEGAL_CELLS = ORDER_EVENTS.flatMap((event) =>
  ORDER_STATUSES.filter(
    (from) => !LEGAL_TRANSITIONS.some((l) => l.event === event && l.from === from),
  ).map((from) => ({ event, from })),
)

describe('迁移表穷举（规格 §6.2 / §9.3）', () => {
  it('矩阵规模钉住：9 状态 × 12 事件 = 108 格，14 合法 + 94 非法，无遗漏无重复', () => {
    expect(ORDER_STATUSES).toHaveLength(9)
    expect(ORDER_EVENTS).toHaveLength(12)
    expect(LEGAL_TRANSITIONS).toHaveLength(14)
    expect(ILLEGAL_CELLS).toHaveLength(9 * 12 - 14)
    expect(LEGAL_TRANSITIONS.length + ILLEGAL_CELLS.length).toBe(ORDER_STATUSES.length * ORDER_EVENTS.length)
  })

  describe('合法格子（14）：updateMany 乐观并发 + 写 OrderEvent', () => {
    it.each(LEGAL_TRANSITIONS)('$event：$from → $to', async ({ event, from, to }) => {
      const prisma = makePrisma({ order: makeOrder({ id: 'o1', status: from }) })
      // refund.reject 的目标动态解析：最近一条 toStatus=REFUNDING 的 fromStatus（Ruling 12）
      if (event === 'refund.reject') {
        prisma.orderEvent.findFirst.mockResolvedValue({ fromStatus: 'COMPLETED' })
      }
      const expectedTo = event === 'refund.reject' ? 'COMPLETED' : (to as OrderStatusValue)
      const service = makeService(prisma)

      const evt = await service.transition('o1', event as OrderEventName, { actorId: 'u1' })

      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'o1', status: { in: fromSetOf(event) } },
        data: { status: expectedTo },
      })
      expect(prisma.orderEvent.create).toHaveBeenCalledWith({
        data: {
          orderId: 'o1',
          event,
          fromStatus: from,
          toStatus: expectedTo,
          actorId: 'u1',
          note: null,
        },
      })
      expect(evt).toMatchObject({ orderId: 'o1', event, fromStatus: from, toStatus: expectedTo })
    })
  })

  describe('非法格子（94）：一律抛 OrderTransitionError，不触库不写事件', () => {
    it.each(ILLEGAL_CELLS)('$event：$from → OrderTransitionError', async ({ event, from }) => {
      const prisma = makePrisma({ order: makeOrder({ id: 'o1', status: from }) })
      const service = makeService(prisma)

      await expect(service.transition('o1', event as OrderEventName)).rejects.toThrow(
        OrderTransitionError,
      )
      expect(prisma.order.updateMany).not.toHaveBeenCalled()
      expect(prisma.orderEvent.create).not.toHaveBeenCalled()
    })
  })
})

describe('transition 边界（规格 §6.2）', () => {
  it('未知事件：抛 OrderTransitionError，不查库', async () => {
    const prisma = makePrisma()
    const service = makeService(prisma)
    await expect(service.transition('o1', 'explode' as unknown as OrderEventName)).rejects.toThrow(
      OrderTransitionError,
    )
    expect(prisma.order.findUnique).not.toHaveBeenCalled()
  })

  it('订单不存在：抛 OrderNotFoundError', async () => {
    const prisma = makePrisma({ order: null })
    const service = makeService(prisma)
    await expect(service.transition('o-missing', 'cancel')).rejects.toThrow(OrderNotFoundError)
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
  })

  it('乐观并发：状态预检通过但 updateMany count=0（并发改态）→ OrderTransitionError，消息含 orderId/event/期望 from 集合/实际状态', async () => {
    const prisma = makePrisma()
    prisma.order.findUnique
      .mockResolvedValueOnce(makeOrder({ id: 'o1', status: 'PENDING_PAYMENT' })) // 预检
      .mockResolvedValueOnce(makeOrder({ id: 'o1', status: 'PAID' })) // count=0 后诊断回读
    prisma.order.updateMany.mockResolvedValue({ count: 0 })
    const service = makeService(prisma)

    await expect(service.transition('o1', 'cancel')).rejects.toThrow(
      /o1[\s\S]*cancel[\s\S]*PENDING_PAYMENT[\s\S]*PAID/,
    )
    expect(prisma.orderEvent.create).not.toHaveBeenCalled()
  })

  it('并发回读订单已被删除：actual 以“订单不存在”呈现', async () => {
    const prisma = makePrisma()
    prisma.order.findUnique.mockResolvedValueOnce(makeOrder({ status: 'REFUNDING' })).mockResolvedValueOnce(null)
    prisma.order.updateMany.mockResolvedValue({ count: 0 })
    const service = makeService(prisma)
    await expect(service.transition('o1', 'refund.full')).rejects.toThrow(/订单不存在/)
  })

  it('actorId/note 透传到 OrderEvent；缺省为 null', async () => {
    const prisma = makePrisma({ order: makeOrder({ status: 'PENDING_PAYMENT' }) })
    const service = makeService(prisma)
    await service.transition('o1', 'cancel', { actorId: 'u9', note: '客户主动取消' })
    expect(prisma.orderEvent.create).toHaveBeenCalledWith({
      data: {
        orderId: 'o1',
        event: 'cancel',
        fromStatus: 'PENDING_PAYMENT',
        toStatus: 'CANCELLED',
        actorId: 'u9',
        note: '客户主动取消',
      },
    })

    const prisma2 = makePrisma({ order: makeOrder({ status: 'PENDING_PAYMENT' }) })
    await makeService(prisma2).transition('o1', 'cancel')
    expect(prisma2.orderEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorId: null, note: null }),
    })
  })

  it('refund.reject（Ruling 12）：查最近一条 toStatus=REFUNDING 的 fromStatus 作为目标', async () => {
    const prisma = makePrisma({ order: makeOrder({ status: 'REFUNDING' }) })
    prisma.orderEvent.findFirst.mockResolvedValue({ fromStatus: 'FULFILLING' })
    const service = makeService(prisma)

    await service.transition('o1', 'refund.reject', { actorId: 'finance-1' })

    expect(prisma.orderEvent.findFirst).toHaveBeenCalledWith({
      where: { orderId: 'o1', toStatus: 'REFUNDING' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { fromStatus: true },
    })
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', status: { in: ['REFUNDING'] } },
      data: { status: 'FULFILLING' },
    })
    expect(prisma.orderEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ event: 'refund.reject', fromStatus: 'REFUNDING', toStatus: 'FULFILLING' }),
    })
  })

  it('refund.reject：无 toStatus=REFUNDING 历史事件 → OrderTransitionError，不触 updateMany', async () => {
    const prisma = makePrisma({ order: makeOrder({ status: 'REFUNDING' }) })
    const service = makeService(prisma)
    await expect(service.transition('o1', 'refund.reject')).rejects.toThrow(OrderTransitionError)
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
  })

  it('refund.reject：历史事件 fromStatus 为 null（脏数据）→ OrderTransitionError', async () => {
    const prisma = makePrisma({ order: makeOrder({ status: 'REFUNDING' }) })
    prisma.orderEvent.findFirst.mockResolvedValue({ fromStatus: null })
    const service = makeService(prisma)
    await expect(service.transition('o1', 'refund.reject')).rejects.toThrow(OrderTransitionError)
  })

  it('迁移与事件写入同事务：$transaction 恰一次，updateMany 与 orderEvent.create 均在其中执行（崩溃窗口不留"已迁无事件"）', async () => {
    const prisma = makePrisma({ order: makeOrder({ status: 'PENDING_PAYMENT' }) })
    const service = makeService(prisma)
    await service.transition('o1', 'cancel', { actorId: 'u1' })

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    // mock 将 prisma 自身作为 tx 传入：两操作各执行一次即均在事务回调内完成
    expect(prisma.order.updateMany).toHaveBeenCalledTimes(1)
    expect(prisma.orderEvent.create).toHaveBeenCalledTimes(1)
  })

  it('事务内 count=0 抛错：整体无写入（事件不落库、$transaction 拒绝）', async () => {
    const prisma = makePrisma()
    prisma.order.findUnique
      .mockResolvedValueOnce(makeOrder({ id: 'o1', status: 'PENDING_PAYMENT' }))
      .mockResolvedValueOnce(makeOrder({ id: 'o1', status: 'PAID' }))
    prisma.order.updateMany.mockResolvedValue({ count: 0 })
    const service = makeService(prisma)

    await expect(service.transition('o1', 'cancel')).rejects.toThrow(OrderTransitionError)
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(prisma.orderEvent.create).not.toHaveBeenCalled()
  })

  it('refund.reject 同毫秒双 REFUNDING 事件（refund.request 后 refund.reopen）：tiebreak 取后写的 reopen，回退目标必须是 PARTIALLY_REFUNDED', async () => {
    const prisma = makePrisma({ order: makeOrder({ status: 'REFUNDING' }) })
    const sameMs = new Date('2026-10-15T03:00:00.000Z')
    const refundingEntries = [
      { id: 'evt-0001', fromStatus: 'COMPLETED', createdAt: sameMs }, // refund.request（先写）
      { id: 'evt-0002', fromStatus: 'PARTIALLY_REFUNDED', createdAt: sameMs }, // refund.reopen（后写，id 字典序更大）
    ]
    // 忠实实现 findFirst 的排序语义（createdAt desc + id desc），模拟 prisma 行为
    prisma.orderEvent.findFirst.mockImplementation(async () => {
      return [...refundingEntries].sort((a, b) => {
        const byTime = b.createdAt.getTime() - a.createdAt.getTime()
        if (byTime !== 0) return byTime
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0 // id desc
      })[0]
    })
    const service = makeService(prisma)

    await service.transition('o1', 'refund.reject', { actorId: 'finance-1' })

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', status: { in: ['REFUNDING'] } },
      data: { status: 'PARTIALLY_REFUNDED' },
    })
    expect(prisma.orderEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        event: 'refund.reject',
        fromStatus: 'REFUNDING',
        toStatus: 'PARTIALLY_REFUNDED',
      }),
    })
  })
})

// ---------------------------------------------------------------------------
// generateOrderNo：GEO + yyMMdd(UTC) + 8 位 base36；P2002 冲突重试 ≤3 后耗尽
// ---------------------------------------------------------------------------

describe('订单号生成', () => {
  it('formatOrderNo：GEO + yyMMdd + 后缀拼接（UTC 日期）', () => {
    expect(formatOrderNo(new Date('2026-10-15T12:00:00.000Z'), 'ab12cd34')).toBe('GEO261015ab12cd34')
    expect(formatOrderNo(new Date('2030-01-01T00:30:00.000Z'), '0000zzzz')).toBe('GEO3001010000zzzz')
    expect(formatOrderNo(new Date('2026-12-31T23:59:59.999Z'), 'q1w2e3r4')).toBe('GEO261231q1w2e3r4')
  })

  it('randomBase36：仅 [0-9a-z]，默认长度 8', () => {
    for (let i = 0; i < 50; i++) {
      expect(randomBase36(8)).toMatch(/^[0-9a-z]{8}$/)
    }
  })

  it('create 落库的 orderNo = GEO+UTC 日期+注入后缀（确定性）', async () => {
    const prisma = makePrisma({ plans: [SUB_PLAN] })
    const service = makeService(prisma)
    await service.create({
      organizationId: 'org-1',
      actorId: 'u1',
      items: [{ planId: 'plan-1', quantity: 1 }],
    })
    expect(prisma.order.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ orderNo: 'GEO261015ab12cd34' }),
    })
  })

  it('P2002 冲突自动重试：前 2 次冲突，第 3 次成功，orderNo 取新后缀', async () => {
    const prisma = makePrisma({ plans: [SUB_PLAN], orderNoConflict: 2 })
    const suffixes = ['aaaa1111', 'bbbb2222', 'cccc3333']
    const service = makeService(prisma, () => suffixes.shift()!)

    const result = await service.create({
      organizationId: 'org-1',
      actorId: 'u1',
      items: [{ planId: 'plan-1', quantity: 1 }],
    })

    expect(prisma.order.create).toHaveBeenCalledTimes(3)
    expect(result.order.orderNo).toBe('GEO261015cccc3333')
  })

  it('3 次尝试均 P2002 → OrderNoExhaustedError（重试上限）', async () => {
    const prisma = makePrisma({ plans: [SUB_PLAN], orderNoConflict: 'always' })
    const service = makeService(prisma, () => 'dupesuffix')

    await expect(
      service.create({ organizationId: 'org-1', actorId: 'u1', items: [{ planId: 'plan-1', quantity: 1 }] }),
    ).rejects.toThrow(OrderNoExhaustedError)
    expect(prisma.order.create).toHaveBeenCalledTimes(3)
  })

  it('P2002 命中其他唯一索引（meta.target 不含 orderNo）：原样重抛，不做订单号重试', async () => {
    const prisma = makePrisma({ plans: [SUB_PLAN] })
    const foreignConflict = Object.assign(
      new Error('Unique constraint failed on the fields: (`otherField`)'),
      { code: 'P2002', meta: { target: ['otherField'] } },
    )
    prisma.order.create.mockRejectedValue(foreignConflict)
    const service = makeService(prisma)

    await expect(
      service.create({ organizationId: 'org-1', actorId: 'u1', items: [{ planId: 'plan-1', quantity: 1 }] }),
    ).rejects.toBe(foreignConflict)
    expect(prisma.order.create).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// create：快照 / 金额 / 改价 remark / 至多一个 SUBSCRIPTION / 负 payable
// ---------------------------------------------------------------------------

describe('orderService.create（规格 §6.2 下单）', () => {
  it('成功下单：快照固化 + 金额计算 + 初始事件 + 返回 { order, items, events }', async () => {
    const prisma = makePrisma({ plans: [SUB_PLAN, ADDON_PLAN] })
    const service = makeService(prisma)

    const result = await service.create({
      organizationId: 'org-1',
      actorId: 'u1',
      items: [
        { planId: 'plan-1', quantity: 1 },
        { planId: 'plan-2', quantity: 3, workspaceId: 'ws-1' },
      ],
      discountCents: 5000,
      remark: '  老客优惠  ',
    })

    // 套餐查询：去重后 in 查询 + include product（取 kind 入快照）
    expect(prisma.productPlan.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['plan-1', 'plan-2'] } },
      include: { product: true },
    })

    // 订单：PENDING_PAYMENT + 金额（total=1×10000+3×5000，discount 后 payable）+ remark 去空白
    expect(prisma.order.create).toHaveBeenCalledWith({
      data: {
        orderNo: 'GEO261015ab12cd34',
        organizationId: 'org-1',
        status: 'PENDING_PAYMENT',
        totalCents: 25000,
        discountCents: 5000,
        payableCents: 20000,
        remark: '老客优惠',
      },
    })

    // 行项快照：键名固定 { name, kind, priceCents, billingPeriod, entitlements, deliverables }
    expect(prisma.orderItem.create).toHaveBeenNthCalledWith(1, {
      data: {
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
      },
    })
    expect(prisma.orderItem.create).toHaveBeenNthCalledWith(2, {
      data: {
        orderId: 'order-1',
        planId: 'plan-2',
        workspaceId: 'ws-1',
        quantity: 3,
        unitPriceCents: 5000,
        planSnapshot: {
          name: '加购包',
          kind: 'ADDON',
          priceCents: 5000,
          billingPeriod: null,
          entitlements: { maxWorkspaces: 3 },
          deliverables: [],
        },
      },
    })

    // 初始事件：event='create'，fromStatus=null，toStatus=PENDING_PAYMENT
    expect(prisma.orderEvent.create).toHaveBeenCalledWith({
      data: {
        orderId: 'order-1',
        event: 'create',
        fromStatus: null,
        toStatus: 'PENDING_PAYMENT',
        actorId: 'u1',
        note: null,
      },
    })

    expect(result.order).toMatchObject({ id: 'order-1', status: 'PENDING_PAYMENT', payableCents: 20000 })
    expect(result.items).toHaveLength(2)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({ event: 'create', toStatus: 'PENDING_PAYMENT' })
  })

  it('同一 planId 多行：findMany 入参去重', async () => {
    const prisma = makePrisma({ plans: [ADDON_PLAN] })
    const service = makeService(prisma)
    await service.create({
      organizationId: 'org-1',
      actorId: 'u1',
      items: [
        { planId: 'plan-2', quantity: 1 },
        { planId: 'plan-2', quantity: 2, workspaceId: 'ws-2' },
      ],
    })
    expect(prisma.productPlan.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['plan-2'] } },
      include: { product: true },
    })
    expect(prisma.order.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ totalCents: 15000, payableCents: 15000, discountCents: 0, remark: null }),
    })
  })

  it('套餐不存在：抛 ProductPlanNotFoundError（复用 catalog 错误类）', async () => {
    const prisma = makePrisma({ plans: [] })
    const service = makeService(prisma)
    await expect(
      service.create({ organizationId: 'org-1', actorId: 'u1', items: [{ planId: 'plan-x', quantity: 1 }] }),
    ).rejects.toThrow(ProductPlanNotFoundError)
    expect(prisma.order.create).not.toHaveBeenCalled()
  })

  it('遗留 B1：目标组织不存在 → OrganizationNotFoundError（防 FK P2003 裸 500），前置校验不触套餐查询不落库', async () => {
    const prisma = makePrisma({ plans: [SUB_PLAN], organization: null })
    const service = makeService(prisma)
    await expect(
      service.create({ organizationId: 'org-x', actorId: 'u1', items: [{ planId: 'plan-1', quantity: 1 }] }),
    ).rejects.toThrow(OrganizationNotFoundError)
    await expect(
      service.create({ organizationId: 'org-x', actorId: 'u1', items: [{ planId: 'plan-1', quantity: 1 }] }),
    ).rejects.toMatchObject({ name: 'ORGANIZATION_NOT_FOUND' })
    expect(prisma.organization.findUnique).toHaveBeenCalledWith({
      where: { id: 'org-x' },
      select: { id: true },
    })
    expect(prisma.productPlan.findMany).not.toHaveBeenCalled()
    expect(prisma.order.create).not.toHaveBeenCalled()
  })

  it('套餐已下架（active=false）：抛 ProductPlanInactiveError', async () => {
    const prisma = makePrisma({ plans: [makePlan({ active: false })] })
    const service = makeService(prisma)
    await expect(
      service.create({ organizationId: 'org-1', actorId: 'u1', items: [{ planId: 'plan-1', quantity: 1 }] }),
    ).rejects.toThrow(ProductPlanInactiveError)
    expect(prisma.order.create).not.toHaveBeenCalled()
  })

  it('两个 SUBSCRIPTION 行：抛 MultipleSubscriptionItemsError（Ruling 8）', async () => {
    const SUB_PLAN_B = makePlan({ id: 'plan-1b', name: '专业版年付', priceCents: 100000 })
    const prisma = makePrisma({ plans: [SUB_PLAN, SUB_PLAN_B, ADDON_PLAN] })
    const service = makeService(prisma)
    await expect(
      service.create({
        organizationId: 'org-1',
        actorId: 'u1',
        items: [
          { planId: 'plan-1', quantity: 1 },
          { planId: 'plan-1b', quantity: 1 },
        ],
      }),
    ).rejects.toThrow(MultipleSubscriptionItemsError)
    expect(prisma.order.create).not.toHaveBeenCalled()
  })

  it('一个 SUBSCRIPTION + 若干 ADDON：放行（至多一个，不是禁止）', async () => {
    const prisma = makePrisma({ plans: [SUB_PLAN, ADDON_PLAN] })
    const service = makeService(prisma)
    const result = await service.create({
      organizationId: 'org-1',
      actorId: 'u1',
      items: [
        { planId: 'plan-1', quantity: 1 },
        { planId: 'plan-2', quantity: 3 },
      ],
    })
    expect(result.items).toHaveLength(2)
  })

  it('discountCents > 0 且 remark 缺省：抛 InvalidPriceError（可改价，需填写原因）', async () => {
    const prisma = makePrisma({ plans: [SUB_PLAN] })
    const service = makeService(prisma)
    await expect(
      service.create({
        organizationId: 'org-1',
        actorId: 'u1',
        items: [{ planId: 'plan-1', quantity: 1 }],
        discountCents: 1000,
      }),
    ).rejects.toThrow(InvalidPriceError)
  })

  it('discountCents > 0 且 remark 纯空白：同样拒绝', async () => {
    const prisma = makePrisma({ plans: [SUB_PLAN] })
    const service = makeService(prisma)
    await expect(
      service.create({
        organizationId: 'org-1',
        actorId: 'u1',
        items: [{ planId: 'plan-1', quantity: 1 }],
        discountCents: 1000,
        remark: '   ',
      }),
    ).rejects.toThrow(InvalidPriceError)
  })

  it('payableCents 为负（discount > total）：抛 InvalidPriceError', async () => {
    const prisma = makePrisma({ plans: [SUB_PLAN] })
    const service = makeService(prisma)
    await expect(
      service.create({
        organizationId: 'org-1',
        actorId: 'u1',
        items: [{ planId: 'plan-1', quantity: 1 }],
        discountCents: 10001,
        remark: '改多了',
      }),
    ).rejects.toThrow(InvalidPriceError)
    expect(prisma.order.create).not.toHaveBeenCalled()
  })

  it('discountCents 负数 / 非整数：抛 InvalidPriceError', async () => {
    const prisma = makePrisma({ plans: [SUB_PLAN] })
    const service = makeService(prisma)
    await expect(
      service.create({
        organizationId: 'org-1',
        actorId: 'u1',
        items: [{ planId: 'plan-1', quantity: 1 }],
        discountCents: -100,
      }),
    ).rejects.toThrow(InvalidPriceError)
    await expect(
      service.create({
        organizationId: 'org-1',
        actorId: 'u1',
        items: [{ planId: 'plan-1', quantity: 1 }],
        discountCents: 100.5,
      }),
    ).rejects.toThrow(InvalidPriceError)
  })

  it('quantity 0 / 负数 / 非整数：抛 InvalidQuantityError', async () => {
    const prisma = makePrisma({ plans: [SUB_PLAN] })
    const service = makeService(prisma)
    for (const quantity of [0, -1, 1.5]) {
      await expect(
        service.create({ organizationId: 'org-1', actorId: 'u1', items: [{ planId: 'plan-1', quantity }] }),
      ).rejects.toThrow(InvalidQuantityError)
    }
    expect(prisma.productPlan.findMany).not.toHaveBeenCalled()
  })

  it('终审 C1：SUBSCRIPTION 行 quantity=2 → QuantityMustBeOneError（name=INVALID_QUANTITY），不建单', async () => {
    const prisma = makePrisma({ plans: [SUB_PLAN] })
    const service = makeService(prisma)

    const err = await service
      .create({ organizationId: 'org-1', actorId: 'u1', items: [{ planId: 'plan-1', quantity: 2 }] })
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(QuantityMustBeOneError)
    expect((err as Error).name).toBe('INVALID_QUANTITY')
    expect((err as Error).message).toContain('plan-1')
    expect(prisma.order.create).not.toHaveBeenCalled()
    expect(prisma.orderItem.create).not.toHaveBeenCalled()
  })

  it('终审 C1：SERVICE 行 quantity≠1 同样拒绝；ADDON quantity=3 放行（金额按 3 倍计价）', async () => {
    const prisma = makePrisma({ plans: [SERVICE_PLAN, ADDON_PLAN] })
    const service = makeService(prisma)

    await expect(
      service.create({ organizationId: 'org-1', actorId: 'u1', items: [{ planId: 'plan-3', quantity: 2 }] }),
    ).rejects.toThrow(QuantityMustBeOneError)
    expect(prisma.order.create).not.toHaveBeenCalled()

    // ADDON 数量倍乘合法：金额 = 3 × 5000
    await service.create({
      organizationId: 'org-1',
      actorId: 'u1',
      items: [{ planId: 'plan-2', quantity: 3 }],
    })
    expect(prisma.order.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ totalCents: 15000, payableCents: 15000 }),
    })
  })

  it('空 items：抛 InvalidPriceError', async () => {
    const prisma = makePrisma({ plans: [SUB_PLAN] })
    const service = makeService(prisma)
    await expect(
      service.create({ organizationId: 'org-1', actorId: 'u1', items: [] }),
    ).rejects.toThrow(InvalidPriceError)
  })
})

// ---------------------------------------------------------------------------
// 任务 5：对公转账回单上传 / 收款确认 / 回单驳回 / 合同账期开通 + enqueue
// ---------------------------------------------------------------------------

const B64_HELLO = Buffer.from('hello-voucher').toString('base64')

describe('uploadVoucher（对公转账回单，§6.2 voucher.upload）', () => {
  it('成功：校验前置 → files.put → transition PENDING_PAYMENT→PENDING_CONFIRMATION → 建 BANK_TRANSFER/PENDING 流水（amount=payableCents, voucherFileKey）', async () => {
    const prisma = makePrisma({ order: makeOrder({ id: 'o1', payableCents: 15000, status: 'PENDING_PAYMENT' }) })
    const files = makeFiles(['0f1e2d3c4b5a69788776655443322110.png'])
    const service = makeService(prisma, undefined, { files })

    const result = await service.uploadVoucher('o1', { fileName: '回单.png', contentBase64: B64_HELLO }, 'u1')

    expect(files.put).toHaveBeenCalledWith(Buffer.from('hello-voucher'), 'png')
    // transition：乐观并发 updateMany + OrderEvent（note=fileName）
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', status: { in: ['PENDING_PAYMENT'] } },
      data: { status: 'PENDING_CONFIRMATION' },
    })
    expect(prisma.orderEvent.create).toHaveBeenCalledWith({
      data: {
        orderId: 'o1',
        event: 'voucher.upload',
        fromStatus: 'PENDING_PAYMENT',
        toStatus: 'PENDING_CONFIRMATION',
        actorId: 'u1',
        note: '回单.png',
      },
    })
    expect(prisma.paymentTransaction.create).toHaveBeenCalledWith({
      data: {
        orderId: 'o1',
        method: 'BANK_TRANSFER',
        status: 'PENDING',
        amountCents: 15000,
        currency: 'CNY',
        voucherFileKey: '0f1e2d3c4b5a69788776655443322110.png',
      },
    })
    expect(result.event).toMatchObject({ event: 'voucher.upload', toStatus: 'PENDING_CONFIRMATION' })
    expect(result.payment).toMatchObject({ method: 'BANK_TRANSFER', status: 'PENDING' })
    expect(result.voucherFileKey).toBe('0f1e2d3c4b5a69788776655443322110.png')
    expect(result.organizationId).toBe('org-1')
  })

  it.each(['回单.PNG', '回单.Pdf'] as const)('扩展名大小写不敏感：%s → 规范为白名单小写', async (fileName) => {
    const prisma = makePrisma({ order: makeOrder({ status: 'PENDING_PAYMENT' }) })
    const files = makeFiles(['0f1e2d3c4b5a69788776655443322110.pdf'])
    const service = makeService(prisma, undefined, { files })

    await service.uploadVoucher('o1', { fileName, contentBase64: B64_HELLO }, 'u1')

    expect(files.put).toHaveBeenCalledWith(expect.any(Buffer), fileName.endsWith('PNG') ? 'png' : 'pdf')
  })

  it.each([
    ['回单.gif', '白名单外扩展'],
    ['回单', '无扩展名'],
    ['', 'fileName 空串'],
    [undefined, 'fileName 缺省'],
  ])('fileName=%s（%s）→ InvalidVoucherError，不触库不写盘', async (fileName) => {
    const prisma = makePrisma({ order: makeOrder({ status: 'PENDING_PAYMENT' }) })
    const files = makeFiles()
    const service = makeService(prisma, undefined, { files })

    await expect(
      service.uploadVoucher('o1', { fileName, contentBase64: B64_HELLO }, 'u1'),
    ).rejects.toThrow(InvalidVoucherError)
    expect(files.put).not.toHaveBeenCalled()
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(prisma.paymentTransaction.create).not.toHaveBeenCalled()
  })

  it('contentBase64 非法（非 base64 字符集）→ InvalidVoucherError', async () => {
    const prisma = makePrisma({ order: makeOrder({ status: 'PENDING_PAYMENT' }) })
    const files = makeFiles()
    const service = makeService(prisma, undefined, { files })

    await expect(
      service.uploadVoucher('o1', { fileName: 'a.png', contentBase64: '!!not-base64!!' }, 'u1'),
    ).rejects.toThrow(InvalidVoucherError)
    expect(files.put).not.toHaveBeenCalled()
  })

  it(`解码后 > ${VOUCHER_MAX_BYTES} 字节（7MB 上限）→ InvalidVoucherError，不写盘`, async () => {
    const prisma = makePrisma({ order: makeOrder({ status: 'PENDING_PAYMENT' }) })
    const files = makeFiles()
    const service = makeService(prisma, undefined, { files })
    const oversized = Buffer.alloc(VOUCHER_MAX_BYTES + 1).toString('base64')

    await expect(
      service.uploadVoucher('o1', { fileName: 'a.pdf', contentBase64: oversized }, 'u1'),
    ).rejects.toThrow(InvalidVoucherError)
    expect(files.put).not.toHaveBeenCalled()
  })

  it('解码后恰 7MB：放行（上限含边界）', async () => {
    const prisma = makePrisma({ order: makeOrder({ status: 'PENDING_PAYMENT' }) })
    const files = makeFiles(['0f1e2d3c4b5a69788776655443322110.png'])
    const service = makeService(prisma, undefined, { files })
    const boundary = Buffer.alloc(VOUCHER_MAX_BYTES).toString('base64')

    await expect(
      service.uploadVoucher('o1', { fileName: 'a.png', contentBase64: boundary }, 'u1'),
    ).resolves.toBeTruthy()
    expect(files.put).toHaveBeenCalled()
  })

  it('订单不存在 → OrderNotFoundError，不写盘', async () => {
    const prisma = makePrisma({ order: null })
    const files = makeFiles()
    const service = makeService(prisma, undefined, { files })

    await expect(
      service.uploadVoucher('o-missing', { fileName: 'a.png', contentBase64: B64_HELLO }, 'u1'),
    ).rejects.toThrow(OrderNotFoundError)
    expect(files.put).not.toHaveBeenCalled()
  })

  it('订单非 PENDING_PAYMENT（如 PAID）→ OrderTransitionError 前置拦截，不写盘不建流水', async () => {
    const prisma = makePrisma({ order: makeOrder({ status: 'PAID' }) })
    const files = makeFiles()
    const service = makeService(prisma, undefined, { files })

    await expect(
      service.uploadVoucher('o1', { fileName: 'a.png', contentBase64: B64_HELLO }, 'u1'),
    ).rejects.toThrow(OrderTransitionError)
    expect(files.put).not.toHaveBeenCalled()
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(prisma.paymentTransaction.create).not.toHaveBeenCalled()
  })

  // ----- 遗留 D6：落库失败后的孤儿回单清理（unlink 尽力而为） -----

  it('遗留 D6：写盘后落库失败（并发改态 updateMany count=0）→ OrderTransitionError + 孤儿回单被清理（remove 收 put 产出的 key）', async () => {
    const prisma = makePrisma({ order: makeOrder({ status: 'PENDING_PAYMENT' }) })
    const files = makeFiles(['0f1e2d3c4b5a69788776655443322110.png'])
    const service = makeService(prisma, undefined, { files })
    // 前置预检通过后事务内乐观并发失闸（并发取消订单等）
    prisma.order.updateMany.mockResolvedValueOnce({ count: 0 })

    await expect(
      service.uploadVoucher('o1', { fileName: 'a.png', contentBase64: B64_HELLO }, 'u1'),
    ).rejects.toThrow(OrderTransitionError)
    expect(files.put).toHaveBeenCalledTimes(1)
    expect(files.remove).toHaveBeenCalledWith('0f1e2d3c4b5a69788776655443322110.png')
    expect(prisma.paymentTransaction.create).not.toHaveBeenCalled()
  })

  it('遗留 D6：清理自身失败（remove 抛 EPERM）仅日志，原 OrderTransitionError 照常上抛不被掩盖', async () => {
    const prisma = makePrisma({ order: makeOrder({ status: 'PENDING_PAYMENT' }) })
    const files = makeFiles(['0f1e2d3c4b5a69788776655443322110.png'])
    ;(files.remove as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }),
    )
    const service = makeService(prisma, undefined, { files })
    prisma.order.updateMany.mockResolvedValueOnce({ count: 0 })

    await expect(
      service.uploadVoucher('o1', { fileName: 'a.png', contentBase64: B64_HELLO }, 'u1'),
    ).rejects.toThrow(OrderTransitionError)
  })

  it('遗留 D6：成功路径不清理（remove 不被调用，文件保留供财务查看）', async () => {
    const prisma = makePrisma({ order: makeOrder({ status: 'PENDING_PAYMENT' }) })
    const files = makeFiles(['0f1e2d3c4b5a69788776655443322110.png'])
    const service = makeService(prisma, undefined, { files })

    await service.uploadVoucher('o1', { fileName: 'a.png', contentBase64: B64_HELLO }, 'u1')

    expect(files.put).toHaveBeenCalledTimes(1)
    expect(files.remove).not.toHaveBeenCalled()
  })

  it('未注入 files → 明确报错（装配缺失应显性失败）', async () => {
    const prisma = makePrisma({ order: makeOrder({ status: 'PENDING_PAYMENT' }) })
    const service = makeService(prisma)

    await expect(
      service.uploadVoucher('o1', { fileName: 'a.png', contentBase64: B64_HELLO }, 'u1'),
    ).rejects.toThrow(/files/)
  })

  it('组合原子性（修复轮）：流水建行抛错 → voucher.upload 迁移同事务整体回滚（不留 PENDING_CONFIRMATION 无流水断链）', async () => {
    const prisma = makePrisma({ order: makeOrder({ status: 'PENDING_PAYMENT' }) })
    const files = makeFiles()
    const boom = new Error('payment create exploded')
    prisma.paymentTransaction.create.mockRejectedValue(boom)
    const service = makeService(prisma, undefined, { files })

    await expect(
      service.uploadVoucher('o1', { fileName: 'a.png', contentBase64: B64_HELLO }, 'u1'),
    ).rejects.toBe(boom)
    // 迁移闸门与流水建行同一 $transaction：恰好一次且被拒绝（回滚语义照任务 3 修复轮模式）
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    // files.put 在事务外先行（孤儿文件可清理，非断链状态）
    expect(files.put).toHaveBeenCalledTimes(1)
  })
})

describe('confirmPayment（财务确认收款，§6.2 payment.confirmed）', () => {
  it('BANK_TRANSFER：transition→PAID + 流水 SUCCEEDED/confirmedById + Order.paidAt/paymentMethod + enqueue order.activate（三件事 + 落库字段）', async () => {
    const prisma = makePrisma({
      order: makeOrder({ id: 'o1', status: 'PENDING_CONFIRMATION', payableCents: 15000 }),
      payment: makePayment({ orderId: 'o1', method: 'BANK_TRANSFER', status: 'PENDING', amountCents: 15000, order: makeOrder({ id: 'o1', status: 'PENDING_CONFIRMATION', organizationId: 'org-1' }) }),
    })
    const boss = makeBoss()
    const service = makeService(prisma, undefined, { boss })

    const result = await service.confirmPayment('pay-1', 'finance-1')

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', status: { in: ['PENDING_PAYMENT', 'PENDING_CONFIRMATION'] } },
      data: { status: 'PAID' },
    })
    expect(prisma.orderEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        event: 'payment.confirmed',
        fromStatus: 'PENDING_CONFIRMATION',
        toStatus: 'PAID',
        actorId: 'finance-1',
      }),
    })
    expect(prisma.paymentTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'pay-1', status: 'PENDING' },
      data: { status: 'SUCCEEDED', confirmedById: 'finance-1' },
    })
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { paidAt: FIXED_NOW(), paymentMethod: 'BANK_TRANSFER' },
    })
    // 投递 order.activate：createQueue 幂等 + send { orderId }，且在事务提交之后
    expect(boss.createQueue).toHaveBeenCalledWith('order.activate')
    expect(boss.send).toHaveBeenCalledWith('order.activate', { orderId: 'o1' }, ORDER_ACTIVATION_SEND_OPTIONS)
    // BANK_TRANSFER 分支不触碰 workspace 恢复
    expect(prisma.workspace.updateMany).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      orderId: 'o1',
      organizationId: 'org-1',
      paymentMethod: 'BANK_TRANSFER',
      resumedWorkspaces: 0,
    })
    expect(result.event).toMatchObject({ event: 'payment.confirmed', toStatus: 'PAID' })
    expect(result.payment).toMatchObject({ status: 'SUCCEEDED', confirmedById: 'finance-1' })
  })

  it('CONTRACT_CREDIT（应收确认）：只置流水 SUCCEEDED + paidAt，不迁移不投递；恢复"账期超期"暂停的 workspace（Ruling 4）', async () => {
    const prisma = makePrisma({
      order: makeOrder({ id: 'o1', status: 'FULFILLING', organizationId: 'org-9' }),
      payment: makePayment({ orderId: 'o1', method: 'CONTRACT_CREDIT', status: 'PENDING', order: makeOrder({ id: 'o1', status: 'FULFILLING', organizationId: 'org-9' }) }),
      resumeCount: 2,
    })
    const boss = makeBoss()
    const service = makeService(prisma, undefined, { boss })

    const result = await service.confirmPayment('pay-1', 'finance-1')

    // 不迁移、不投递（订单已 FULFILLING，§6.2）
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(boss.send).not.toHaveBeenCalled()
    expect(prisma.orderEvent.create).not.toHaveBeenCalled()
    // 只置流水 + paidAt（流水条件更新，PENDING 闸）
    expect(prisma.paymentTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'pay-1', status: 'PENDING' },
      data: { status: 'SUCCEEDED', confirmedById: 'finance-1' },
    })
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { paidAt: FIXED_NOW() },
    })
    // 恢复：该 org 下 SUSPENDED + suspendReason='账期超期' → ACTIVE/null
    expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-9', status: 'SUSPENDED', suspendReason: '账期超期' },
      data: { status: 'ACTIVE', suspendReason: null },
    })
    expect(result.resumedWorkspaces).toBe(2)
    expect(result.event).toBeNull()
    expect(result).toMatchObject({ orderId: 'o1', organizationId: 'org-9', paymentMethod: 'CONTRACT_CREDIT' })
  })

  it('CONTRACT_CREDIT：无可恢复 workspace（count=0）→ resumedWorkspaces=0，updateMany 仍按条件执行', async () => {
    const prisma = makePrisma({
      payment: makePayment({ method: 'CONTRACT_CREDIT', order: makeOrder({ status: 'FULFILLING' }) }),
      resumeCount: 0,
    })
    const service = makeService(prisma, undefined, { boss: makeBoss() })

    const result = await service.confirmPayment('pay-1', 'finance-1')

    expect(prisma.workspace.updateMany).toHaveBeenCalledTimes(1)
    expect(result.resumedWorkspaces).toBe(0)
  })

  it('流水不存在 → PaymentNotFoundError', async () => {
    const prisma = makePrisma({ payment: null })
    const service = makeService(prisma, undefined, { boss: makeBoss() })

    await expect(service.confirmPayment('pay-x', 'finance-1')).rejects.toThrow(PaymentNotFoundError)
    expect(prisma.paymentTransaction.updateMany).not.toHaveBeenCalled()
  })

  it('流水非 PENDING（已 SUCCEEDED 重复确认）→ PaymentStateError，不触任何写', async () => {
    const prisma = makePrisma({
      payment: makePayment({ status: 'SUCCEEDED', order: makeOrder({ status: 'PAID' }) }),
    })
    const service = makeService(prisma, undefined, { boss: makeBoss() })

    await expect(service.confirmPayment('pay-1', 'finance-1')).rejects.toThrow(PaymentStateError)
    expect(prisma.paymentTransaction.updateMany).not.toHaveBeenCalled()
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
  })

  it('线上通道流水（WECHAT/ALIPAY）→ PaymentStateError（本任务只覆盖线下收款）', async () => {
    const prisma = makePrisma({
      payment: makePayment({ method: 'WECHAT', order: makeOrder({ status: 'PENDING_CONFIRMATION' }) }),
    })
    const service = makeService(prisma, undefined, { boss: makeBoss() })

    await expect(service.confirmPayment('pay-1', 'finance-1')).rejects.toThrow(PaymentStateError)
  })

  it('BANK_TRANSFER 未注入 boss → 投递步骤显性报错', async () => {
    const prisma = makePrisma({
      order: makeOrder({ status: 'PENDING_CONFIRMATION' }),
      payment: makePayment({ order: makeOrder({ id: 'o1', status: 'PENDING_CONFIRMATION' }) }),
    })
    const service = makeService(prisma)

    await expect(service.confirmPayment('pay-1', 'finance-1')).rejects.toThrow(/boss/)
  })

  it('竞态（修复轮）：confirm 时流水已被并发置 FAILED（条件更新 count=0）→ PaymentStateError 且整体回滚（paidAt/paymentMethod 未落、事件/迁移回滚、不投递）', async () => {
    const prisma = makePrisma({
      order: makeOrder({ id: 'o1', status: 'PENDING_CONFIRMATION' }),
      payment: makePayment({
        orderId: 'o1',
        status: 'PENDING',
        order: makeOrder({ id: 'o1', status: 'PENDING_CONFIRMATION' }),
      }),
    })
    // 预检读到 PENDING，事务内条件更新命中 0 行（另一请求已置 FAILED）→ 闸门拒
    prisma.paymentTransaction.updateMany.mockResolvedValue({ count: 0 })
    const boss = makeBoss()
    const service = makeService(prisma, undefined, { boss })

    await expect(service.confirmPayment('pay-1', 'finance-1')).rejects.toThrow(PaymentStateError)
    // 流水闸门在 order.update 之前：paidAt/paymentMethod 未触达（订单保持 PENDING_CONFIRMATION）
    expect(prisma.order.update).not.toHaveBeenCalled()
    // 投递在事务提交之后：事务回滚即不投递
    expect(boss.send).not.toHaveBeenCalled()
    // 迁移 + 流水同一 $transaction：整体恰好一次且被拒绝
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
  })

  it('组合原子性（修复轮）：事务内流水条件更新抛错 → 整体拒绝（迁移/事件/订单字段同事务回滚），不投递', async () => {
    const prisma = makePrisma({
      order: makeOrder({ id: 'o1', status: 'PENDING_CONFIRMATION' }),
      payment: makePayment({
        orderId: 'o1',
        status: 'PENDING',
        order: makeOrder({ id: 'o1', status: 'PENDING_CONFIRMATION' }),
      }),
    })
    const boom = new Error('payment updateMany exploded')
    prisma.paymentTransaction.updateMany.mockRejectedValue(boom)
    const boss = makeBoss()
    const service = makeService(prisma, undefined, { boss })

    await expect(service.confirmPayment('pay-1', 'finance-1')).rejects.toBe(boom)
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(prisma.order.update).not.toHaveBeenCalled()
    expect(boss.send).not.toHaveBeenCalled()
  })

  it('竞态（修复轮，应收确认）：流水已被并发处理（count=0）→ PaymentStateError，paidAt 与 workspace 恢复均未触达', async () => {
    const prisma = makePrisma({
      payment: makePayment({
        method: 'CONTRACT_CREDIT',
        status: 'PENDING',
        order: makeOrder({ id: 'o1', status: 'FULFILLING' }),
      }),
    })
    prisma.paymentTransaction.updateMany.mockResolvedValue({ count: 0 })
    const service = makeService(prisma, undefined, { boss: makeBoss() })

    await expect(service.confirmPayment('pay-1', 'finance-1')).rejects.toThrow(PaymentStateError)
    expect(prisma.order.update).not.toHaveBeenCalled()
    expect(prisma.workspace.updateMany).not.toHaveBeenCalled()
  })
})

describe('rejectVoucher（财务驳回回单，§6.2 finance.reject）', () => {
  it('成功：transition PENDING_CONFIRMATION→PENDING_PAYMENT + 流水 FAILED + rawPayload.reason', async () => {
    const prisma = makePrisma({
      order: makeOrder({ id: 'o1', status: 'PENDING_CONFIRMATION' }),
      payment: makePayment({ orderId: 'o1', method: 'BANK_TRANSFER', status: 'PENDING', order: makeOrder({ id: 'o1', status: 'PENDING_CONFIRMATION', organizationId: 'org-1' }) }),
    })
    const service = makeService(prisma)

    const result = await service.rejectVoucher('pay-1', '回单模糊，请重新上传', 'finance-1')

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', status: { in: ['PENDING_CONFIRMATION'] } },
      data: { status: 'PENDING_PAYMENT' },
    })
    expect(prisma.orderEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        event: 'finance.reject',
        fromStatus: 'PENDING_CONFIRMATION',
        toStatus: 'PENDING_PAYMENT',
        actorId: 'finance-1',
        note: '回单模糊，请重新上传',
      }),
    })
    expect(prisma.paymentTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'pay-1', status: 'PENDING' },
      data: { status: 'FAILED', rawPayload: { reason: '回单模糊，请重新上传' } },
    })
    expect(result.event).toMatchObject({ event: 'finance.reject', toStatus: 'PENDING_PAYMENT' })
    expect(result.payment).toMatchObject({ status: 'FAILED' })
    expect(result).toMatchObject({ orderId: 'o1', organizationId: 'org-1' })
  })

  it('流水不存在 → PaymentNotFoundError', async () => {
    const prisma = makePrisma({ payment: null })
    const service = makeService(prisma)

    await expect(service.rejectVoucher('pay-x', 'x', 'finance-1')).rejects.toThrow(PaymentNotFoundError)
  })

  it('流水非 PENDING → PaymentStateError，不迁移', async () => {
    const prisma = makePrisma({
      payment: makePayment({ status: 'FAILED', order: makeOrder({ status: 'PENDING_PAYMENT' }) }),
    })
    const service = makeService(prisma)

    await expect(service.rejectVoucher('pay-1', 'x', 'finance-1')).rejects.toThrow(PaymentStateError)
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
  })

  it('竞态（修复轮）：驳回时流水已被并发确认（条件更新 count=0）→ PaymentStateError，finance.reject 迁移同事务回滚', async () => {
    const prisma = makePrisma({
      order: makeOrder({ id: 'o1', status: 'PENDING_CONFIRMATION' }),
      payment: makePayment({
        orderId: 'o1',
        status: 'PENDING',
        order: makeOrder({ id: 'o1', status: 'PENDING_CONFIRMATION' }),
      }),
    })
    prisma.paymentTransaction.updateMany.mockResolvedValue({ count: 0 })
    const service = makeService(prisma)

    await expect(service.rejectVoucher('pay-1', 'x', 'finance-1')).rejects.toThrow(PaymentStateError)
    // 迁移与流水同事务：流水闸门拒 → 整体一次 $transaction 被拒绝（订单留在 PENDING_CONFIRMATION）
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
  })
})

describe('openOnCredit（合同账期开通，§6.2 credit.open）', () => {
  it('成功：transition→FULFILLING + Order.paymentMethod/dueAt(now+dueDays) + 应收流水 CONTRACT_CREDIT/PENDING + enqueue order.activate（先开通）', async () => {
    const prisma = makePrisma({
      order: makeOrder({ id: 'o1', status: 'PENDING_PAYMENT', payableCents: 12000 }),
    })
    const boss = makeBoss()
    const service = makeService(prisma, undefined, { boss })

    const result = await service.openOnCredit('o1', { dueDays: 30 }, 'admin-1')

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', status: { in: ['PENDING_PAYMENT'] } },
      data: { status: 'FULFILLING' },
    })
    expect(prisma.orderEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        event: 'credit.open',
        fromStatus: 'PENDING_PAYMENT',
        toStatus: 'FULFILLING',
        actorId: 'admin-1',
      }),
    })
    // dueAt = 固定时钟 + 30 天（2026-11-14T12:00:00.000Z）
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: {
        paymentMethod: 'CONTRACT_CREDIT',
        dueAt: new Date('2026-11-14T12:00:00.000Z'),
      },
    })
    expect(prisma.paymentTransaction.create).toHaveBeenCalledWith({
      data: {
        orderId: 'o1',
        method: 'CONTRACT_CREDIT',
        status: 'PENDING',
        amountCents: 12000,
        currency: 'CNY',
      },
    })
    expect(boss.createQueue).toHaveBeenCalledWith('order.activate')
    expect(boss.send).toHaveBeenCalledWith('order.activate', { orderId: 'o1' }, ORDER_ACTIVATION_SEND_OPTIONS)
    expect(result).toMatchObject({
      orderId: 'o1',
      organizationId: 'org-1',
      payableCents: 12000,
    })
    expect(result.dueAt).toEqual(new Date('2026-11-14T12:00:00.000Z'))
    expect(result.payment).toMatchObject({ method: 'CONTRACT_CREDIT', status: 'PENDING' })
  })

  it('dueDays=1：dueAt 恰为次日', async () => {
    const prisma = makePrisma({ order: makeOrder({ status: 'PENDING_PAYMENT' }) })
    const service = makeService(prisma, undefined, { boss: makeBoss() })

    const result = await service.openOnCredit('o1', { dueDays: 1 }, 'admin-1')

    expect(result.dueAt).toEqual(new Date('2026-10-16T12:00:00.000Z'))
  })

  it.each([0, -5, 1.5])('dueDays=%s 非法 → InvalidDueDaysError，不触库', async (dueDays) => {
    const prisma = makePrisma({ order: makeOrder({ status: 'PENDING_PAYMENT' }) })
    const service = makeService(prisma, undefined, { boss: makeBoss() })

    await expect(service.openOnCredit('o1', { dueDays }, 'admin-1')).rejects.toThrow(InvalidDueDaysError)
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(prisma.paymentTransaction.create).not.toHaveBeenCalled()
  })

  it('遗留 B2：dueDays=3651 超上限 → InvalidDueDaysError（service 层第二道闸），不触库不投递', async () => {
    const prisma = makePrisma({ order: makeOrder({ status: 'PENDING_PAYMENT' }) })
    const boss = makeBoss()
    const service = makeService(prisma, undefined, { boss })

    await expect(service.openOnCredit('o1', { dueDays: 3651 }, 'admin-1')).rejects.toThrow(
      InvalidDueDaysError,
    )
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(prisma.paymentTransaction.create).not.toHaveBeenCalled()
    expect(boss.send).not.toHaveBeenCalled()
  })

  it('遗留 B2：dueDays=3650 恰为上限边界 → 放行（含边界）', async () => {
    const prisma = makePrisma({ order: makeOrder({ status: 'PENDING_PAYMENT' }) })
    const service = makeService(prisma, undefined, { boss: makeBoss() })

    const result = await service.openOnCredit('o1', { dueDays: 3650 }, 'admin-1')

    // dueAt = 固定时钟 + 3650 天 = 2036-10-12T12:00:00.000Z
    expect(result.dueAt).toEqual(new Date('2036-10-12T12:00:00.000Z'))
  })

  it('订单不存在 → OrderNotFoundError', async () => {
    const prisma = makePrisma({ order: null })
    const service = makeService(prisma, undefined, { boss: makeBoss() })

    await expect(service.openOnCredit('o-missing', { dueDays: 30 }, 'admin-1')).rejects.toThrow(OrderNotFoundError)
  })

  it('订单非 PENDING_PAYMENT → OrderTransitionError 前置拦截，不建流水不投递', async () => {
    const prisma = makePrisma({ order: makeOrder({ status: 'PAID' }) })
    const boss = makeBoss()
    const service = makeService(prisma, undefined, { boss })

    await expect(service.openOnCredit('o1', { dueDays: 30 }, 'admin-1')).rejects.toThrow(OrderTransitionError)
    expect(prisma.paymentTransaction.create).not.toHaveBeenCalled()
    expect(boss.send).not.toHaveBeenCalled()
  })

  it('未注入 boss → 投递步骤显性报错', async () => {
    const prisma = makePrisma({ order: makeOrder({ status: 'PENDING_PAYMENT' }) })
    const service = makeService(prisma)

    await expect(service.openOnCredit('o1', { dueDays: 30 }, 'admin-1')).rejects.toThrow(/boss/)
  })

  it('组合原子性（修复轮）：应收流水建行抛错 → credit.open 迁移/账期字段同事务整体回滚，不投递', async () => {
    const prisma = makePrisma({ order: makeOrder({ status: 'PENDING_PAYMENT' }) })
    prisma.paymentTransaction.create.mockRejectedValue(new Error('payment create exploded'))
    const boss = makeBoss()
    const service = makeService(prisma, undefined, { boss })

    await expect(service.openOnCredit('o1', { dueDays: 30 }, 'admin-1')).rejects.toThrow(
      'payment create exploded',
    )
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(boss.send).not.toHaveBeenCalled()
  })
})

describe('enqueueOrderActivation（pg-boss 投递 helper）', () => {
  it("createQueue('order.activate') 幂等建队 + send 带 retryLimit=5/retryDelay=30（任务 8 修复：v10 默认不重试）", async () => {
    const boss = makeBoss()

    await enqueueOrderActivation(boss, 'o1')

    expect(boss.createQueue).toHaveBeenCalledTimes(1)
    expect(boss.createQueue).toHaveBeenCalledWith('order.activate')
    expect(boss.send).toHaveBeenCalledTimes(1)
    expect(boss.send).toHaveBeenCalledWith('order.activate', { orderId: 'o1' }, ORDER_ACTIVATION_SEND_OPTIONS)
    expect(ORDER_ACTIVATION_SEND_OPTIONS).toEqual({ retryLimit: 5, retryDelay: 30 })
  })
})
