import type PgBoss from 'pg-boss'
import type { PrismaClient } from '@prisma/client'
import { createAuditService } from '../platform/audit/service.js'
import type { AuditService } from '../platform/audit/service.js'
import {
  CREDIT_OVERDUE_SUSPEND_REASON,
  OrderTransitionError,
  type OrderService,
} from '../platform/commerce/order-service.js'
import { DAY_MS, runExpireCheck } from '../platform/billing/subscription-service.js'
import { ACTIVE_DELIVERY_STATUSES } from '../platform/billing/service-state.js'
import type { EntitlementService } from '../platform/billing/entitlement-service.js'

// ---------------------------------------------------------------------------
// 计费 cron（任务 8）：order.reconcile（对账告警）/ order.expire（超时取消）。
// 任务 11 增订阅到期检查：subscription.expire-check（提醒/入宽限/宽限满暂停，
// 主体逻辑在 platform/billing/subscription-service.ts，此处仅薄壳注册）。
// 模式同 server.ts 的 session.purge / payment.reconcile（boss.createQueue +
// boss.schedule + boss.work）；payment.reconcile 保持 server.ts 内联，不迁移。
// 审计 actorType 用 'SYSTEM'（worker/cron 场景，非用户操作——任务 8 引入）。
// ---------------------------------------------------------------------------

export const BILLING_CRON_QUEUES = {
  reconcile: 'order.reconcile',
  expire: 'order.expire',
  expireCheck: 'subscription.expire-check',
} as const

/** 每日 04:05（避开 04:00 session.purge 与 04:30 payment.reconcile） */
export const ORDER_RECONCILE_CRON = '5 4 * * *'

/** 每日 04:10 */
export const ORDER_EXPIRE_CRON = '10 4 * * *'

/** 每日 04:15：订阅到期检查，紧随 order.expire 之后 */
export const SUBSCRIPTION_EXPIRE_CHECK_CRON = '15 4 * * *'

/** cron 批量上限（防单次扫全表；余量次日继续） */
export const CRON_BATCH_LIMIT = 500

/** 停留告警阈值：1 小时（PAID "已收款必开通"丢任务 + FULFILLING 停滞兜底共用，终审 I2） */
export const PAID_STALLED_THRESHOLD_MS = 60 * 60 * 1000

/** 待支付订单超时：7 天（§6.2 超时自动取消） */
export const ORDER_EXPIRE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000

/** 账期超期自动暂停天数缺省值：dueAt 已过超 7 天（§6.2 合同账期补充规则，可配置） */
export const DEFAULT_CREDIT_OVERDUE_SUSPEND_DAYS = 7

/**
 * 账期超期自动暂停天数（env CREDIT_OVERDUE_SUSPEND_DAYS，缺省 7；
 * env 读取模式同 service-state.subscriptionGraceDays）。
 */
export function creditOverdueSuspendDays(
  env: { CREDIT_OVERDUE_SUSPEND_DAYS?: string } = process.env,
): number {
  const raw = Number.parseInt(env.CREDIT_OVERDUE_SUSPEND_DAYS ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CREDIT_OVERDUE_SUSPEND_DAYS
}

/** 超时取消迁移的 OrderEvent note（可读审计锚） */
export const ORDER_EXPIRE_NOTE = '超时未支付自动取消（7 天）'

/**
 * cron 日志器（遗留 B9）：fastify.log 满足的结构子集。缺省回退 console——
 * 测试与独立调用（不经 server 装配）保持既有 console 行为不变。
 */
export interface BillingCronLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

export interface BillingCronContext {
  prisma: PrismaClient
  orders: Pick<OrderService, 'transition'>
  /** 审计；缺省用 prisma 自建 */
  audit?: AuditService
  /** 配额重算（subscription.expire-check 过期后调用；可选注入） */
  entitlements?: Pick<EntitlementService, 'recompute'>
  /** 时钟注入，缺省系统时间 */
  now?: () => Date
  /** 账期超期暂停天数（测试注入）；缺省 env CREDIT_OVERDUE_SUSPEND_DAYS（再缺省 7） */
  suspendDays?: number
  /**
   * 日志器注入（遗留 B9）：runOrderReconcile/runOrderExpire 与 startBillingCrons
   * 的 handler 日志走此通道（server 装配传 fastify.log）；缺省回退 console。
   */
  logger?: BillingCronLogger
}

export interface BillingCronsDeps extends BillingCronContext {
  boss: PgBoss
}

export interface OrderReconcileResult {
  paidStalled: number
  /** FULFILLING 停留 >1h 告警数（终审 I2：worker 五连败/credit.open 后崩溃兜底） */
  fulfillingStalled: number
  creditOverdue: number
  /** 账期超期自动暂停的 workspace 行数（终审 I1；聚合判定跳过不计） */
  creditSuspended: number
  /** 因聚合判定（org 仍有其他有效服务）跳过暂停的应收单数（终审 I1） */
  creditSuspendSkipped: number
}

export interface OrderExpireResult {
  scanned: number
  cancelled: number
  skipped: number
}

/**
 * order.reconcile：每日对账告警 + 账期超期自动暂停（§6.2/§10 "已收款必开通"
 * 兜底 + 合同账期补充规则）——
 * ① PAID 停留 > 1h（开通 worker 疑似丢任务/中途失败）；
 * ①' FULFILLING 停留 > 1h（终审 I2：worker 五连败耗尽 / credit.open 后
 *    enqueue 前崩溃的第二丢任务窗口；纯告警不动状态）；
 * ② CONTRACT_CREDIT PENDING 流水且订单 dueAt 已过（账期到期未收款确认）→ 告警；
 *    dueAt 已过超 N 天（env CREDIT_OVERDUE_SUSPEND_DAYS，缺省 7）且聚合判定
 *    org 无其他有效服务 → 暂停 org 全部 ACTIVE workspace（suspendReason='账期
 *    超期'，应收确认时恢复，终审 I1）。
 * 每条写 audit 'order.reconcile_alert'（diff.reason = PAID_STALLED /
 * FULFILLING_STALLED / CREDIT_OVERDUE）+ logger.warn 供日志告警通道采集
 * （遗留 B9：注入 logger，缺省 console）；
 * 暂停写 audit 'order.credit_overdue_suspended'。
 * 遗留 B5：各扫描循环逐单 try/catch——单条毒订单（audit/暂停写失败等）只告警
 * 计数不中断整批，循环尾汇总日志含失败数，次日 cron 自然重扫该批余量。
 */
export async function runOrderReconcile(ctx: BillingCronContext): Promise<OrderReconcileResult> {
  const { prisma } = ctx
  const audit = ctx.audit ?? createAuditService(prisma)
  const log: BillingCronLogger = ctx.logger ?? console
  const nowValue = (ctx.now ?? (() => new Date()))()

  const stalledBefore = new Date(nowValue.getTime() - PAID_STALLED_THRESHOLD_MS)
  // 遗留 E5：告警时钟改用 paidAt（确认收款时回填后基本不变）——updatedAt 会被
  // 订单后续更新（如备注修改）重置，导致停留告警时钟误刷新漏报。paidAt 可空，
  // 但 status='PAID' 隐含非空，null 不匹配 { lt } 天然排除（保守不另加判空）。
  const paidStalled = await prisma.order.findMany({
    where: { status: 'PAID', paidAt: { lt: stalledBefore } },
    orderBy: { paidAt: 'asc' },
    take: CRON_BATCH_LIMIT,
  })
  let paidStalledFailed = 0
  for (const order of paidStalled) {
    try {
      await audit.record({
        actorType: 'SYSTEM',
        action: 'order.reconcile_alert',
        organizationId: order.organizationId,
        target: `Order:${order.id}`,
        diff: {
          reason: 'PAID_STALLED',
          orderId: order.id,
          orderNo: order.orderNo,
          status: order.status,
          updatedAt: order.updatedAt instanceof Date ? order.updatedAt.toISOString() : null,
        },
      })
      log.warn(
        `[order.reconcile] 订单已收款但停留 PAID 超 1 小时（开通 worker 疑似丢任务）：orderId=${order.id}，orderNo=${order.orderNo}`,
      )
    } catch (err) {
      paidStalledFailed += 1
      log.error(
        `[order.reconcile] PAID 停留告警单条处理失败（跳过继续）：orderId=${order.id}`,
        err,
      )
    }
  }
  if (paidStalledFailed > 0) {
    log.warn(
      `[order.reconcile] PAID 停留告警批完成：扫描 ${paidStalled.length} 单，失败 ${paidStalledFailed} 单（已跳过）`,
    )
  }

  // 终审 I2：FULFILLING 停滞兜底——PAID 扫描盖不住的第二种丢任务窗口：
  // 开通 worker 五连败耗尽（pg-boss retryLimit=5 后 dead letter）或 credit.open
  // 迁移提交后 enqueue 前崩溃，订单停留 FULFILLING 且无任何推进。增查
  // "status=FULFILLING 且 updatedAt 停滞 >1h"（纯增查询，不动状态）。
  // 遗留 E1：含 SERVICE 行的订单在 P4 交付周期内合法停留 FULFILLING（此前每日
  // 误报噪音）——SERVICE 行的交付单（OrderItem 1:1 ServiceDelivery，开通 worker
  // 创建）全部已建 = 开通已推进、交付在途 → 跳过告警；任一交付单缺失（丢任务
  // 实锤）或无 SERVICE 行（纯订阅停滞）照旧告警。
  const fulfillingStalled = await prisma.order.findMany({
    where: { status: 'FULFILLING', updatedAt: { lt: stalledBefore } },
    orderBy: { updatedAt: 'asc' },
    take: CRON_BATCH_LIMIT,
    include: { items: { include: { serviceDelivery: { select: { id: true } } } } },
  })
  let fulfillingStalledFailed = 0
  let fulfillingAlerted = 0
  for (const order of fulfillingStalled) {
    // E1 豁免：SERVICE 行交付单建全 → 交付已在途，不构成停滞嫌疑（纯内存判定，
    // 无查询无失败面；无 SERVICE 行不过该闸照旧告警）
    const serviceItems = (order.items ?? []).filter((it) => {
      const snapshot = it.planSnapshot as { kind?: unknown } | null
      return snapshot?.kind === 'SERVICE'
    })
    if (serviceItems.length > 0 && serviceItems.every((it) => it.serviceDelivery != null)) {
      continue
    }
    try {
      await audit.record({
        actorType: 'SYSTEM',
        action: 'order.reconcile_alert',
        organizationId: order.organizationId,
        target: `Order:${order.id}`,
        diff: {
          reason: 'FULFILLING_STALLED',
          orderId: order.id,
          orderNo: order.orderNo,
          status: order.status,
          updatedAt: order.updatedAt instanceof Date ? order.updatedAt.toISOString() : null,
        },
      })
      log.warn(
        `[order.reconcile] 订单停留 FULFILLING 超 1 小时（开通 worker 疑似五连败耗尽 / 账期开通后投递前崩溃）：orderId=${order.id}，orderNo=${order.orderNo}`,
      )
      fulfillingAlerted += 1
    } catch (err) {
      fulfillingStalledFailed += 1
      log.error(
        `[order.reconcile] FULFILLING 停滞告警单条处理失败（跳过继续）：orderId=${order.id}`,
        err,
      )
    }
  }
  if (fulfillingStalledFailed > 0) {
    log.warn(
      `[order.reconcile] FULFILLING 停滞告警批完成：扫描 ${fulfillingStalled.length} 单，失败 ${fulfillingStalledFailed} 单（已跳过）`,
    )
  }

  const creditOverdue = await prisma.paymentTransaction.findMany({
    where: {
      method: 'CONTRACT_CREDIT',
      status: 'PENDING',
      order: { dueAt: { lt: nowValue } },
    },
    include: { order: true },
    take: CRON_BATCH_LIMIT,
  })

  // 终审 I1（规格 §6.2 合同账期补充规则）：dueAt 已过超 N 天自动暂停。
  // suspendOverdueBefore = now - N 天（严格 <：恰 N 天边界不暂停）
  const suspendDays = ctx.suspendDays ?? creditOverdueSuspendDays()
  const suspendOverdueBefore = new Date(nowValue.getTime() - suspendDays * DAY_MS)
  // E2：本 cron 扫到的全部超期应收订单 ID 集合——聚合判定的排除面（见下）
  const overdueOrderIds = new Set(creditOverdue.map((payment) => payment.orderId))

  /**
   * 聚合判定（照 subscription-service.runExpireCheck 的 orgStillServiced 模式）：
   * org 仍有"其他"有效服务则跳过暂停——非超期应收订单开通的 ACTIVE/GRACE
   * 订阅或进行中 ServiceDelivery。"企业受影响 Workspace"的受影响以聚合后无有效
   * 服务为前提（同任务 11 聚合判定语义）。
   * 遗留 E2（双超期互跳收紧）：排除面从"本逾期单 sourceOrderId"扩大为本 cron
   * 扫到的**全部超期应收订单**——同 org 两张均超期的账期单互构成"其他有效
   * 服务"会让双双跳过暂停；它们的开通本身就是待暂停对象，不计入豁免依据
   * （sourceOrderId 非空列，notIn 无 NULL 三值逻辑歧义）。进行中 ServiceDelivery
   * 照旧计入有效服务（交付在途不该停）。
   */
  async function orgStillServicedElsewhere(
    organizationId: string,
    overdueOrderIds: Set<string>,
  ): Promise<boolean> {
    const activeSub = await prisma.subscription.findFirst({
      where: {
        organizationId,
        sourceOrderId: { notIn: [...overdueOrderIds] },
        OR: [{ status: 'ACTIVE', endAt: { gt: nowValue } }, { status: 'GRACE' }],
      },
      select: { id: true },
    })
    if (activeSub) return true
    // ServiceDelivery 无 organizationId 列：经 workspace 关系 join（查询形状同
    // subscription-service / refund-service 的 orgStillServiced）
    const activeDelivery = await prisma.serviceDelivery.findFirst({
      where: {
        status: { in: [...ACTIVE_DELIVERY_STATUSES] },
        workspace: { organizationId },
      },
      select: { id: true },
    })
    return Boolean(activeDelivery)
  }

  let creditSuspended = 0
  let creditSuspendSkipped = 0
  let creditOverdueFailed = 0
  for (const payment of creditOverdue) {
    const order = payment.order
    try {
      await audit.record({
        actorType: 'SYSTEM',
        action: 'order.reconcile_alert',
        ...(order ? { organizationId: order.organizationId } : {}),
        target: order ? `Order:${order.id}` : `PaymentTransaction:${payment.id}`,
        diff: {
          reason: 'CREDIT_OVERDUE',
          orderId: order?.id ?? null,
          orderNo: order?.orderNo ?? null,
          paymentId: payment.id,
          dueAt: order?.dueAt instanceof Date ? order.dueAt.toISOString() : null,
        },
      })
      log.warn(
        `[order.reconcile] 合同账期已到期仍未收款确认：orderId=${order?.id ?? payment.orderId}，paymentId=${payment.id}`,
      )

      // 暂停闸：订单关系缺失（数据断链）或超期未满 N 天（含恰 N 天边界）→ 只告警
      const dueAt = order?.dueAt
      if (!order || !(dueAt instanceof Date) || dueAt.getTime() >= suspendOverdueBefore.getTime()) {
        continue
      }
      // 聚合判定：org 仍有其他有效服务 → 跳过（他单付费服务不应被本单欠款牵连）
      if (await orgStillServicedElsewhere(order.organizationId, overdueOrderIds)) {
        creditSuspendSkipped += 1
        continue
      }
      // 置 org 全部 ACTIVE workspace SUSPENDED（原因=账期超期，应收确认时按此
      // 精确恢复，Ruling 4——order-service.confirmPayment CONTRACT_CREDIT 分支）。
      // 幂等：只圈 ACTIVE，重复 run 对已暂停行自然命中 0；手动/其他原因暂停的不动
      const suspended = await prisma.workspace.updateMany({
        where: { organizationId: order.organizationId, status: 'ACTIVE' },
        data: { status: 'SUSPENDED', suspendReason: CREDIT_OVERDUE_SUSPEND_REASON },
      })
      creditSuspended += suspended.count
      await audit.record({
        actorType: 'SYSTEM',
        action: 'order.credit_overdue_suspended',
        organizationId: order.organizationId,
        target: `Order:${order.id}`,
        diff: {
          orderId: order.id,
          orderNo: order.orderNo,
          paymentId: payment.id,
          dueAt: dueAt.toISOString(),
          suspendDays,
          workspacesSuspended: suspended.count,
        },
      })
      log.warn(
        `[order.reconcile] 账期超期 ${suspendDays} 天，自动暂停企业 ACTIVE workspace：` +
          `orderId=${order.id}，workspaces=${suspended.count}（应收确认后自动恢复）`,
      )
    } catch (err) {
      creditOverdueFailed += 1
      log.error(
        `[order.reconcile] 账期超期单条处理失败（跳过继续）：paymentId=${payment.id}`,
        err,
      )
    }
  }
  if (creditOverdueFailed > 0) {
    log.warn(
      `[order.reconcile] 账期超期批完成：扫描 ${creditOverdue.length} 单，失败 ${creditOverdueFailed} 单（已跳过）`,
    )
  }

  return {
    paidStalled: paidStalled.length,
    // E1 豁免后按"实际告警数"计（豁免单不计——见字段注释"告警数"语义）
    fulfillingStalled: fulfillingAlerted,
    creditOverdue: creditOverdue.length,
    creditSuspended,
    creditSuspendSkipped,
  }
}

/**
 * order.expire：PENDING_PAYMENT 且创建超 7 天 → transition 'cancel'（note=超时
 * 自动取消）。OrderTransitionError 忽略（扫描后已支付/已取消的并发竞态）。
 * 遗留 B5：其余错误不再上抛中断整批——逐单 try/catch，单条失败（毒订单）
 * 告警计数后继续下一条，循环尾汇总日志含失败数（此前毒订单每日阻塞其余）。
 * 成功取消写 audit 'order.expire_cancelled'。
 */
export async function runOrderExpire(ctx: BillingCronContext): Promise<OrderExpireResult> {
  const { prisma, orders } = ctx
  const audit = ctx.audit ?? createAuditService(prisma)
  const log: BillingCronLogger = ctx.logger ?? console
  const nowValue = (ctx.now ?? (() => new Date()))()

  const expiredBefore = new Date(nowValue.getTime() - ORDER_EXPIRE_THRESHOLD_MS)
  const stale = await prisma.order.findMany({
    where: { status: 'PENDING_PAYMENT', createdAt: { lt: expiredBefore } },
    orderBy: { createdAt: 'asc' },
    take: CRON_BATCH_LIMIT,
  })

  let cancelled = 0
  let skipped = 0
  let failed = 0
  for (const order of stale) {
    try {
      await orders.transition(order.id, 'cancel', { note: ORDER_EXPIRE_NOTE })
      await audit.record({
        actorType: 'SYSTEM',
        action: 'order.expire_cancelled',
        organizationId: order.organizationId,
        target: `Order:${order.id}`,
        diff: {
          orderId: order.id,
          orderNo: order.orderNo,
          createdAt: order.createdAt instanceof Date ? order.createdAt.toISOString() : null,
          note: ORDER_EXPIRE_NOTE,
        },
      })
      cancelled += 1
    } catch (err) {
      if (err instanceof OrderTransitionError) {
        // 已取消 / 扫描后已支付的并发竞态：忽略，不写 audit
        skipped += 1
        continue
      }
      // 遗留 B5：毒订单（transition 非竞态失败）不阻塞批内其余——告警后继续
      failed += 1
      log.error(
        `[order.expire] 超时取消单条失败（跳过继续）：orderId=${order.id}`,
        err,
      )
    }
  }
  if (failed > 0) {
    log.warn(
      `[order.expire] 超时取消批完成：扫描 ${stale.length}，取消 ${cancelled}，并发跳过 ${skipped}，失败 ${failed}（已跳过，次日重扫）`,
    )
  }
  return { scanned: stale.length, cancelled, skipped }
}

/** 装配：注册两个每日 cron（模式同 server.ts session.purge 块） */
export async function startBillingCrons(deps: BillingCronsDeps): Promise<void> {
  const { boss, ...ctx } = deps
  // 遗留 B9：handler 汇总/异常日志走注入 logger（server 传 fastify.log），缺省 console
  const log: BillingCronLogger = ctx.logger ?? console

  await boss.createQueue(BILLING_CRON_QUEUES.reconcile)
  await boss.schedule(BILLING_CRON_QUEUES.reconcile, ORDER_RECONCILE_CRON, {})
  await boss.work(BILLING_CRON_QUEUES.reconcile, async () => {
    try {
      const result = await runOrderReconcile(ctx)
      if (
        result.paidStalled > 0 ||
        result.fulfillingStalled > 0 ||
        result.creditOverdue > 0 ||
        result.creditSuspended > 0 ||
        result.creditSuspendSkipped > 0
      ) {
        log.warn(
          `[order.reconcile] 对账完成：PAID 停留告警 ${result.paidStalled} 单，` +
            `FULFILLING 停滞告警 ${result.fulfillingStalled} 单，` +
            `账期超期告警 ${result.creditOverdue} 单` +
            `（自动暂停 ${result.creditSuspended} 个 workspace，聚合判定跳过 ${result.creditSuspendSkipped} 单）`,
        )
      }
    } catch (err) {
      // 对账失败不影响服务：下次 cron 重试
      log.error('[order.reconcile] 订单对账失败（忽略，等待下次调度）', err)
    }
  })

  await boss.createQueue(BILLING_CRON_QUEUES.expire)
  await boss.schedule(BILLING_CRON_QUEUES.expire, ORDER_EXPIRE_CRON, {})
  await boss.work(BILLING_CRON_QUEUES.expire, async () => {
    try {
      const result = await runOrderExpire(ctx)
      if (result.cancelled > 0 || result.skipped > 0) {
        log.info(
          `[order.expire] 超时取消完成：扫描 ${result.scanned}，取消 ${result.cancelled}，并发跳过 ${result.skipped}`,
        )
      }
    } catch (err) {
      log.error('[order.expire] 订单超时取消失败（忽略，等待下次调度）', err)
    }
  })

  // 任务 11：订阅到期检查（提醒/入宽限/宽限满暂停 workspace）——薄壳调
  // subscription-service.runExpireCheck，主体逻辑与测试都在 platform 层
  await boss.createQueue(BILLING_CRON_QUEUES.expireCheck)
  await boss.schedule(BILLING_CRON_QUEUES.expireCheck, SUBSCRIPTION_EXPIRE_CHECK_CRON, {})
  await boss.work(BILLING_CRON_QUEUES.expireCheck, async () => {
    try {
      const result = await runExpireCheck(ctx)
      if (
        result.reminded > 0 ||
        result.enteredGrace > 0 ||
        result.expired > 0 ||
        result.graceSkipped > 0 ||
        result.expiredSkipped > 0 ||
        result.expiredOrgStillActive > 0 ||
        result.orphanRestored > 0
      ) {
        log.info(
          `[subscription.expire-check] 到期检查完成：提醒 ${result.reminded}，` +
            `入宽限 ${result.enteredGrace}（并发跳过 ${result.graceSkipped}），` +
            `宽限满过期 ${result.expired}（org 仍有效未暂停 ${result.expiredOrgStillActive}，` +
            `并发跳过 ${result.expiredSkipped}），孤儿恢复 ${result.orphanRestored}`,
        )
      }
    } catch (err) {
      log.error('[subscription.expire-check] 订阅到期检查失败（忽略，等待下次调度）', err)
    }
  })
}
