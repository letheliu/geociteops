import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { PaymentMethod } from '@prisma/client'

/**
 * 线上支付渠道接口（任务 6，微信/支付宝）：下单 / 回调验签 / 主动查单 / 退款。
 * P2 全量走 mock 实现（resolveChannel 工厂），真实 SDK 对接时按 env 切换实现类，
 * 接口形状不变（遗留项 4）。
 */

/** 回调验签失败（签名不符 / 负载非法）：name 固定为 CALLBACK_SIGNATURE，webhook 映射 403 */
export class CallbackSignatureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CALLBACK_SIGNATURE'
  }
}

/**
 * mock 渠道签名密钥缺失（env PAY_MOCK_SECRET 未设置）：fail-closed 拒绝装配。
 * 默认密钥源码公开——静默回落等于"持 channelOrderNo 者可自造合法签名免付置 PAID"
 * 的自助欺诈路径（审查 Important-1）。生产与 dev 均须显式设置后启动。
 */
export class MissingMockSecretError extends Error {
  constructor() {
    super(
      'env PAY_MOCK_SECRET 未设置：mock 支付渠道拒绝以源码公开的默认密钥验签（fail-closed，防伪造回调签名；请设置后重启）',
    )
    this.name = 'MISSING_MOCK_SECRET'
  }
}

/** 启动断言：mock 渠道密钥已配置（server.ts 装配时调用；缺密钥即抛错终止启动，模式照 loadMasterKey） */
export function assertMockChannelConfigured(
  env: Record<string, string | undefined> = process.env,
): void {
  if (!env.PAY_MOCK_SECRET) throw new MissingMockSecretError()
}

/** 常量时间比较（签名比对防时序侧信道；长度不等直接 false——timingSafeEqual 要求等长 Buffer） */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/** 渠道回调解析结果（验签通过后提取的业务字段） */
export interface ChannelCallbackPayload {
  channelTxnNo: string
  channelOrderNo: string
  orderNo: string
  amountCents: number
  status: 'SUCCESS' | 'PENDING'
}

/**
 * 支付渠道统一接口（规格 §6.3）：
 * - createPayment：渠道侧下单（返回渠道单号 + 收银台/二维码地址）；
 * - verifyCallback：验签并解析回调（rawBody 为规范化 body 串，见 server.ts 裁定注释）；
 * - queryOrder：主动查单（每日对账 cron 用，§6.3）；
 * - refund：渠道退款（任务 7 退款流程用，mock 即时 EXECUTED）。
 */
export interface PaymentChannel {
  readonly method: PaymentMethod
  createPayment(order: {
    orderId: string
    orderNo: string
    amountCents: number
  }): Promise<{ channelOrderNo: string; payUrl: string }>
  verifyCallback(rawBody: string, headers: Record<string, string>): Promise<ChannelCallbackPayload>
  queryOrder(channelOrderNo: string): Promise<{ channelTxnNo?: string; status: 'SUCCESS' | 'PENDING' }>
  refund(input: {
    channelOrderNo: string
    amountCents: number
  }): Promise<{ channelRefundNo: string; status: 'EXECUTED' }>
}

/** mock 渠道内存注册表行（createPayment 写入；buildCallback/queryOrder 读取） */
interface MockRegistryEntry {
  orderId: string
  orderNo: string
  amountCents: number
}

/** mock 渠道扩展面：测试/联调用 buildCallback（生成合法签名回调）与 settle（驱动结算） */
export interface MockChannel extends PaymentChannel {
  /**
   * 按注册表单据生成回调原文与合法签名头（secret 同渠道）。
   * amountCents/status 可覆盖（金额不符 / PENDING 受理回调用例）。
   */
  buildCallback(input: {
    channelOrderNo: string
    channelTxnNo: string
    amountCents?: number
    status?: 'SUCCESS' | 'PENDING'
  }): { rawBody: string; headers: Record<string, string> }
  /** 标记渠道侧已支付（dev/测试结算驱动）：queryOrder 即返 SUCCESS——装配级单例下跨调用点可见 */
  settle(channelOrderNo: string): void
}

/**
 * mock 渠道缺省签名密钥：仅供测试直连 createMockChannel 缺省用；
 * 装配路径（resolveChannel）绝不回落到它——缺 PAY_MOCK_SECRET 即 MissingMockSecretError。
 */
const DEFAULT_MOCK_SECRET = 'mock-secret'

/** mock 签名头名（小写；Node 入站 header 名统一小写） */
export const MOCK_SIGNATURE_HEADER = 'x-mock-signature'

/**
 * mock 渠道实现：
 * - 单号 `mock-{uuid}`（cuid 替身，与 files.ts 的 randomUUID 惯例一致）；
 * - 验签 = sha256(rawBody + secret) 比对 x-mock-signature 头；
 * - queryOrder 依注入的 settlePredicate 决定 SUCCESS/PENDING（测试可控用户是否已付款；
 *   生产对账语义由真实渠道替换）；
 * - 无状态持久化：注册表在内存，进程重启即失效（mock 先行）。
 */
export function createMockChannel(
  opts: {
    method: 'WECHAT' | 'ALIPAY'
    secret?: string
    settlePredicate?: (entry: MockRegistryEntry) => boolean
  } = { method: 'WECHAT' },
): MockChannel {
  const method = opts.method
  const secret = opts.secret ?? DEFAULT_MOCK_SECRET
  const settlePredicate = opts.settlePredicate ?? (() => false)
  const registry = new Map<string, MockRegistryEntry>()
  const settled = new Set<string>()

  function sign(rawBody: string): string {
    return createHash('sha256').update(rawBody + secret).digest('hex')
  }

  return {
    method,
    async createPayment(order) {
      const channelOrderNo = `mock-${randomUUID()}`
      registry.set(channelOrderNo, {
        orderId: order.orderId,
        orderNo: order.orderNo,
        amountCents: order.amountCents,
      })
      return { channelOrderNo, payUrl: `https://mock.pay/qr/${channelOrderNo}` }
    },

    async verifyCallback(rawBody, headers) {
      const provided = headers[MOCK_SIGNATURE_HEADER]
      if (typeof provided !== 'string' || !safeEqual(sign(rawBody), provided)) {
        throw new CallbackSignatureError('mock 渠道验签失败：x-mock-signature 与 sha256(rawBody+secret) 不符')
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(rawBody)
      } catch {
        throw new CallbackSignatureError('mock 渠道回调负载不是合法 JSON')
      }
      const payload = parsed as Partial<ChannelCallbackPayload>
      const { channelTxnNo, channelOrderNo, orderNo, amountCents, status } = payload
      if (
        typeof channelTxnNo !== 'string' ||
        typeof channelOrderNo !== 'string' ||
        typeof orderNo !== 'string' ||
        typeof amountCents !== 'number' ||
        !Number.isInteger(amountCents) ||
        (status !== 'SUCCESS' && status !== 'PENDING')
      ) {
        throw new CallbackSignatureError('mock 渠道回调负载字段缺失或类型非法')
      }
      return { channelTxnNo, channelOrderNo, orderNo, amountCents, status }
    },

    async queryOrder(channelOrderNo) {
      const entry = registry.get(channelOrderNo)
      if (!entry) {
        throw new Error(`mock 渠道查无此单：${channelOrderNo}`)
      }
      if (!settlePredicate(entry) && !settled.has(channelOrderNo)) return { status: 'PENDING' }
      // 交易号确定派生（channelOrderNo 唯一）：对账补单与回调可用同一交易号幂等合流
      return { channelTxnNo: `mock-txn-${channelOrderNo}`, status: 'SUCCESS' }
    },

    async refund(input) {
      return { channelRefundNo: `mock-rf-${randomUUID()}`, status: 'EXECUTED' }
    },

    buildCallback(input) {
      const entry = registry.get(input.channelOrderNo)
      if (!entry) {
        throw new Error(`mock 渠道查无此单（buildCallback）：${input.channelOrderNo}`)
      }
      const payload = {
        channelTxnNo: input.channelTxnNo,
        channelOrderNo: input.channelOrderNo,
        orderNo: entry.orderNo,
        amountCents: input.amountCents ?? entry.amountCents,
        status: input.status ?? 'SUCCESS',
      }
      const rawBody = JSON.stringify(payload)
      return { rawBody, headers: { [MOCK_SIGNATURE_HEADER]: sign(rawBody) } }
    },

    settle(channelOrderNo) {
      settled.add(channelOrderNo)
    },
  }
}

/**
 * 渠道工厂（env 装配）：
 * - WECHAT / ALIPAY → mock 渠道（secret 取 env PAY_MOCK_SECRET；**缺失即
 *   MissingMockSecretError，fail-closed 不回落默认密钥**——默认密钥源码公开，
 *   静默回落 = 可伪造回调签名免付置 PAID，审查 Important-1）；
 * - 线下通道（BANK_TRANSFER / CONTRACT_CREDIT）显性报错（线上下单只接受 WECHAT/ALIPAY）。
 * TODO(遗留项 4)：env 配置 WECHAT_PAY_MCH_ID / ALIPAY_APP_ID 后切换真实渠道 SDK
 * （微信支付 v3 / 支付宝开放平台），接口形状不变；P2 mock 先行。
 */
export function resolveChannel(
  method: PaymentMethod,
  env: Record<string, string | undefined> = process.env,
): PaymentChannel {
  if (method === 'WECHAT' || method === 'ALIPAY') {
    const secret = env.PAY_MOCK_SECRET
    if (!secret) throw new MissingMockSecretError()
    return createMockChannel({ method, secret })
  }
  throw new Error(`不支持的线上支付渠道：${method}（仅 WECHAT / ALIPAY；线下收款走回单/账期流程）`)
}

/**
 * 装配级渠道注册表（审查 Minor-5 修复）：按 method 记忆渠道实例——
 * createPayment（下单注册）/ verifyCallback（回调验签）/ queryOrder（对账查单）
 * 必须共享同一 mock 内存注册表；逐调用 resolveChannel 新建实例会互不可见，
 * mock 下 payment.reconcile 的 queryOrder 恒"查无此单"、补单路径不可达。
 * 生产装配（server.ts）以本工厂注入 order-service / webhook 路由 / reconcile。
 */
export function createChannelRegistry(
  env: Record<string, string | undefined> = process.env,
): (method: PaymentMethod) => PaymentChannel {
  const cache = new Map<PaymentMethod, PaymentChannel>()
  return (method) => {
    const cached = cache.get(method)
    if (cached) return cached
    const channel = resolveChannel(method, env)
    cache.set(method, channel)
    return channel
  }
}
