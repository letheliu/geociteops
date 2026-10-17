import type PgBoss from 'pg-boss'
import type { Prisma, PrismaClient } from '@prisma/client'
import { createAuditService } from '../platform/audit/service.js'
import type { AuditService } from '../platform/audit/service.js'
import type { EntitlementService } from '../platform/billing/entitlement-service.js'
import { CAPACITY_FIELDS } from '../platform/billing/entitlement-merge.js'
import { SUBSCRIPTION_EXPIRED_SUSPEND_REASON } from '../platform/billing/subscription-service.js'
import {
  createOrderService,
  OrderTransitionError,
  ORDER_ACTIVATION_QUEUE,
  type OrderPlanSnapshot,
  type OrderService,
} from '../platform/commerce/order-service.js'

// ---------------------------------------------------------------------------
// 订单开通 worker（任务 8）：消费 order.activate 队列，开通 → 配额重算。
// 全局约束"开通一律异步 worker 幂等可重试"由两道闸保证：
//   1. 入口状态闸：activate.start（PAID→FULFILLING，乐观并发唯一赢家）；
//      已是 FULFILLING 放行（账期 credit.open 先迁移后入队 / 崩溃重入），
//      其它状态 = 已处理直接返回；
//   2. 数据幂等锚：本单 Subscription 锚行（@@unique([sourceOrderId, planId])）
//      先行检查 + create P2002 跳过 / ServiceDelivery.orderItemId unique。
// 投递侧（order-service.enqueueOrderActivation）带 retryLimit=5/retryDelay=30，
// worker 抛错由 pg-boss 重试；残余丢任务窗口由 billing-crons.ts 的
// order.reconcile 每日告警兜底。
// ---------------------------------------------------------------------------

/**
 * 续费恢复的暂停原因：仅因"订阅到期"暂停的 workspace 在续费开通时恢复。
 * 单一来源移至 platform/billing/subscription-service.ts（任务 11 的
 * expire-check 写入与这里的恢复匹配共用一字面量，防两处漂移后恢复失联）；
 * 此处 re-export 保持既有导入路径不变。
 */
export { SUBSCRIPTION_EXPIRED_SUSPEND_REASON }

/**
 * 续费延长幂等标记事件名（OrderEvent.event，修复轮 2）：
 * 续费复用分支对 endAt 的延长是 update 操作、无 unique 锚可依——本单已写过
 * 该事件 = 延长已应用，重入（投递侧 retryLimit=5 会放大非幂等重入）直接跳过，
 * 防 endAt 二次延长（资金方向）。仅用于续费复用路径；新购路径有
 * @@unique([sourceOrderId, planId]) 锚，不写此标记。
 * 遗留 A3 根治：迁移 <20261015…>_tob_p2_order_event_extend_unique 为
 * (orderId, event='subscription.extend') 建部分唯一索引——查询闸（先查后写）
 * 的并发窗口由数据库兜底，双写第二次 P2002 → 视为已标记跳过。
 */
export const SUBSCRIPTION_EXTEND_MARKER_EVENT = 'subscription.extend'

/** prisma P2002（unique 冲突）鸭型判定：不引运行时 Prisma 命名空间，mock 与真实驱动通吃 */
function isPrismaUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === 'P2002'
}

/** 读取行项快照（异常形态防御归一为空对象，kind 等字段按需判空） */
function readSnapshot(item: { planSnapshot: unknown }): Partial<OrderPlanSnapshot> {
  return (item.planSnapshot ?? {}) as Partial<OrderPlanSnapshot>
}

/**
 * 钳制加月：先落到目标月 1 号再回钳原日——1/31 + 1mo = 2/28，
 * 而非 Date.setMonth 裸加的跳月语义（1/31 setMonth(+1) 会得到 3/3）。
 * 遗留 B6：全 UTC 系方法（get/setUTCDate/Month）——本地时间方法在 DST 时区
 * 会让 endAt 漂移 1h（月初/月末边界甚至漂一天）；服务器时区无关化。
 * 手写而不是引 dayjs：语义自持、零新依赖，且钳制规则（保月末）显式可测。
 */
export function addMonthsClamped(from: Date, months: number): Date {
  const day = from.getUTCDate()
  const probe = new Date(from.getTime())
  probe.setUTCDate(1)
  probe.setUTCMonth(probe.getUTCMonth() + months)
  // 目标月天数：下月 0 号 = 目标月最后一天（UTC 构造）
  const daysInTargetMonth = new Date(
    Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth() + 1, 0),
  ).getUTCDate()
  probe.setUTCDate(Math.min(day, daysInTargetMonth))
  return probe
}

/**
 * 加计费周期：MONTH → +1 月、YEAR → +1 年（均走月末钳制）。
 * 周期缺失/null 视为 MONTH（防御：下单侧 SUBSCRIPTION 快照理论上恒有周期）。
 */
export function addBillingPeriod(from: Date, period: string | null | undefined): Date {
  return addMonthsClamped(from, period === 'YEAR' ? 12 : 1)
}

/**
 * SERVICE 交付里程碑初始态：deliverables 模板（数组）逐项附 status='PENDING'；
 * 非数组形态（null/字符串等异常快照）防御性归一为空数组。
 */
export function initialMilestones(deliverables: unknown): Prisma.InputJsonValue {
  if (!Array.isArray(deliverables)) return []
  return deliverables.map((entry) => {
    const base =
      typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>)
        : { name: String(entry) }
    return { ...base, status: 'PENDING' }
  }) as Prisma.InputJsonValue
}

/** 开通流程读取到的订单视图（prisma include items 的结构子集） */
interface OrderLike {
  id: string
  organizationId: string
  items: ItemLike[]
}

interface ItemLike {
  id: string
  planId: string
  workspaceId: string | null
  /** 行项数量（终审 C1：下单侧已保证 SUBSCRIPTION/SERVICE 恒 1，ADDON ≥1） */
  quantity: number
  planSnapshot: unknown
}

export interface OrderActivateContext {
  prisma: PrismaClient
  /** 配额重算（任务 7 entitlement service；worker 末步统一调用） */
  entitlements: Pick<EntitlementService, 'recompute'>
  /** 审计（worker 场景 actorType='SYSTEM'）；缺省用 prisma 自建 */
  audit?: AuditService
  /** 订单服务（transition 状态闸）；缺省用 prisma 自建 */
  orders?: Pick<OrderService, 'transition'>
  /** 时钟注入，缺省系统时间 */
  now?: () => Date
}

export interface OrderActivateWorkerDeps extends OrderActivateContext {
  boss: PgBoss
}

export interface OrderActivateWorker {
  /**
   * 开通订单（幂等可重试）：
   * ① 入口闸（activate.start PAID→FULFILLING；FULFILLING 直接放行——账期订单
   *    credit.open 先迁移后入队 / 崩溃重入，行项幂等锚保证不重复；其它状态 =
   *    已处理返回）→ ② 确保首个 workspace → ③ 逐行项开通（订阅/交付单/加购）→
   * ④ 无 SERVICE 行则 fulfill.complete → ⑤ 配额重算。
   * 返回 activated=false（reason='already_processed'）= 订单已处理/非可开通状态，无副作用。
   */
  activateOrder(orderId: string): Promise<{ activated: boolean; reason?: 'already_processed' }>
}

export function createOrderActivateWorker(ctx: OrderActivateContext): OrderActivateWorker {
  const { prisma, entitlements } = ctx
  const audit = ctx.audit ?? createAuditService(prisma)
  const orders = ctx.orders ?? createOrderService({ prisma })
  const now = ctx.now ?? (() => new Date())

  /** SUBSCRIPTION：本单锚行已存在则跳过（崩溃重入不二次延长）；org+plan 有
   *  ACTIVE/GRACE/EXPIRED 行则复用延长（续费，subscription.extend 标记闸 +
   *  同事务原子提交）；否则新建（unique 锚兜底） */
  async function activateSubscription(
    order: OrderLike,
    item: ItemLike,
    snapshot: Partial<OrderPlanSnapshot>,
    nowValue: Date,
  ): Promise<void> {
    // 锚先行：@@unique([sourceOrderId, planId]) 对应行已存在 = 本单该行项
    // 已处理（账期/崩溃重入），直接跳过——不延长、不重复恢复 workspace
    const anchored = await prisma.subscription.findFirst({
      where: { sourceOrderId: order.id, planId: item.planId },
    })
    if (anchored) return

    const existing = await prisma.subscription.findFirst({
      where: {
        organizationId: order.organizationId,
        planId: item.planId,
        status: { in: ['ACTIVE', 'GRACE', 'EXPIRED'] },
      },
      orderBy: [{ endAt: 'desc' }],
    })

    if (existing) {
      // 续费恢复先行：updateMany 按 suspendReason 精确匹配，重入重放幂等无害；
      // 若放在延长闸之后，"延长已提交、恢复未跑"的崩窗会被标记闸永久拦掉
      await prisma.workspace.updateMany({
        where: {
          organizationId: order.organizationId,
          status: 'SUSPENDED',
          suspendReason: SUBSCRIPTION_EXPIRED_SUSPEND_REASON,
        },
        data: { status: 'ACTIVE', suspendReason: null },
      })

      // 延长幂等标记闸（快速路径）：本单已写 subscription.extend 事件 = 延长已应用，跳过。
      // 根治（遗留 A3）：查询闸是"先查后写"，极端并发（双 worker 同时过查询闸）可双写
      // 标记、双延长 endAt——迁移 <20261015…>_tob_p2_order_event_extend_unique 给
      // OrderEvent(orderId, event) 加了 WHERE event='subscription.extend' 的部分唯一
      // 索引：并发对端的 create 先占索引，本侧 create 抛 P2002 → 下方 catch 兜底
      const marker = await prisma.orderEvent.findFirst({
        where: { orderId: order.id, event: SUBSCRIPTION_EXTEND_MARKER_EVENT },
      })
      if (marker) return

      // 复用续费：endAt = max(now, 原 endAt) + 周期（未到期顺延续期；GRACE/EXPIRED 从当下起算）
      const base =
        existing.endAt.getTime() > nowValue.getTime() ? existing.endAt : nowValue
      const newEndAt = addBillingPeriod(base, snapshot.billingPeriod)
      // 延长 + 标记同事务原子提交：崩窗不留"已延长无标记"（重入二次延长）或
      // "有标记未延长"（永久漏延长）的半状态（修复轮 2，资金方向闭环）。
      // P2002 = 并发对端已提交标记（其延长同事务已生效）——事务整体回滚后
      // 视为已标记跳过：两侧从事同一前象计算 newEndAt，对端生效即本单已延长
      try {
        await prisma.$transaction(async (tx) => {
          await tx.subscription.update({
            where: { id: existing.id },
            data: {
              status: 'ACTIVE',
              endAt: newEndAt,
            },
          })
          await tx.orderEvent.create({
            data: {
              orderId: order.id,
              event: SUBSCRIPTION_EXTEND_MARKER_EVENT,
              fromStatus: null,
              toStatus: 'FULFILLING',
              actorId: null,
              note:
                `续费延长：planId=${item.planId}，` +
                `endAt=${existing.endAt.toISOString()}→${newEndAt.toISOString()}` +
                `（周期 ${snapshot.billingPeriod ?? 'MONTH(默认)'}）`,
            },
          })
        })
      } catch (err) {
        // 唯一索引兜底（遗留 A3）：标记事件 (orderId, event) 部分唯一冲突 =
        // 并发对端已延长并提交——本次事务（含 subscription.update）已回滚，
        // 跳过即幂等，不重抛（重试只会再撞同一索引）
        if (isPrismaUniqueConstraintViolation(err)) return
        throw err
      }
      return
    }

    // 新建：startAt=now、endAt=now+周期、entitlements=快照（含周期缺失按月防御）
    try {
      await prisma.subscription.create({
        data: {
          organizationId: order.organizationId,
          planId: item.planId,
          sourceOrderId: order.id,
          startAt: nowValue,
          endAt: addBillingPeriod(nowValue, snapshot.billingPeriod),
          status: 'ACTIVE',
          entitlements: (snapshot.entitlements ?? {}) as Prisma.InputJsonValue,
        },
      })
    } catch (err) {
      // 幂等锚第二闸：@@unique([sourceOrderId, planId]) 冲突 = 已处理，跳过
      if (isPrismaUniqueConstraintViolation(err)) return
      throw err
    }
  }

  /**
   * ADDON 快照数值容量 ×quantity（终审 C1）：加购"买 N 份"的交付语义体现在
   * entitlements 数值容量里——CAPACITY_FIELDS 逐字段 ×N 落库（§6.4 合并时有效
   * ADDON 在订阅基数上求和叠加，N 份容量自然翻倍）；allowedPlatforms 等集合/
   * 非数值字段不乘（平台集合仅来自订阅，规格 §6.4）；保持 Subscription 单行锚
   * [sourceOrderId, planId] 不变（幂等锚不因数量拆行）。quantity 非正整数
   * （历史脏数据防御）归 1。
   */
  function scaleAddonEntitlements(entitlements: unknown, quantity: number): Prisma.InputJsonValue {
    const qty = Number.isInteger(quantity) && quantity >= 1 ? quantity : 1
    const source: Record<string, unknown> =
      entitlements && typeof entitlements === 'object' && !Array.isArray(entitlements)
        ? { ...(entitlements as Record<string, unknown>) }
        : {}
    for (const field of CAPACITY_FIELDS) {
      const value = source[field]
      if (typeof value === 'number' && Number.isFinite(value)) {
        source[field] = value * qty
      }
    }
    return source as Prisma.InputJsonValue
  }

  /** ADDON：增量 Subscription 行——有周期按周期、无周期 +1 年（同 unique 锚幂等） */
  async function activateAddon(
    order: OrderLike,
    item: ItemLike,
    snapshot: Partial<OrderPlanSnapshot>,
    nowValue: Date,
  ): Promise<void> {
    const endAt = snapshot.billingPeriod
      ? addBillingPeriod(nowValue, snapshot.billingPeriod)
      : addMonthsClamped(nowValue, 12)
    try {
      await prisma.subscription.create({
        data: {
          organizationId: order.organizationId,
          planId: item.planId,
          sourceOrderId: order.id,
          startAt: nowValue,
          endAt,
          status: 'ACTIVE',
          // quantity 语义在 entitlements 数值里体现（终审 C1：容量 ×N，平台集合不乘）
          entitlements: scaleAddonEntitlements(snapshot.entitlements, item.quantity),
        },
      })
    } catch (err) {
      if (isPrismaUniqueConstraintViolation(err)) return
      throw err
    }
  }

  /** SERVICE 交付单的 workspace 归属：item 指定 > org 第一个 ACTIVE > null（P4 分配） */
  async function resolveServiceWorkspaceId(order: OrderLike, item: ItemLike): Promise<string | null> {
    if (item.workspaceId) return item.workspaceId
    const first = await prisma.workspace.findFirst({
      where: { organizationId: order.organizationId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    return first?.id ?? null
  }

  /** SERVICE：建交付单（PENDING_ASSIGN + 里程碑初始态）并写 audit 通知运营 */
  async function activateServiceDelivery(
    order: OrderLike,
    item: ItemLike,
    snapshot: Partial<OrderPlanSnapshot>,
  ): Promise<void> {
    const workspaceId = await resolveServiceWorkspaceId(order, item)
    try {
      await prisma.serviceDelivery.create({
        data: {
          orderItemId: item.id,
          workspaceId,
          status: 'PENDING_ASSIGN',
          milestones: initialMilestones(snapshot.deliverables),
        },
      })
    } catch (err) {
      // 幂等锚：orderItemId unique 冲突 = 交付单已建，跳过（audit 不重复写）
      if (isPrismaUniqueConstraintViolation(err)) return
      throw err
    }
    await audit.record({
      actorType: 'SYSTEM',
      action: 'delivery.pending_assignment',
      organizationId: order.organizationId,
      ...(workspaceId ? { workspaceId } : {}),
      target: `OrderItem:${item.id}`,
      diff: {
        orderId: order.id,
        orderItemId: item.id,
        workspaceId,
        planName: snapshot.name ?? null,
      },
    })
  }

  /**
   * 企业无任何 workspace 且订单含 SUBSCRIPTION/ADDON → 自动创建首个（§6.4）。
   * worker 直建（prisma.workspace.create）而非走 workspace-admin 路由链路——
   * 控制者裁定：避免 guard 顺序耦合；name/defaultBrandName 取 org.name。
   * 位于行项处理之前（任务 8 修复轮）：SERVICE 交付单解析归属时才能命中
   * 首个 workspace（否则 null 且此后无人回填）；recompute 保持在行项之后。
   */
  async function ensureFirstWorkspace(order: OrderLike): Promise<void> {
    const needsWorkspace = order.items.some((item) => {
      const kind = readSnapshot(item).kind
      return kind === 'SUBSCRIPTION' || kind === 'ADDON'
    })
    if (!needsWorkspace) return

    const existing = await prisma.workspace.findFirst({
      where: { organizationId: order.organizationId },
      select: { id: true },
    })
    if (existing) return

    const org = await prisma.organization.findUnique({
      where: { id: order.organizationId },
      select: { name: true },
    })
    const name = org?.name ?? '默认工作区'
    const workspace = await prisma.workspace.create({
      data: { name, defaultBrandName: name, organizationId: order.organizationId },
    })
    await audit.record({
      actorType: 'SYSTEM',
      action: 'workspace.create',
      organizationId: order.organizationId,
      workspaceId: workspace.id,
      target: `Workspace:${workspace.id}`,
      diff: {
        name,
        organizationId: order.organizationId,
        orderId: order.id,
        reason: '订单开通自动创建（企业此前无工作区）',
      },
    })
  }

  return {
    async activateOrder(orderId) {
      // 入口闸：activate.start（PAID→FULFILLING，updateMany 乐观并发唯一赢家）。
      // 被拒后按当前状态分流：
      // - FULFILLING → 放行继续行项流程。两个入口：账期订单（openOnCredit 的
      //   credit.open 先迁移 FULFILLING 再投递本队列）与崩溃重入（首跑已迁移、
      //   行项未跑完）——行项幂等锚（本单锚行 / unique 冲突跳过）保证不重复。
      // - 其它状态（COMPLETED/CANCELLED/REFUNDED…）= 已处理/不可开通，直接返回。
      try {
        await orders.transition(orderId, 'activate.start')
      } catch (err) {
        if (!(err instanceof OrderTransitionError)) throw err
        const current = await prisma.order.findUnique({
          where: { id: orderId },
          select: { status: true },
        })
        if (current?.status !== 'FULFILLING') {
          return { activated: false, reason: 'already_processed' as const }
        }
      }

      const order = (await prisma.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      })) as (OrderLike & Record<string, unknown>) | null
      if (!order) return { activated: false } // 防御（transition 已保证存在）

      const nowValue = now()

      // 首个 workspace 确保在行项处理之前：混合订单（SUB+SERVICE）首购企业
      // 先建 workspace，SERVICE 交付单解析归属时才能命中（否则 null 且此后
      // 无人回填）。recompute 保持在行项之后（先落订阅行再算配额）。
      await ensureFirstWorkspace(order)

      let hasServiceItem = false
      for (const item of order.items) {
        const snapshot = readSnapshot(item)
        if (snapshot.kind === 'SUBSCRIPTION') {
          await activateSubscription(order, item, snapshot, nowValue)
        } else if (snapshot.kind === 'ADDON') {
          await activateAddon(order, item, snapshot, nowValue)
        } else if (snapshot.kind === 'SERVICE') {
          hasServiceItem = true
          await activateServiceDelivery(order, item, snapshot)
        }
        // 未知 kind：跳过（快照固化自枚举，防御分支）
      }

      // 无 SERVICE 行：全自动交付完成（"订阅立即生效"，§6.2）；含 SERVICE 停留
      // FULFILLING（P4 里程碑验收后 complete）。并发下另一 worker 已完成 → 忽略。
      if (!hasServiceItem) {
        try {
          await orders.transition(orderId, 'fulfill.complete', {
            note: '订阅/加购开通完成（无服务交付项）',
          })
        } catch (err) {
          if (!(err instanceof OrderTransitionError)) throw err
        }
      }

      // 配额重算：订阅/加购行已落库后的统一出口（§6.4）
      await entitlements.recompute(order.organizationId)
      return { activated: true }
    },
  }
}

/** 装配：建队（幂等）+ 注册 order.activate 消费者（boss.work） */
export async function startOrderActivateWorker(deps: OrderActivateWorkerDeps): Promise<OrderActivateWorker> {
  const { boss } = deps
  const worker = createOrderActivateWorker(deps)
  await boss.createQueue(ORDER_ACTIVATION_QUEUE)
  await boss.work(ORDER_ACTIVATION_QUEUE, async ([job]) => {
    if (!job?.data) return
    const { orderId } = job.data as { orderId: string }
    // 抛错交给 pg-boss 重试（投递侧 retryLimit=5/retryDelay=30，任务 8 修复轮）：
    // 全流程幂等（入口闸 + 唯一锚），重试无重复副作用
    await worker.activateOrder(orderId)
  })
  return worker
}
