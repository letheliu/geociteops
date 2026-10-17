import type {
  Order,
  OrderEvent,
  PaymentMethod,
  PaymentTransaction,
  Prisma,
  PrismaClient,
  RefundStatus,
  RefundTransaction,
} from '@prisma/client'
import type { AuditService } from '../audit/service.js'
import type { EntitlementService } from '../billing/entitlement-service.js'
import { CAPACITY_FIELDS } from '../billing/entitlement-merge.js'
import {
  orgStillServiced,
  SUBSCRIPTION_EXPIRED_SUSPEND_REASON,
} from '../billing/subscription-service.js'
import {
  ORDER_TRANSITIONS,
  OrderTransitionError,
  OrderNotFoundError,
  PaymentNotFoundError,
  transitionRejected,
} from './order-service.js'
import type { OrderEventName, OrderService } from './order-service.js'
import { createChannelRegistry } from './payment/channel.js'
import type { PaymentChannel } from './payment/channel.js'

// ---------------------------------------------------------------------------
// 退款服务（任务 12，规格 §6.2 退款分支 + Ruling 5/6/12）：
//   request（客户申请）→ approve（财务执行，线上渠道退款 / 线下登记）
//   → reject（财务驳回，回退状态由 OrderEvent 解析）。
// proration：SUBSCRIPTION 类按未消耗天数四舍五入到分（§6.2）；
// 配额回收：部分退款按比例 Math.floor 缩减订阅数值字段（Ruling 6），
// 全额退款订阅 EXPIRED + 聚合判定后暂停 workspace（照任务 11 语义）。
// ---------------------------------------------------------------------------

/** 一天毫秒数（proration 未消耗天数换算） */
export const DAY_MS = 86_400_000

/** 退款流水不存在：name 固定为 REFUND_NOT_FOUND（router 映射 404） */
export class RefundNotFoundError extends Error {
  constructor(refundId: string) {
    super(`退款流水不存在：${refundId}`)
    this.name = 'REFUND_NOT_FOUND'
  }
}

/** 退款金额非法 / 超可退上限（含并发退款后上限递减）：name 固定为 REFUND_AMOUNT_EXCEEDED */
export class RefundAmountExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'REFUND_AMOUNT_EXCEEDED'
  }
}

/** 退款流水状态不允许该操作（非 PENDING 审批/驳回、竞态条件更新失闸）：name 固定为 REFUND_STATE */
export class RefundStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'REFUND_STATE'
  }
}

/** 线上重复执行（已 EXECUTED 再 approve）：name 固定为 REFUND_ALREADY_EXECUTED */
export class RefundAlreadyExecutedError extends Error {
  constructor(refundId: string) {
    super(`退款已执行，拒绝重复执行：refundId=${refundId}（channelRefundNo 幂等锚已落库）`)
    this.name = 'REFUND_ALREADY_EXECUTED'
  }
}

/**
 * 原支付流水未成功收款，不可执行退款（终审 I3 裁定：统一校验原流水
 * status === 'SUCCEEDED'——WECHAT/ALIPAY/BANK_TRANSFER/CONTRACT_CREDIT 一致）：
 * name 固定为 REFUND_NOT_PAID（router 映射 BAD_REQUEST）。
 */
export class RefundNotPaidError extends Error {
  constructor(paymentId: string, status: string) {
    super(
      `原支付流水未成功收款，不可执行退款：paymentId=${paymentId}，status=${status}` +
        '（账期订单款项未到账，不可退款，请走撤销/商务处理）',
    )
    this.name = 'REFUND_NOT_PAID'
  }
}

/** proration 计算入参：订单标量字段子集（list/get/approve 各调用点同构可得） */
export type RefundableOrder = Pick<Order, 'id' | 'payableCents' | 'refundedCents'>

/**
 * P2002 是否命中 channelRefundNo @unique（遗留 A5）：meta.target 为字段数组
 * 或约束名字符串（驱动版本差异），两者都查含 channelRefundNo。鸭型判定
 * 不引运行时 Prisma 命名空间（mock 与真实驱动通吃）。
 */
function isChannelRefundNoConflict(err: unknown): boolean {
  if (!(err instanceof Error) || (err as { code?: unknown }).code !== 'P2002') return false
  const target = (err as { meta?: { target?: unknown } }).meta?.target
  if (Array.isArray(target)) return target.some((t) => String(t).includes('channelRefundNo'))
  return typeof target === 'string' ? target.includes('channelRefundNo') : false
}

/** calcRefundable 的查询端：prisma 全客户端或事务 tx（approve 锁内读走 tx 保持同事务视图） */
type RefundCalcDb = Pick<Prisma.TransactionClient, 'orderItem' | 'subscription'>

/** 行锁查询（SELECT ... FOR UPDATE RefundTransaction）的返回行形状 */
interface LockedRefundRow {
  id: string
  status: RefundStatus
}

export interface RefundRequestInput {
  /** 申请原因（透传 OrderEvent.note 与流水 reason） */
  reason?: string
  /** 申请金额（分）；缺省 = 全额可退额（calcRefundable） */
  amountCents?: number
}

export interface RefundApproveInput {
  /** 实际执行金额（分）；缺省 = 申请额。财务可在上限内酌减 */
  executeAmountCents?: number
}

export interface RefundRequestResult {
  event: OrderEvent
  refund: RefundTransaction
  /** 申请时刻的全额可退额（前端展示 + 审计） */
  refundableCents: number
}

export interface RefundApproveResult {
  event: OrderEvent
  refund: RefundTransaction
  orderId: string
  organizationId: string
  executeAmountCents: number
  /** 执行额 = 当前可退上限 → 全额（流水 REFUNDED + 订阅过期 + 暂停判定） */
  full: boolean
  /** 线上渠道（WECHAT/ALIPAY）走渠道退款；线下（转账/账期）为线下打款登记 */
  online: boolean
  /** 全额路径因聚合判定实际暂停的 workspace 数（部分退款恒 0） */
  workspaceSuspended: number
}

export interface RefundRejectResult {
  event: OrderEvent
  refund: RefundTransaction
  orderId: string
  organizationId: string
}

export interface RefundServiceDeps {
  prisma: PrismaClient
  /** 订单状态机（transition 带 extraWrites：迁移 + 退款写一个原子事务） */
  orders: Pick<OrderService, 'transition'>
  /** 线上支付渠道工厂；缺省 createChannelRegistry()（mock fail-closed，同 order-service） */
  channelResolver?: (method: PaymentMethod) => PaymentChannel
  /** 配额重算（执行后回收生效）；必注入 */
  entitlements: Pick<EntitlementService, 'recompute'>
  /** 审计（refund.request/approve/reject 三动作，服务层单一来源） */
  audit: AuditService
  /** 时钟注入（proration / executedAt），缺省系统时间 */
  now?: () => Date
}

export interface RefundService {
  /** 客户申请退款：状态分流（PARTIALLY_REFUNDED → refund.reopen，否则 refund.request）+ 同事务建 PENDING 流水 */
  request(orderId: string, input: RefundRequestInput, actorId: string): Promise<RefundRequestResult>
  /** 全额可退额（proration / 上限，§6.2 + Ruling 5）：admin.refunds.list 建议金额同源 */
  calcRefundable(order: RefundableOrder): Promise<number>
  /** 财务审批执行（行锁串行化：SELECT ... FOR UPDATE 锁流水行贯穿 pre-check / 渠道退款 / 全部写，防并发双发渠道退款） */
  approve(refundId: string, input: RefundApproveInput, actorId: string): Promise<RefundApproveResult>
  /** 财务驳回：流水 REJECTED + refund.reject 回退申请前状态（Ruling 12）。全程内联
   *  单事务，锁序与 approve 一致（RefundTransaction → Order，遗留 A6）——防并发
   *  approve+reject 的死锁环（原经 orders.transition 为 Order → RefundTransaction 反序） */
  reject(refundId: string, reason: string, actorId: string): Promise<RefundRejectResult>
}

/** planSnapshot.kind 容错读取（JsonValue → string | null） */
function snapshotKind(snapshot: Prisma.JsonValue): string | null {
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    const kind = (snapshot as { kind?: unknown }).kind
    if (typeof kind === 'string') return kind
  }
  return null
}

/**
 * entitlements Json → Record 容错投影（null/非对象按空对象）
 */
function asRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  return {}
}

/**
 * 退款服务：申请 / proration / 审批执行（渠道退款 + 配额回收）/ 驳回。
 * 金额恒整数分；proration 四舍五入 Math.round（§6.2）；部分退款配额缩减
 * Math.floor（Ruling 6）。channelRefundNo @unique 为线上重复执行的幂等锚。
 */
export function createRefundService(deps: RefundServiceDeps): RefundService {
  const { prisma, orders, entitlements, audit } = deps
  const now = deps.now ?? (() => new Date())
  const channelResolver = deps.channelResolver ?? createChannelRegistry()

  /**
   * 原支付流水：优先本订单最近一笔 SUCCEEDED（真实收款）；退而取最近一笔任意状态
   * （CONTRACT_CREDIT 应收 PENDING 的账期单也可"申请"退款——申请可留痕，锚定
   * 的是开通关系；执行侧由 approve 的 RefundNotPaidError 闸拦，终审 I3）；
   * 全无 → PaymentNotFoundError（数据断链显性报错）。
   */
  async function findOriginalPayment(orderId: string): Promise<PaymentTransaction> {
    const succeeded = await prisma.paymentTransaction.findFirst({
      where: { orderId, status: 'SUCCEEDED' },
      orderBy: { createdAt: 'desc' },
    })
    if (succeeded) return succeeded
    const any = await prisma.paymentTransaction.findFirst({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
    })
    if (any) return any
    throw new PaymentNotFoundError(orderId)
  }

  /** 校验退款金额：≥1 整数分且不超可退额（RefundAmountExceededError 单错误类覆盖两闸） */
  function assertAmount(amountCents: number, refundableCents: number): void {
    if (!Number.isInteger(amountCents) || amountCents < 1) {
      throw new RefundAmountExceededError(
        `退款金额必须为 ≥ 1 的整数（分），当前：${amountCents}（可退 ${refundableCents}）`,
      )
    }
    if (amountCents > refundableCents) {
      throw new RefundAmountExceededError(
        `退款金额超可退上限：申请 ${amountCents}，可退 ${refundableCents}（payable - 已退；并发退款后上限递减）`,
      )
    }
  }

  /**
   * 全额可退额（闭包实现：request/approve 与对外方法 calcRefundable 同一实现，
   * 方法解构调用不失效）。db 缺省 prisma；approve 在行锁事务内传 tx 同视图读。
   */
  async function calcRefundable(order: RefundableOrder, db: RefundCalcDb = prisma): Promise<number> {
    // 上限 = payable - 已退（部分退款后递减；负值防御归 0）
    const cap = Math.max(0, order.payableCents - order.refundedCents)

    const items = await db.orderItem.findMany({
      where: { orderId: order.id },
      select: { planSnapshot: true },
    })
    const isSubscriptionOrder = items.some((item) => snapshotKind(item.planSnapshot) === 'SUBSCRIPTION')
    if (!isSubscriptionOrder) {
      // SERVICE 类 = 未完成里程碑整项（Ruling 5）：P2 恒全额——里程碑级精确比例
      // 待 P4 交付单里程碑状态机就绪后精确化；ADDON 无独立周期同理全额。
      return cap
    }

    // SUBSCRIPTION 类 proration（§6.2 四舍五入到分）：从本订单开通的订阅行取
    // 周期（startAt→endAt）与消耗（endAt→now）；找不到订阅行（数据异常）回退全额
    const sub = await db.subscription.findFirst({ where: { sourceOrderId: order.id } })
    if (!sub) return cap
    const totalDays = Math.ceil((sub.endAt.getTime() - sub.startAt.getTime()) / DAY_MS)
    if (totalDays <= 0) return 0
    const unusedDays = Math.max(0, Math.ceil((sub.endAt.getTime() - now().getTime()) / DAY_MS))
    const prorated = Math.round((order.payableCents * unusedDays) / totalDays)
    return Math.min(cap, Math.max(0, prorated))
  }

  return {
    async request(orderId, input, actorId) {
      const order = await prisma.order.findUnique({ where: { id: orderId } })
      if (!order) throw new OrderNotFoundError(orderId)

      // 状态分流（裁定）：PARTIALLY_REFUNDED 的再申请走 refund.reopen；
      // 其余走 refund.request（COMPLETED|FULFILLING 合法，非法状态由 transition 闸门拒）
      const event: OrderEventName =
        order.status === 'PARTIALLY_REFUNDED' ? 'refund.reopen' : 'refund.request'

      const payment = await findOriginalPayment(orderId)
      const refundableCents = await calcRefundable(order)
      const amountCents = input.amountCents ?? refundableCents
      assertAmount(amountCents, refundableCents)

      // 迁移 + PENDING 流水同事务（runTransition extraWrites 模式）：
      // 崩窗不留"REFUNDING 无退款流水"的断链（财务工作台漏单）
      let refund!: RefundTransaction
      const evt = await orders.transition(
        orderId,
        event,
        { actorId, note: input.reason },
        async (tx) => {
          refund = await tx.refundTransaction.create({
            data: {
              orderId,
              paymentId: payment.id,
              amountCents,
              currency: 'CNY',
              reason: input.reason ?? null,
              status: 'PENDING',
              requestedById: actorId,
            },
          })
        },
      )
      await audit.record({
        actorType: 'USER',
        actorId,
        action: 'refund.request',
        organizationId: order.organizationId,
        target: `Refund:${refund.id}`,
        diff: {
          orderId,
          paymentId: payment.id,
          amountCents,
          refundableCents,
          reason: input.reason ?? null,
          orderEvent: event,
        },
      })
      return { event: evt, refund, refundableCents }
    },

    calcRefundable,

    async approve(refundId, input, actorId) {
      // 行锁串行化（审查 Important 修复）：整个审批流程包进一个交互式事务，首步
      // SELECT ... FOR UPDATE 锁 RefundTransaction 行——并发双 approve 在此排队，
      // 获锁后 pre-check 必见最新状态（第二笔见 EXECUTED 抛 RefundAlreadyExecutedError），
      // 渠道退款（外部副作用不可回滚、channelRefundNo 每次新号，unique 只防同号落库
      // 不防异号双发）不会双发。审批低频 + mock 即时 / 真实渠道秒级，持锁跨渠道调用
      // 可接受（裁定）。线上渠道与线下登记路径共用此锁序。
      const executedAt = now()
      const outcome = await prisma.$transaction(async (tx) => {
        // ① 行锁 + 状态 pre-check（持锁读，无竞窗）
        const locked = await tx.$queryRaw<LockedRefundRow[]>`
          SELECT "id", "status" FROM "RefundTransaction" WHERE "id" = ${refundId} FOR UPDATE`
        if (locked.length === 0) throw new RefundNotFoundError(refundId)
        if (locked[0].status === 'EXECUTED') throw new RefundAlreadyExecutedError(refundId)
        if (locked[0].status !== 'PENDING') {
          throw new RefundStateError(
            `退款流水状态 ${locked[0].status} 不可审批（refundId=${refundId}，仅 PENDING）`,
          )
        }

        // ② 锁内重读完整行（order / payment 关系）
        const refund = await tx.refundTransaction.findUnique({
          where: { id: refundId },
          include: { order: true, payment: true },
        })
        if (!refund) throw new RefundNotFoundError(refundId)

        // ②' 终审 I3：原支付流水必须已收款（status === 'SUCCEEDED'）才可执行
        //     退款——四通道统一（WECHAT/ALIPAY/BANK_TRANSFER/CONTRACT_CREDIT
        //     一致）。未收款的账期应收（先开通后收款的 CONTRACT_CREDIT/PENDING）
        //     或未确认的转账回单（BANK_TRANSFER/PENDING）退的都是从未收到的钱；
        //     该等订单请走撤销/商务处理。申请侧（request）不拦：申请可留痕，
        //     财务执行侧才拒。行锁内校验 → 拒绝时整体回滚零写入
        if (!refund.payment || refund.payment.status !== 'SUCCEEDED') {
          throw new RefundNotPaidError(
            refund.paymentId,
            refund.payment?.status ?? '流水缺失',
          )
        }

        // ③ 再校验 ≤ 当前可退额（锁内读）：并发退款执行后 refundedCents 递增、上限收缩
        const order = refund.order
        const refundableCents = await calcRefundable(order, tx)
        const executeAmountCents = input?.executeAmountCents ?? refund.amountCents
        assertAmount(executeAmountCents, refundableCents)
        const full = executeAmountCents >= refundableCents
        const event: OrderEventName = full ? 'refund.full' : 'refund.partial'
        const rule = ORDER_TRANSITIONS[event]
        const to = rule.to
        if (to === null) {
          // 防御：refund.full / refund.partial 目标固定（动态目标仅 refund.reject，不走本路径）
          throw new OrderTransitionError(`退款执行事件 ${event} 缺固定目标状态（内部错误）`)
        }

        // ④ 迁移闸门前置（order 仍 REFUNDING 才触达渠道——外部副作用最小暴露；
        //    count=0 并发改态 → 诊断回读后拒，含渠道调用的整体流程回滚）
        const moved = await tx.order.updateMany({
          where: { id: order.id, status: { in: rule.from } },
          data: { status: to },
        })
        if (moved.count === 0) {
          const current = await tx.order.findUnique({
            where: { id: order.id },
            select: { status: true },
          })
          throw transitionRejected(order.id, event, rule.from, current?.status ?? null)
        }

        // ⑤ 渠道退款（持锁内，串行化防双发）：线上（WECHAT/ALIPAY）走渠道，
        //    channelRefundNo 事务内落库（@unique 幂等锚）；线下（转账/账期）= 财务线下
        //    打款后登记，不调渠道
        const online = refund.payment.method === 'WECHAT' || refund.payment.method === 'ALIPAY'
        let channelRefundNo: string | null = null
        if (online) {
          const channelOrderNo = refund.payment.channelOrderNo
          if (!channelOrderNo) {
            throw new RefundStateError(
              `线上支付流水缺 channelOrderNo，无法发起渠道退款：paymentId=${refund.paymentId}`,
            )
          }
          const executed = await channelResolver(refund.payment.method).refund({
            channelOrderNo,
            amountCents: executeAmountCents,
          })
          channelRefundNo = executed.channelRefundNo
        }

        // ⑥ 退款流水条件置 EXECUTED（行锁下本事务必达；条件闸保留为防御面——
        //    count=0（锁外路径改态）→ RefundStateError 整体回滚）。
        //    channelRefundNo @unique 冲突（遗留 A5）：渠道回调返回了已落库的退款单号
        //    （渠道侧幂等重放复用同号）→ P2002（meta.target 含 channelRefundNo）映射
        //    RefundAlreadyExecutedError（router → CONFLICT），不再呈现 500；
        //    其它目标的 P2002 原样上抛（本语句唯一 unique 锚即 channelRefundNo）
        let updated: { count: number }
        try {
          updated = await tx.refundTransaction.updateMany({
            where: { id: refundId, status: 'PENDING' },
            data: { status: 'EXECUTED', executedAt, approvedById: actorId, channelRefundNo },
          })
        } catch (err) {
          if (isChannelRefundNoConflict(err)) {
            throw new RefundAlreadyExecutedError(refundId)
          }
          throw err
        }
        if (updated.count === 0) {
          throw new RefundStateError(
            `退款流水已被并发处理（非 PENDING），审批整体回滚：refundId=${refundId}`,
          )
        }

        // ⑦ OrderEvent + 订单已退金额累加（后续退款的上限据此递减）
        const evt = await tx.orderEvent.create({
          data: {
            orderId: order.id,
            event,
            fromStatus: order.status,
            toStatus: to,
            actorId,
            note: `执行退款 ${executeAmountCents} 分（${full ? '全额' : '部分'}）`,
          },
        })
        await tx.order.update({
          where: { id: order.id },
          data: { refundedCents: { increment: executeAmountCents } },
        })

        let workspaceSuspended = 0
        if (full) {
          // ⑧ 原支付流水冲抵：全额 → REFUNDED（部分保持 SUCCEEDED——后续退款仍以它为锚）
          await tx.paymentTransaction.updateMany({
            where: { id: refund.paymentId, status: 'SUCCEEDED' },
            data: { status: 'REFUNDED' },
          })
          // ⑨ 本订单开通的订阅 ACTIVE → EXPIRED（退款即终止服务）
          await tx.subscription.updateMany({
            where: { sourceOrderId: order.id, status: 'ACTIVE' },
            data: { status: 'EXPIRED' },
          })
          // ⑩ 聚合判定（遗留 B7：与 subscription-service 共用导出的
          //    orgStillServiced 单一来源）：org 仍有其他有效服务（其他 ACTIVE/GRACE
          //    订阅或进行中交付）则只过期不暂停；无 → 暂停全部 ACTIVE workspace
          //    （'订阅到期'，续费恢复按此精确匹配）。全额路径在事务内先 EXPIRED
          //    本订单订阅行再探测——本订单行已不构成匹配，无需显式排除
          const stillServiced = await orgStillServiced(tx, order.organizationId, executedAt)
          if (!stillServiced) {
            const suspended = await tx.workspace.updateMany({
              where: { organizationId: order.organizationId, status: 'ACTIVE' },
              data: { status: 'SUSPENDED', suspendReason: SUBSCRIPTION_EXPIRED_SUSPEND_REASON },
            })
            workspaceSuspended = suspended.count
          }
        } else {
          // ⑩' 部分配额回收（Ruling 6）：按退款比例缩减本订单订阅行数值容量字段，
          //     Math.floor（宁可少给不超发）；allowedPlatforms 集合保留（平台集合不按比例缩）
          const subs = await tx.subscription.findMany({
            where: { sourceOrderId: order.id, status: 'ACTIVE' },
          })
          const ratio = executeAmountCents / order.payableCents
          for (const sub of subs) {
            const current = asRecord(sub.entitlements)
            const next: Record<string, unknown> = { ...current }
            for (const field of CAPACITY_FIELDS) {
              const value = current[field]
              if (typeof value === 'number' && Number.isFinite(value)) {
                next[field] = Math.floor(value * (1 - ratio))
              }
            }
            await tx.subscription.update({
              where: { id: sub.id },
              data: { entitlements: next as Prisma.InputJsonValue },
            })
          }
        }
        return { refund, evt, executeAmountCents, full, online, channelRefundNo, workspaceSuspended }
      })

      // ⑪ 事务提交后：配额重算（订阅行状态 / entitlements 已变）+ 审计 + 组装返回
      const organizationId = outcome.refund.order.organizationId
      await entitlements.recompute(organizationId)
      await audit.record({
        actorType: 'USER',
        actorId,
        action: 'refund.approve',
        organizationId,
        target: `Refund:${refundId}`,
        diff: {
          orderId: outcome.refund.orderId,
          executeAmountCents: outcome.executeAmountCents,
          full: outcome.full,
          online: outcome.online,
          channelRefundNo: outcome.channelRefundNo,
          workspaceSuspended: outcome.workspaceSuspended,
        },
      })
      return {
        event: outcome.evt,
        refund: {
          ...outcome.refund,
          status: 'EXECUTED',
          executedAt,
          approvedById: actorId,
          channelRefundNo: outcome.channelRefundNo,
        },
        orderId: outcome.refund.orderId,
        organizationId,
        executeAmountCents: outcome.executeAmountCents,
        full: outcome.full,
        online: outcome.online,
        workspaceSuspended: outcome.workspaceSuspended,
      }
    },

    async reject(refundId, reason, actorId) {
      // 锁序统一（遗留 A6）：reject 全程内联（照 approve 的内联闸门模式）——
      // 首步 SELECT ... FOR UPDATE 锁 RefundTransaction 行，订单迁移在后，
      // 与 approve 锁序一致（RefundTransaction → Order）。原实现经 orders.transition
      // 是 Order → RefundTransaction 的反序，并发 approve+reject 可交叉成死锁环
      // （PG 检测后中止一侧呈现 500）。注：仅在锁前置"短事务先锁后放"不解决——
      // 环在后续 transition 段仍可形成，必须全程同一事务持锁到底。
      const outcome = await prisma.$transaction(async (tx) => {
        // ① 行锁 + 状态 pre-check（持锁读，无竞窗；与 approve ① 同型）
        const locked = await tx.$queryRaw<LockedRefundRow[]>`
          SELECT "id", "status" FROM "RefundTransaction" WHERE "id" = ${refundId} FOR UPDATE`
        if (locked.length === 0) throw new RefundNotFoundError(refundId)
        if (locked[0].status !== 'PENDING') {
          throw new RefundStateError(
            `退款流水状态 ${locked[0].status} 不可驳回（refundId=${refundId}，仅 PENDING）`,
          )
        }

        // ② 锁内重读完整行（order 关系）
        const refund = await tx.refundTransaction.findUnique({
          where: { id: refundId },
          include: { order: true },
        })
        if (!refund) throw new RefundNotFoundError(refundId)

        // ③ refund.reject（Ruling 12）：回退目标 = 最近一条 toStatus=REFUNDING 的
        //    fromStatus——与 order-service runTransition 同规（createdAt + id desc
        //    tiebreak，同毫秒多条取后写的一条，防把已部分退款的订单回退到 COMPLETED）
        const rule = ORDER_TRANSITIONS['refund.reject']
        let to = rule.to
        if (to === null) {
          const lastRefundingEntry = await tx.orderEvent.findFirst({
            where: { orderId: refund.orderId, toStatus: 'REFUNDING' },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { fromStatus: true },
          })
          if (!lastRefundingEntry || !lastRefundingEntry.fromStatus) {
            throw new OrderTransitionError(
              `refund.reject 无法确定回退目标：orderId=${refund.orderId} 缺少有效的 toStatus=REFUNDING 历史事件（fromStatus）`,
            )
          }
          to = lastRefundingEntry.fromStatus
        }

        // ④ 订单条件迁移（from 闸门：仅 REFUNDING 可驳回；count=0 → 拒整体回滚）
        const moved = await tx.order.updateMany({
          where: { id: refund.orderId, status: { in: rule.from } },
          data: { status: to },
        })
        if (moved.count === 0) {
          const current = await tx.order.findUnique({
            where: { id: refund.orderId },
            select: { status: true },
          })
          throw transitionRejected(refund.orderId, 'refund.reject', rule.from, current?.status ?? null)
        }

        // ⑤ 事件 + 流水 REJECTED 同事务（原 extraWrites 内容原样内联）
        const evt = await tx.orderEvent.create({
          data: {
            orderId: refund.orderId,
            event: 'refund.reject',
            fromStatus: refund.order.status,
            toStatus: to,
            actorId,
            note: reason,
          },
        })
        const updated = await tx.refundTransaction.updateMany({
          where: { id: refundId, status: 'PENDING' },
          data: { status: 'REJECTED', approvedById: actorId },
        })
        if (updated.count === 0) {
          throw new RefundStateError(
            `退款流水已被并发处理（非 PENDING），驳回整体回滚：refundId=${refundId}`,
          )
        }
        return { refund, evt, to }
      })

      await audit.record({
        actorType: 'USER',
        actorId,
        action: 'refund.reject',
        organizationId: outcome.refund.order.organizationId,
        target: `Refund:${refundId}`,
        diff: { orderId: outcome.refund.orderId, reason },
      })
      return {
        event: outcome.evt,
        refund: { ...outcome.refund, status: 'REJECTED', approvedById: actorId },
        orderId: outcome.refund.orderId,
        organizationId: outcome.refund.order.organizationId,
      }
    },
  }
}
