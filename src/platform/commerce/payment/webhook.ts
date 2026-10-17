import type { PaymentMethod, PrismaClient } from '@prisma/client'
import { CallbackSignatureError, createChannelRegistry } from './channel.js'
import type { PaymentChannel } from './channel.js'
import { OrderTransitionError, PaymentNotFoundError, PaymentStateError } from '../order-service.js'
import type { OrderService } from '../order-service.js'

/**
 * 在线支付回调处理（任务 6，规格 §6.3）：验签 → channelTxnNo 幂等 → 金额校验 →
 * 原子置成功（service.confirmChannelPayment：流水 + 迁移 + 回填 + 投递四笔写一个事务）。
 * 纯函数（prisma/orders 注入），fastify 薄壳与测试共用同一入口。
 */

/** 回调金额与流水金额不符：name 固定为 CALLBACK_AMOUNT_MISMATCH，webhook 映射 400 */
export class CallbackAmountMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CALLBACK_AMOUNT_MISMATCH'
  }
}

/** handlePaymentCallback 依赖（prisma 读流水 + service 原子确认） */
export interface HandlePaymentCallbackDeps {
  prisma: PrismaClient
  orders: Pick<OrderService, 'confirmChannelPayment'>
}

/**
 * 处理渠道支付回调（幂等）：
 * 1. verifyCallback 验签失败 → CallbackSignatureError（webhook 403）；
 * 2. channelTxnNo 幂等预查（唯一约束锚）：已 SUCCEEDED 同交易号 → { duplicate: true }；
 *    该交易号对应行处其他终态（FAILED/REFUNDED）→ PaymentStateError；
 * 3. 金额校验：回调 amountCents ≠ 流水 amountCents → CallbackAmountMismatchError（不置成功）；
 * 4. confirmChannelPayment：置流水 SUCCEEDED（channelTxnNo/channelOrderNo 回填）+
 *    transition payment.confirmed（Order.paymentMethod=WECHAT/ALIPAY + paidAt 回填）+
 *    enqueue order.activate（事务提交后）。
 * status=PENDING 的受理回调：确认收到即返回，不落任何状态变更。
 */
export async function handlePaymentCallback(
  channel: PaymentChannel,
  rawBody: string,
  headers: Record<string, string>,
  deps: HandlePaymentCallbackDeps,
): Promise<{ duplicate: boolean }> {
  // 1) 验签（先于一切读：签名不符不触库）
  const cb = await channel.verifyCallback(rawBody, headers)

  // 渠道受理中（用户未完成支付）：ack 即可，不置成功不迁移
  if (cb.status !== 'SUCCESS') return { duplicate: false }

  // 2) channelTxnNo 幂等预查：该交易号的回调已处理过 → duplicate（渠道重试安全）
  const byTxn = await deps.prisma.paymentTransaction.findUnique({
    where: { channelTxnNo: cb.channelTxnNo },
  })
  if (byTxn) {
    if (byTxn.status === 'SUCCEEDED') return { duplicate: true }
    throw new PaymentStateError(
      `交易号 ${cb.channelTxnNo} 对应流水已处终态 ${byTxn.status}，拒绝按 SUCCESS 回调重复处理`,
    )
  }

  // 3) 流水定位（channelOrderNo：createPayment 建行时写入的唯一锚）+ 金额校验
  const payment = await deps.prisma.paymentTransaction.findUnique({
    where: { channelOrderNo: cb.channelOrderNo },
  })
  if (!payment) {
    throw new PaymentNotFoundError(`channelOrderNo=${cb.channelOrderNo}（回调无对应支付流水）`)
  }
  if (cb.amountCents !== payment.amountCents) {
    throw new CallbackAmountMismatchError(
      `回调金额 ${cb.amountCents} 分与流水金额 ${payment.amountCents} 分不符（channelOrderNo=${cb.channelOrderNo}，channelTxnNo=${cb.channelTxnNo}）`,
    )
  }

  // 4) 原子确认（四笔写一个事务 + 事务后投递；并发重复在 service 内二次裁断为 duplicate）
  return await deps.orders.confirmChannelPayment({
    paymentId: payment.id,
    orderId: payment.orderId,
    method: channel.method,
    channelTxnNo: cb.channelTxnNo,
    channelOrderNo: cb.channelOrderNo,
    rawPayload: { callbackBody: rawBody },
    note: `线上支付回调：${cb.channelTxnNo}`,
  })
}

/**
 * webhook 错误 → HTTP 映射（裁定）：
 * - CallbackSignatureError → 403（验签失败，疑似伪造）；
 * - CallbackAmountMismatchError / PaymentStateError / OrderTransitionError /
 *   PaymentNotFoundError → 400（回调引用的单据/金额/状态问题，重试无意义——回调方需可区分）；
 * - 其余未知 → 500（基础设施问题，渠道按其重试策略重试）。
 */
export function mapWebhookError(err: unknown): { status: number; message: string } {
  if (err instanceof CallbackSignatureError) return { status: 403, message: err.message }
  if (
    err instanceof CallbackAmountMismatchError ||
    err instanceof PaymentStateError ||
    err instanceof OrderTransitionError ||
    err instanceof PaymentNotFoundError
  ) {
    return { status: 400, message: err.message }
  }
  return { status: 500, message: err instanceof Error ? err.message : String(err) }
}

/** webhook 渠道路径参数 → PaymentMethod（wechat/alipay；其余 null → 路由 400） */
export function parseWebhookChannelParam(name: string): 'WECHAT' | 'ALIPAY' | null {
  const lower = name.toLowerCase()
  if (lower === 'wechat') return 'WECHAT'
  if (lower === 'alipay') return 'ALIPAY'
  return null
}

/** reconcilePendingPayments 依赖 */
export interface ReconcileDeps {
  prisma: PrismaClient
  orders: Pick<OrderService, 'confirmChannelPayment'>
  /** 渠道解析（缺省 createChannelRegistry(env) 记忆化单例；测试/装配注入受控渠道） */
  channelFor?: (method: PaymentMethod) => PaymentChannel
  /** 渠道工厂 env（缺省 process.env；测试注入空对象隔离） */
  env?: Record<string, string | undefined>
  /** 单行失败日志（缺省 console.error）；整批异常仍上抛由 cron 层兜底 */
  log?: (err: unknown, note: string) => void
}

/**
 * 对账扫描批量上限（遗留 E4，防单次扫全表，余量次日继续）——对齐
 * billing-crons.ts 的 CRON_BATCH_LIMIT（500）；本文件属 platform 层不反向
 * import workers 层，故独立常量（同 subscription-service 的分层先例）。
 */
export const RECONCILE_BATCH_LIMIT = 500

/**
 * 每日主动查单对账（§6.3）：扫描线上（WECHAT/ALIPAY）PENDING 流水 → 渠道 queryOrder →
 * SUCCESS 走 handlePaymentCallback 等价补单路径（confirmChannelPayment，同幂等锚）。
 * 单行失败不中断批次（failed 计数，下次 cron 重扫）；回调已先行处理的合流为 duplicates。
 */
export async function reconcilePendingPayments(deps: ReconcileDeps): Promise<{
  scanned: number
  confirmed: number
  duplicates: number
  failed: number
}> {
  const pending = await deps.prisma.paymentTransaction.findMany({
    where: { status: 'PENDING', method: { in: ['WECHAT', 'ALIPAY'] } },
    orderBy: { createdAt: 'asc' },
    // 遗留 E4：批量上限（createdAt asc 优先补最老的单），余量次日 cron 继续
    take: RECONCILE_BATCH_LIMIT,
  })
  let confirmed = 0
  let duplicates = 0
  let failed = 0
  // 缺省记忆化注册表（mock 注册表跨行可见）；生产装配注入 server 级共享实例
  const channelFor = deps.channelFor ?? createChannelRegistry(deps.env ?? process.env)
  for (const payment of pending) {
    try {
      const channel = channelFor(payment.method)
      if (!payment.channelOrderNo) {
        throw new PaymentStateError(
          `线上 PENDING 流水缺 channelOrderNo（脏数据）：paymentId=${payment.id}`,
        )
      }
      const queried = await channel.queryOrder(payment.channelOrderNo)
      if (queried.status === 'SUCCESS' && queried.channelTxnNo) {
        const result = await deps.orders.confirmChannelPayment({
          paymentId: payment.id,
          orderId: payment.orderId,
          method: payment.method,
          channelTxnNo: queried.channelTxnNo,
          channelOrderNo: payment.channelOrderNo,
          rawPayload: { reconcile: true, channelTxnNo: queried.channelTxnNo },
          note: '每日对账补单（payment.reconcile）',
        })
        if (result.duplicate) duplicates++
        else confirmed++
      }
    } catch (err) {
      failed++
      ;(deps.log ?? console.error)(err, `[payment.reconcile] 单笔对账失败：paymentId=${payment.id}`)
    }
  }
  return { scanned: pending.length, confirmed, duplicates, failed }
}
