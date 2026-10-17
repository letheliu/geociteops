import { describe, expect, it, vi } from 'vitest'
import {
  CallbackSignatureError,
  createChannelRegistry,
  createMockChannel,
  MissingMockSecretError,
  resolveChannel,
} from './channel.js'
import type { MockChannel } from './channel.js'
import {
  CallbackAmountMismatchError,
  handlePaymentCallback,
  mapWebhookError,
  reconcilePendingPayments,
  RECONCILE_BATCH_LIMIT,
} from './webhook.js'
import {
  createOrderService,
  ORDER_ACTIVATION_SEND_OPTIONS,
  OrderNotFoundError,
  OrderTransitionError,
  PaymentNotFoundError,
  PaymentStateError,
} from '../order-service.js'
import type { FilesService } from '../files.js'

/**
 * 任务 6：PaymentChannel 接口（微信/支付宝 mock）+ handlePaymentCallback 四步
 * （验签 → channelTxnNo 幂等 → 金额校验 → 置成功/迁移/回填/投递原子单元）+
 * mapWebhookError 映射 + reconcilePendingPayments 每日对账 + orders.createPayment 服务逻辑。
 *
 * 模式照 order-service/order-router 测试：mock prisma（有状态，支持幂等二连调）+
 * 真实 OrderService（注入 mock 渠道工厂）+ mock boss。
 */

const NOW = new Date('2026-10-15T08:00:00.000Z')

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

function makePayment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pay-1',
    orderId: 'order-1',
    method: 'WECHAT' as const,
    amountCents: 15000,
    currency: 'CNY',
    status: 'PENDING' as const,
    channelTxnNo: null,
    channelOrderNo: null,
    voucherFileKey: null,
    confirmedById: null,
    rawPayload: null,
    createdAt: NOW,
    ...overrides,
  }
}

function makeFiles(): FilesService {
  return { put: vi.fn(async () => 'f1e2d3c4b5a6978877665544332211ff.png'), resolvePath: vi.fn() }
}

function makeBoss() {
  return {
    createQueue: vi.fn(async () => ({})),
    send: vi.fn(async () => ({})),
  }
}

/**
 * 有状态 mock prisma：findUnique 按唯一键分派（channelTxnNo / channelOrderNo / id），
 * 条件 updateMany 真应用（id + status 匹配才写），$transaction 抛错时快照回滚——
 * 回调幂等"第二次预查命中 SUCCEEDED"与竞态用例依赖状态迁移的真实性。
 */
function makeStatefulPrisma(init: { orders?: any[]; payments?: any[] } = {}) {
  const orders: any[] = init.orders ?? [makeOrder()]
  const payments: any[] = init.payments ?? []
  let evtSeq = 0
  let paySeq = 0

  const findPaymentBy = (where: Record<string, unknown>) => {
    if (where.id !== undefined) return payments.find((p) => p.id === where.id) ?? null
    if (where.channelTxnNo !== undefined) {
      return payments.find((p) => p.channelTxnNo === where.channelTxnNo) ?? null
    }
    if (where.channelOrderNo !== undefined) {
      return payments.find((p) => p.channelOrderNo === where.channelOrderNo) ?? null
    }
    return null
  }

  const prisma: any = {
    order: {
      // 返回行副本（真实驱动每次查询返回新对象）：runTransition 预检快照不应看到事务内变更
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          structuredClone(orders.find((o) => o.id === where.id) ?? null),
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: any; data: Record<string, unknown> }) => {
          let count = 0
          for (const o of orders) {
            if (o.id === where.id && where.status?.in?.includes(o.status)) {
              Object.assign(o, data)
              count++
            }
          }
          return { count }
        },
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: any }) => {
        const o = orders.find((x) => x.id === where.id)
        if (o) Object.assign(o, data)
        return { ...o }
      }),
    },
    orderEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: `evt-${++evtSeq}`,
        createdAt: NOW,
        ...data,
      })),
    },
    paymentTransaction: {
      findUnique: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          structuredClone(findPaymentBy(where)),
      ),
      findMany: vi.fn(async ({ where, take }: { where: any; take?: number }) =>
        payments
          .filter(
            (p) =>
              (!where?.status || p.status === where.status) &&
              (!where?.method?.in || where.method.in.includes(p.method)),
          )
          .slice(0, take ?? Number.POSITIVE_INFINITY)
          .map((p) => ({ ...p })),
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: any; data: Record<string, unknown> }) => {
          let count = 0
          for (const p of payments) {
            if (p.id === where.id && p.status === where.status) {
              Object.assign(p, data)
              count++
            }
          }
          return { count }
        },
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `pay-${++paySeq}`, createdAt: NOW, ...data }
        payments.push(row)
        return row
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = structuredClone({ orders, payments })
      try {
        return await fn(prisma)
      } catch (err) {
        orders.length = 0
        orders.push(...snapshot.orders)
        payments.length = 0
        payments.push(...snapshot.payments)
        throw err
      }
    }),
  }
  return { prisma, orders, payments }
}

/** 真实 OrderService（mock prisma + mock boss + 注入 mock 渠道） */
function buildService(prisma: any, boss: ReturnType<typeof makeBoss>, channel: MockChannel) {
  return createOrderService({
    prisma,
    now: () => NOW,
    files: makeFiles(),
    boss,
    channelFactory: () => channel,
  })
}

/** 标准场景组装：本企业 PENDING_PAYMENT 订单 + WECHAT mock 渠道 + 已发起的线上支付 */
async function setupPaidFlow(secret = 'test-secret') {
  const channel = createMockChannel({ method: 'WECHAT', secret })
  const boss = makeBoss()
  const { prisma, orders, payments } = makeStatefulPrisma()
  const service = buildService(prisma, boss, channel)
  const created = await service.createPayment('order-1', 'WECHAT')
  const callback = channel.buildCallback({
    channelOrderNo: created.channelOrderNo,
    channelTxnNo: 'mock-txn-0001',
  })
  return { channel, boss, prisma, orders, payments, service, created, callback }
}

// ---------------------------------------------------------------------------
// createMockChannel：渠道接口契约
// ---------------------------------------------------------------------------

describe('createMockChannel：PaymentChannel 接口（mock 实现）', () => {
  it('createPayment：返回 mock- 前缀单号与 https://mock.pay/qr/{no} 二维码地址', async () => {
    const channel = createMockChannel({ method: 'ALIPAY' })
    const result = await channel.createPayment({
      orderId: 'order-1',
      orderNo: 'GEO261015ab12cd34',
      amountCents: 15000,
    })
    expect(result.channelOrderNo).toMatch(/^mock-[0-9a-f-]{36}$/)
    expect(result.payUrl).toBe(`https://mock.pay/qr/${result.channelOrderNo}`)
    expect(channel.method).toBe('ALIPAY')
  })

  it('createPayment 幂等语义：每次下单生成新单号（同订单可重复发起）', async () => {
    const channel = createMockChannel({ method: 'WECHAT' })
    const a = await channel.createPayment({ orderId: 'o', orderNo: 'no', amountCents: 1 })
    const b = await channel.createPayment({ orderId: 'o', orderNo: 'no', amountCents: 1 })
    expect(a.channelOrderNo).not.toBe(b.channelOrderNo)
  })

  it('verifyCallback：合法签名（sha256(rawBody+secret)）通过并提取回调字段', async () => {
    const channel = createMockChannel({ method: 'WECHAT', secret: 'test-secret' })
    const created = await channel.createPayment({
      orderId: 'order-1',
      orderNo: 'GEO261015ab12cd34',
      amountCents: 15000,
    })
    const { rawBody, headers } = channel.buildCallback({
      channelOrderNo: created.channelOrderNo,
      channelTxnNo: 'txn-1',
    })

    const cb = await channel.verifyCallback(rawBody, headers)

    expect(cb).toEqual({
      channelTxnNo: 'txn-1',
      channelOrderNo: created.channelOrderNo,
      orderNo: 'GEO261015ab12cd34',
      amountCents: 15000,
      status: 'SUCCESS',
    })
  })

  it('verifyCallback：签名不符（篡改 body / 错误 secret / 缺头）→ CallbackSignatureError', async () => {
    const channel = createMockChannel({ method: 'WECHAT', secret: 'test-secret' })
    const created = await channel.createPayment({
      orderId: 'order-1',
      orderNo: 'GEO261015ab12cd34',
      amountCents: 15000,
    })
    const { rawBody, headers } = channel.buildCallback({
      channelOrderNo: created.channelOrderNo,
      channelTxnNo: 'txn-1',
    })

    // 篡改 body（签名与 body 不再一致）
    const tampered = JSON.stringify({ ...JSON.parse(rawBody), amountCents: 1 })
    await expect(channel.verifyCallback(tampered, headers)).rejects.toThrow(
      CallbackSignatureError,
    )
    // 缺签名头
    await expect(channel.verifyCallback(rawBody, {})).rejects.toThrow(CallbackSignatureError)
    // 错误 secret 的渠道验签
    const other = createMockChannel({ method: 'WECHAT', secret: 'wrong' })
    await expect(other.verifyCallback(rawBody, headers)).rejects.toThrow(CallbackSignatureError)
  })

  it('queryOrder：未支付（settlePredicate=false）→ PENDING 无交易号；已支付（true）→ SUCCESS 带交易号', async () => {
    let settled = false
    const channel = createMockChannel({
      method: 'WECHAT',
      settlePredicate: () => settled,
    })
    const created = await channel.createPayment({
      orderId: 'order-1',
      orderNo: 'GEO261015ab12cd34',
      amountCents: 15000,
    })

    expect(await channel.queryOrder(created.channelOrderNo)).toEqual({ status: 'PENDING' })

    settled = true
    const queried = await channel.queryOrder(created.channelOrderNo)
    expect(queried.status).toBe('SUCCESS')
    expect(queried.channelTxnNo).toBeTruthy()
  })

  it('queryOrder：渠道注册表查无此单 → 抛错（对账按行捕获计失败）', async () => {
    const channel = createMockChannel({ method: 'WECHAT' })
    await expect(channel.queryOrder('mock-unknown')).rejects.toThrow(/查无此单/)
  })

  it('refund：返回 mock-rf- 前缀退款单号与 EXECUTED', async () => {
    const channel = createMockChannel({ method: 'ALIPAY' })
    const result = await channel.refund({ channelOrderNo: 'mock-x', amountCents: 100 })
    expect(result.channelRefundNo).toMatch(/^mock-rf-/)
    expect(result.status).toBe('EXECUTED')
  })

  it('settle()：标记渠道侧已支付——queryOrder 翻为 SUCCESS（dev/测试结算驱动）', async () => {
    const channel = createMockChannel({ method: 'WECHAT' }) // settlePredicate 缺省 false
    const created = await channel.createPayment({
      orderId: 'o',
      orderNo: 'no',
      amountCents: 100,
    })
    expect(await channel.queryOrder(created.channelOrderNo)).toEqual({ status: 'PENDING' })
    channel.settle(created.channelOrderNo)
    await expect(channel.queryOrder(created.channelOrderNo)).resolves.toMatchObject({
      status: 'SUCCESS',
    })
  })
})

// ---------------------------------------------------------------------------
// resolveChannel 工厂（fail-closed：缺 PAY_MOCK_SECRET 拒绝装配）
// ---------------------------------------------------------------------------

describe('resolveChannel（env 工厂，P2 mock 先行）', () => {
  it('WECHAT / ALIPAY → mock 渠道（method 回填；secret 取 env PAY_MOCK_SECRET）', () => {
    expect(resolveChannel('WECHAT', { PAY_MOCK_SECRET: 's' }).method).toBe('WECHAT')
    expect(resolveChannel('ALIPAY', { PAY_MOCK_SECRET: 's' }).method).toBe('ALIPAY')
  })

  it('缺 PAY_MOCK_SECRET → MissingMockSecretError fail-closed（默认密钥源码公开，静默回落=可伪造签名免付置 PAID）', () => {
    expect(() => resolveChannel('WECHAT', {})).toThrow(MissingMockSecretError)
    expect(() => resolveChannel('ALIPAY', {})).toThrow(/PAY_MOCK_SECRET/)
  })

  it('PAY_MOCK_SECRET 透传：按 env secret 验签成立', async () => {
    const resolved = resolveChannel('WECHAT', { PAY_MOCK_SECRET: 'env-secret' })
    // 同 secret 的 mock 渠道生成回调（verifyCallback 不查注册表，只验签+提取字段）
    const signer = createMockChannel({ method: 'WECHAT', secret: 'env-secret' })
    const created = await signer.createPayment({
      orderId: 'o',
      orderNo: 'no',
      amountCents: 100,
    })
    const cb = signer.buildCallback({
      channelOrderNo: created.channelOrderNo,
      channelTxnNo: 'txn-env',
    })
    await expect(resolved.verifyCallback(cb.rawBody, cb.headers)).resolves.toMatchObject({
      channelTxnNo: 'txn-env',
    })
  })

  it('线下通道（BANK_TRANSFER/CONTRACT_CREDIT）→ 显性报错（仅 WECHAT/ALIPAY 走线上）', () => {
    expect(() => resolveChannel('BANK_TRANSFER', { PAY_MOCK_SECRET: 's' })).toThrow(/WECHAT/)
    expect(() => resolveChannel('CONTRACT_CREDIT', { PAY_MOCK_SECRET: 's' })).toThrow(/WECHAT/)
  })
})

// ---------------------------------------------------------------------------
// createChannelRegistry：装配级渠道注册表（审查 Minor-5 修复——逐调用新实例互不可见）
// ---------------------------------------------------------------------------

describe('createChannelRegistry（装配级单例）', () => {
  it('同一 method 记忆单例（多次解析同一实例）；不同 method 各自实例', () => {
    const channelFor = createChannelRegistry({ PAY_MOCK_SECRET: 's' })
    const wechat = channelFor('WECHAT')
    expect(channelFor('WECHAT')).toBe(wechat)
    expect(channelFor('ALIPAY')).not.toBe(wechat)
  })

  it('缺 PAY_MOCK_SECRET → 解析即 MissingMockSecretError（fail-closed）', () => {
    const channelFor = createChannelRegistry({})
    expect(() => channelFor('WECHAT')).toThrow(MissingMockSecretError)
  })

  it('跨调用点注册表可见（端到端）：service.createPayment 注册 → settle 客户付款 → reconcile 次日查单补单可达', async () => {
    const channelFor = createChannelRegistry({ PAY_MOCK_SECRET: 'assembly-secret' })
    const boss = makeBoss()
    const { prisma, orders } = makeStatefulPrisma()
    // 装配态：service/webhook/reconcile 共用同一 channelFor（照 server.ts）
    const service = createOrderService({
      prisma,
      now: () => NOW,
      files: makeFiles(),
      boss,
      channelFactory: channelFor,
    })
    const created = await service.createPayment('order-1', 'WECHAT')

    // 客户在"渠道侧"完成支付（dev/测试驱动 mock 结算；逐调用新实例下此状态对 reconcile 不可见）
    ;(channelFor('WECHAT') as MockChannel).settle(created.channelOrderNo)

    const result = await reconcilePendingPayments({ prisma, orders: service, channelFor })

    expect(result).toMatchObject({ scanned: 1, confirmed: 1, duplicates: 0, failed: 0 })
    expect(orders[0]).toMatchObject({ status: 'PAID', paymentMethod: 'WECHAT', paidAt: NOW })
    expect(boss.send).toHaveBeenCalledWith('order.activate', { orderId: 'order-1' }, ORDER_ACTIVATION_SEND_OPTIONS)
  })
})

// ---------------------------------------------------------------------------
// orderService.createPayment（线上支付发起，任务 6）
// ---------------------------------------------------------------------------

describe('orderService.createPayment（线上支付发起）', () => {
  it('成功：渠道下单（orderId/orderNo/payableCents）+ 建 method/PENDING 流水（channelOrderNo 回填）→ 返回 { payUrl, channelOrderNo }', async () => {
    const channel = createMockChannel({ method: 'WECHAT' })
    const { prisma } = makeStatefulPrisma()
    const service = buildService(prisma, makeBoss(), channel)

    const result = await service.createPayment('order-1', 'WECHAT')

    expect(prisma.paymentTransaction.create).toHaveBeenCalledWith({
      data: {
        orderId: 'order-1',
        method: 'WECHAT',
        status: 'PENDING',
        amountCents: 15000,
        currency: 'CNY',
        channelOrderNo: result.channelOrderNo,
      },
    })
    expect(result.payUrl).toBe(`https://mock.pay/qr/${result.channelOrderNo}`)
  })

  it('订单不存在 → OrderNotFoundError，不触渠道不建流水', async () => {
    const channel = createMockChannel({ method: 'WECHAT' })
    const { prisma } = makeStatefulPrisma({ orders: [] })
    const service = buildService(prisma, makeBoss(), channel)

    await expect(service.createPayment('order-x', 'WECHAT')).rejects.toThrow(OrderNotFoundError)
    expect(prisma.paymentTransaction.create).not.toHaveBeenCalled()
  })

  it('订单非 PENDING_PAYMENT（如 PAID/CANCELLED）→ PaymentStateError，不建流水', async () => {
    const channel = createMockChannel({ method: 'WECHAT' })
    const { prisma } = makeStatefulPrisma({ orders: [makeOrder({ status: 'CANCELLED' })] })
    const service = buildService(prisma, makeBoss(), channel)

    await expect(service.createPayment('order-1', 'WECHAT')).rejects.toThrow(PaymentStateError)
    expect(prisma.paymentTransaction.create).not.toHaveBeenCalled()
  })

  it('线下通道（BANK_TRANSFER）→ PaymentStateError（程序性双闸，路由 zod 已挡）', async () => {
    const channel = createMockChannel({ method: 'WECHAT' })
    const { prisma } = makeStatefulPrisma()
    const service = buildService(prisma, makeBoss(), channel)

    await expect(service.createPayment('order-1', 'BANK_TRANSFER' as any)).rejects.toThrow(
      PaymentStateError,
    )
  })

  it('重复 createPayment：允许（幂等语义=每次新单），两行 PENDING 各持不同 channelOrderNo', async () => {
    const channel = createMockChannel({ method: 'WECHAT' })
    const { prisma, payments } = makeStatefulPrisma()
    const service = buildService(prisma, makeBoss(), channel)

    const first = await service.createPayment('order-1', 'WECHAT')
    const second = await service.createPayment('order-1', 'WECHAT')

    expect(first.channelOrderNo).not.toBe(second.channelOrderNo)
    expect(payments).toHaveLength(2)
    expect(payments.every((p: any) => p.status === 'PENDING')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// handlePaymentCallback：四步（验签 / 幂等 / 金额 / 原子置成功）
// ---------------------------------------------------------------------------

describe('handlePaymentCallback：成功路径（步骤 4 四笔写 + 投递恰一次）', () => {
  it('置流水 SUCCEEDED（channelTxnNo/channelOrderNo 回填）+ payment.confirmed 迁移 + Order.paymentMethod/paidAt 回填 + enqueue 恰一次', async () => {
    const { channel, boss, prisma, orders, payments, service, callback } = await setupPaidFlow()

    const result = await handlePaymentCallback(channel, callback.rawBody, callback.headers, {
      prisma,
      orders: service,
    })

    expect(result).toEqual({ duplicate: false })
    // 流水：SUCCEEDED + 渠道双号回填
    expect(payments[0]).toMatchObject({
      status: 'SUCCEEDED',
      channelTxnNo: 'mock-txn-0001',
      method: 'WECHAT',
    })
    // 订单：PAID + paymentMethod=WECHAT + paidAt
    expect(orders[0]).toMatchObject({
      status: 'PAID',
      paymentMethod: 'WECHAT',
      paidAt: NOW,
    })
    // 迁移事件：payment.confirmed，PENDING_PAYMENT → PAID
    expect(prisma.orderEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-1',
        event: 'payment.confirmed',
        fromStatus: 'PENDING_PAYMENT',
        toStatus: 'PAID',
      }),
    })
    // 投递恰一次（事务提交之后）
    expect(boss.send).toHaveBeenCalledTimes(1)
    expect(boss.send).toHaveBeenCalledWith('order.activate', { orderId: 'order-1' }, ORDER_ACTIVATION_SEND_OPTIONS)
  })

  it('ALIPAY 回调：paymentMethod 回填 ALIPAY（通道方法透传）', async () => {
    const channel = createMockChannel({ method: 'ALIPAY', secret: 's' })
    const boss = makeBoss()
    const { prisma, orders } = makeStatefulPrisma()
    const service = buildService(prisma, boss, channel)
    const created = await service.createPayment('order-1', 'ALIPAY')
    const callback = channel.buildCallback({
      channelOrderNo: created.channelOrderNo,
      channelTxnNo: 'alipay-txn-1',
    })

    await handlePaymentCallback(channel, callback.rawBody, callback.headers, {
      prisma,
      orders: service,
    })

    expect(orders[0]).toMatchObject({ status: 'PAID', paymentMethod: 'ALIPAY' })
    expect(boss.send).toHaveBeenCalledWith('order.activate', { orderId: 'order-1' }, ORDER_ACTIVATION_SEND_OPTIONS)
  })
})

describe('handlePaymentCallback：幂等（channelTxnNo 锚）', () => {
  it('同交易号重复回调两次：第二次 { duplicate: true }，订单只开通一次（boss.send 恰一次、事件恰一条）', async () => {
    const { channel, boss, prisma, service, callback } = await setupPaidFlow()

    const first = await handlePaymentCallback(channel, callback.rawBody, callback.headers, {
      prisma,
      orders: service,
    })
    const second = await handlePaymentCallback(channel, callback.rawBody, callback.headers, {
      prisma,
      orders: service,
    })

    expect(first).toEqual({ duplicate: false })
    expect(second).toEqual({ duplicate: true })
    expect(boss.send).toHaveBeenCalledTimes(1)
    expect(prisma.orderEvent.create).toHaveBeenCalledTimes(1)
  })

  it('流水已 FAILED（该交易号被终态处理）→ PaymentStateError，不迁移不投递', async () => {
    const channel = createMockChannel({ method: 'WECHAT' })
    const created = await channel.createPayment({
      orderId: 'order-1',
      orderNo: 'GEO261015ab12cd34',
      amountCents: 15000,
    })
    const { prisma } = makeStatefulPrisma({
      payments: [
        makePayment({
          status: 'FAILED',
          channelTxnNo: 'txn-failed',
          channelOrderNo: created.channelOrderNo,
        }),
      ],
    })
    const service = buildService(prisma, makeBoss(), channel)
    const callback = channel.buildCallback({
      channelOrderNo: created.channelOrderNo,
      channelTxnNo: 'txn-failed',
    })

    await expect(
      handlePaymentCallback(channel, callback.rawBody, callback.headers, {
        prisma,
        orders: service,
      }),
    ).rejects.toThrow(PaymentStateError)
  })
})

describe('handlePaymentCallback：金额校验（步骤 3）', () => {
  it('回调金额 ≠ 流水金额 → CallbackAmountMismatchError，状态不变（不置成功不迁移不投递）', async () => {
    const { channel, boss, prisma, orders, payments, service, created } = await setupPaidFlow()
    const mismatched = channel.buildCallback({
      channelOrderNo: created.channelOrderNo,
      channelTxnNo: 'mock-txn-0001',
      amountCents: 1, // 流水 15000 分
    })

    await expect(
      handlePaymentCallback(channel, mismatched.rawBody, mismatched.headers, {
        prisma,
        orders: service,
      }),
    ).rejects.toThrow(CallbackAmountMismatchError)

    expect(payments[0].status).toBe('PENDING')
    expect(orders[0].status).toBe('PENDING_PAYMENT')
    expect(orders[0].paidAt).toBeNull()
    expect(boss.send).not.toHaveBeenCalled()
  })
})

describe('handlePaymentCallback：验签失败（步骤 1）', () => {
  it('签名不符 → CallbackSignatureError，不触库（verify 先于一切读）', async () => {
    const { channel, prisma, service, callback } = await setupPaidFlow()

    await expect(
      handlePaymentCallback(
        channel,
        callback.rawBody,
        { 'x-mock-signature': 'deadbeef' },
        { prisma, orders: service },
      ),
    ).rejects.toThrow(CallbackSignatureError)
    expect(prisma.paymentTransaction.findUnique).not.toHaveBeenCalled()
  })
})

describe('handlePaymentCallback：PENDING 回调（渠道受理未完成）', () => {
  it('status=PENDING → 确认收到但不置成功（{ duplicate: false }，无写入无投递）', async () => {
    const { channel, boss, prisma, orders, payments, service, created } = await setupPaidFlow()
    const pending = channel.buildCallback({
      channelOrderNo: created.channelOrderNo,
      channelTxnNo: 'mock-txn-0001',
      status: 'PENDING',
    })

    const result = await handlePaymentCallback(channel, pending.rawBody, pending.headers, {
      prisma,
      orders: service,
    })

    expect(result).toEqual({ duplicate: false })
    expect(payments[0].status).toBe('PENDING')
    expect(orders[0].status).toBe('PENDING_PAYMENT')
    expect(boss.send).not.toHaveBeenCalled()
  })
})

describe('handlePaymentCallback：流水不存在', () => {
  it('channelOrderNo 查无流水行（回调先于建行/环境不一致）→ PaymentNotFoundError', async () => {
    const channel = createMockChannel({ method: 'WECHAT' })
    const created = await channel.createPayment({
      orderId: 'order-1',
      orderNo: 'GEO261015ab12cd34',
      amountCents: 15000,
    })
    const callback = channel.buildCallback({
      channelOrderNo: created.channelOrderNo,
      channelTxnNo: 'txn-orphan',
    })
    const { prisma } = makeStatefulPrisma({ payments: [] })
    const service = buildService(prisma, makeBoss(), channel)

    await expect(
      handlePaymentCallback(channel, callback.rawBody, callback.headers, {
        prisma,
        orders: service,
      }),
    ).rejects.toThrow(PaymentNotFoundError)
  })
})

// ---------------------------------------------------------------------------
// confirmChannelPayment：并发竞态（条件更新 count=0 二次裁断）
// ---------------------------------------------------------------------------

describe('confirmChannelPayment：竞态裁断（count=0 再读流水）', () => {
  it('事务内 count=0 且流水已 SUCCEEDED 同交易号（并发赢家已提交）→ { duplicate: true }，不投递', async () => {
    const channel = createMockChannel({ method: 'WECHAT' })
    const boss = makeBoss()
    const { prisma } = makeStatefulPrisma({
      orders: [makeOrder({ status: 'PENDING_PAYMENT' })],
      payments: [
        makePayment({
          status: 'SUCCEEDED',
          channelTxnNo: 'txn-race',
          channelOrderNo: 'mock-co-race',
        }),
      ],
    })
    const service = buildService(prisma, boss, channel)

    const result = await service.confirmChannelPayment({
      paymentId: 'pay-1',
      orderId: 'order-1',
      method: 'WECHAT',
      channelTxnNo: 'txn-race',
      channelOrderNo: 'mock-co-race',
    })

    expect(result).toEqual({ duplicate: true })
    expect(boss.send).not.toHaveBeenCalled()
  })

  it('事务内 count=0 且流水 FAILED → PaymentStateError 整体回滚，不投递', async () => {
    const channel = createMockChannel({ method: 'WECHAT' })
    const boss = makeBoss()
    const { prisma } = makeStatefulPrisma({
      orders: [makeOrder({ status: 'PENDING_PAYMENT' })],
      payments: [makePayment({ status: 'FAILED', channelOrderNo: 'mock-co-f' })],
    })
    const service = buildService(prisma, boss, channel)

    await expect(
      service.confirmChannelPayment({
        paymentId: 'pay-1',
        orderId: 'order-1',
        method: 'WECHAT',
        channelTxnNo: 'txn-2',
        channelOrderNo: 'mock-co-f',
      }),
    ).rejects.toThrow(PaymentStateError)
    expect(boss.send).not.toHaveBeenCalled()
  })

  it('迁移预检被拒（订单已 PAID——并发回调已整体提交）且流水同交易号 SUCCEEDED → duplicate，不投递', async () => {
    const channel = createMockChannel({ method: 'WECHAT' })
    const boss = makeBoss()
    const { prisma } = makeStatefulPrisma({
      orders: [makeOrder({ status: 'PAID', paymentMethod: 'WECHAT', paidAt: NOW })],
      payments: [
        makePayment({
          status: 'SUCCEEDED',
          channelTxnNo: 'txn-race',
          channelOrderNo: 'mock-co-race',
        }),
      ],
    })
    const service = buildService(prisma, boss, channel)

    const result = await service.confirmChannelPayment({
      paymentId: 'pay-1',
      orderId: 'order-1',
      method: 'WECHAT',
      channelTxnNo: 'txn-race',
      channelOrderNo: 'mock-co-race',
    })

    expect(result).toEqual({ duplicate: true })
    expect(boss.send).not.toHaveBeenCalled()
  })

  it('订单已 PAID 但流水 PENDING（跨单竞态/脏数据）→ OrderTransitionError 原样上抛', async () => {
    const channel = createMockChannel({ method: 'WECHAT' })
    const boss = makeBoss()
    const { prisma } = makeStatefulPrisma({
      orders: [makeOrder({ status: 'PAID' })],
      payments: [makePayment({ status: 'PENDING', channelOrderNo: 'mock-co-p' })],
    })
    const service = buildService(prisma, boss, channel)

    await expect(
      service.confirmChannelPayment({
        paymentId: 'pay-1',
        orderId: 'order-1',
        method: 'WECHAT',
        channelTxnNo: 'txn-3',
        channelOrderNo: 'mock-co-p',
      }),
    ).rejects.toThrow(OrderTransitionError)
    expect(boss.send).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// mapWebhookError：webhook 错误 → HTTP 映射（裁定）
// ---------------------------------------------------------------------------

describe('mapWebhookError（webhook 错误映射）', () => {
  it('CallbackSignatureError → 403', () => {
    expect(mapWebhookError(new CallbackSignatureError('bad'))).toMatchObject({ status: 403 })
  })

  it('CallbackAmountMismatchError / PaymentStateError / OrderTransitionError / PaymentNotFoundError → 400（重试无意义，回调方需可区分）', () => {
    expect(mapWebhookError(new CallbackAmountMismatchError('m'))).toMatchObject({ status: 400 })
    expect(mapWebhookError(new PaymentStateError('m'))).toMatchObject({ status: 400 })
    expect(mapWebhookError(new OrderTransitionError('m'))).toMatchObject({ status: 400 })
    expect(mapWebhookError(new PaymentNotFoundError('p'))).toMatchObject({ status: 400 })
  })

  it('未知错误 → 500', () => {
    expect(mapWebhookError(new Error('boom'))).toMatchObject({ status: 500 })
    expect(mapWebhookError('not-an-error')).toMatchObject({ status: 500 })
  })

  it('message 透传（{ ok:false, error } 体用）', () => {
    expect(mapWebhookError(new CallbackSignatureError('签名不符'))).toMatchObject({
      status: 403,
      message: '签名不符',
    })
  })
})

// ---------------------------------------------------------------------------
// reconcilePendingPayments：每日主动查单对账（§6.3）
// ---------------------------------------------------------------------------

describe('reconcilePendingPayments（每日对账补单）', () => {
  it('扫描条件：status=PENDING 且 method IN (WECHAT, ALIPAY)（线下流水不进对账）', async () => {
    const channel = createMockChannel({ method: 'WECHAT' })
    const boss = makeBoss()
    const { prisma } = makeStatefulPrisma({ payments: [] })
    const service = buildService(prisma, boss, channel)

    await reconcilePendingPayments({ prisma, orders: service, channelFor: () => channel })

    expect(prisma.paymentTransaction.findMany).toHaveBeenCalledWith({
      where: { status: 'PENDING', method: { in: ['WECHAT', 'ALIPAY'] } },
      orderBy: { createdAt: 'asc' },
      // 遗留 E4：批量上限 500（与其它 cron 一致，防单次扫全表）
      take: RECONCILE_BATCH_LIMIT,
    })
  })

  it('渠道已支付（queryOrder SUCCESS）→ 回调等价补单：置成功 + 迁移 + 投递恰一次', async () => {
    const channel = createMockChannel({
      method: 'WECHAT',
      settlePredicate: () => true,
    })
    const boss = makeBoss()
    const { prisma, orders, payments } = makeStatefulPrisma()
    const service = buildService(prisma, boss, channel)
    const created = await service.createPayment('order-1', 'WECHAT')

    const result = await reconcilePendingPayments({ prisma, orders: service, channelFor: () => channel })

    expect(result).toMatchObject({ scanned: 1, confirmed: 1, duplicates: 0, failed: 0 })
    expect(payments[0]).toMatchObject({ status: 'SUCCEEDED', channelOrderNo: created.channelOrderNo })
    expect(orders[0]).toMatchObject({ status: 'PAID', paymentMethod: 'WECHAT', paidAt: NOW })
    expect(boss.send).toHaveBeenCalledTimes(1)
  })

  it('渠道未支付（queryOrder PENDING）→ 不补单不投递', async () => {
    const channel = createMockChannel({
      method: 'WECHAT',
      settlePredicate: () => false,
    })
    const boss = makeBoss()
    const { prisma } = makeStatefulPrisma()
    const service = buildService(prisma, boss, channel)
    await service.createPayment('order-1', 'WECHAT')

    const result = await reconcilePendingPayments({ prisma, orders: service, channelFor: () => channel })

    expect(result).toMatchObject({ scanned: 1, confirmed: 0, failed: 0 })
    expect(boss.send).not.toHaveBeenCalled()
  })

  it('单行失败（渠道查无此单）不中断批次：failed 计数，其余行照常补单', async () => {
    let settled = false
    const channel = createMockChannel({
      method: 'WECHAT',
      settlePredicate: () => settled,
    })
    const boss = makeBoss()
    const { prisma } = makeStatefulPrisma()
    const service = buildService(prisma, boss, channel)
    await service.createPayment('order-1', 'WECHAT') // 渠道注册表内
    // 直插一行渠道侧不存在的 PENDING 流水（历史 mock 数据）
    await prisma.paymentTransaction.create({
      data: {
        orderId: 'order-1',
        method: 'WECHAT',
        status: 'PENDING',
        amountCents: 15000,
        channelOrderNo: 'mock-ghost',
      },
    })
    settled = true

    const result = await reconcilePendingPayments({ prisma, orders: service, channelFor: () => channel })

    expect(result).toMatchObject({ scanned: 2, confirmed: 1, failed: 1 })
    expect(boss.send).toHaveBeenCalledTimes(1)
  })

  it('对账与回调竞态：扫描到旧 PENDING 快照、回调已先行处理同交易号 → duplicates 计数，不重复投递', async () => {
    const channel = createMockChannel({
      method: 'WECHAT',
      settlePredicate: () => true,
    })
    const boss = makeBoss()
    const { prisma, payments } = makeStatefulPrisma()
    const service = buildService(prisma, boss, channel)
    const created = await service.createPayment('order-1', 'WECHAT')
    // 回调先用"queryOrder 将返回的同一交易号"处理完毕（mock queryOrder 交易号确定：
    // mock-txn-{channelOrderNo}）
    const callback = channel.buildCallback({
      channelOrderNo: created.channelOrderNo,
      channelTxnNo: `mock-txn-${created.channelOrderNo}`,
    })
    await handlePaymentCallback(channel, callback.rawBody, callback.headers, {
      prisma,
      orders: service,
    })
    expect(boss.send).toHaveBeenCalledTimes(1)

    // 模拟扫描视图为回调提交前的旧 PENDING 快照（scan-then-confirm 竞态窗口）
    prisma.paymentTransaction.findMany.mockResolvedValueOnce([
      { ...payments[0], status: 'PENDING' },
    ])
    const result = await reconcilePendingPayments({ prisma, orders: service, channelFor: () => channel })

    expect(result).toMatchObject({ scanned: 1, confirmed: 0, duplicates: 1, failed: 0 })
    expect(boss.send).toHaveBeenCalledTimes(1) // 不重复开通
  })
})
