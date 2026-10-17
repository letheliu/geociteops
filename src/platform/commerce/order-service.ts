import { randomInt } from 'node:crypto'
import type {
  BillingPeriod,
  Order,
  OrderEvent,
  OrderItem,
  OrderStatus,
  PaymentMethod,
  PaymentTransaction,
  Prisma,
  PrismaClient,
  ProductKind,
} from '@prisma/client'
import { ProductPlanNotFoundError } from '../catalog/service.js'
import type { FilesService } from './files.js'
import { createChannelRegistry } from './payment/channel.js'
import type { PaymentChannel } from './payment/channel.js'

// ---------------------------------------------------------------------------
// 错误类（命名错误，任务 4 router mapServiceError 按此映射）
// ---------------------------------------------------------------------------

/** 订单状态迁移被拒（非法事件 / from 不在合法集合 / 乐观并发冲突）：name 固定为 ORDER_TRANSITION */
export class OrderTransitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ORDER_TRANSITION'
  }
}

/** 订单不存在：name 固定为 ORDER_NOT_FOUND */
export class OrderNotFoundError extends Error {
  constructor(orderId: string) {
    super(`订单不存在：${orderId}`)
    this.name = 'ORDER_NOT_FOUND'
  }
}

/** 订单号重试耗尽（P2002 冲突达上限）：name 固定为 ORDER_NO_EXHAUSTED */
export class OrderNoExhaustedError extends Error {
  constructor(attempts: number) {
    super(`订单号生成失败：连续 ${attempts} 次命中唯一冲突，已耗尽重试`)
    this.name = 'ORDER_NO_EXHAUSTED'
  }
}

/** 金额非法（负 payable / 改价缺 remark / 非整数分 / 空行项）：name 固定为 INVALID_PRICE */
export class InvalidPriceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'INVALID_PRICE'
  }
}

/** 行项数量非法（非正整数）：name 固定为 INVALID_QUANTITY */
export class InvalidQuantityError extends Error {
  constructor(quantity: number) {
    super(`商品行数量必须为 ≥ 1 的整数：${quantity}`)
    this.name = 'INVALID_QUANTITY'
  }
}

/**
 * SUBSCRIPTION/SERVICE 行数量恒为 1（终审 C1）：quantity 的交付倍乘语义仅 ADDON
 * 支持（开通 worker 把加购容量字段 ×quantity 落 entitlements）；订阅/服务行
 * quantity > 1 时计价按倍数、交付却只有一份（订阅单行锚 / 交付单按行项），
 * 计价与交付必然背离，下单即拒：name 固定为 INVALID_QUANTITY。
 */
export class QuantityMustBeOneError extends Error {
  constructor(planId: string, kind: string, quantity: number) {
    super(
      `SUBSCRIPTION/SERVICE 商品行数量恒为 1（quantity 倍乘交付仅 ADDON 支持）：planId=${planId}，kind=${kind}，quantity=${quantity}`,
    )
    this.name = 'INVALID_QUANTITY'
  }
}

/** 一张订单至多一个 SUBSCRIPTION 行（Ruling 8）：name 固定为 MULTIPLE_SUBSCRIPTION_ITEMS */
export class MultipleSubscriptionItemsError extends Error {
  constructor(count: number) {
    super(`一张订单至多包含一个订阅行，当前 ${count} 个（Ruling 8）`)
    this.name = 'MULTIPLE_SUBSCRIPTION_ITEMS'
  }
}

/** 套餐已下架不可下单：name 固定为 PRODUCT_PLAN_INACTIVE */
export class ProductPlanInactiveError extends Error {
  constructor(planId: string) {
    super(`套餐已下架，不可下单：${planId}`)
    this.name = 'PRODUCT_PLAN_INACTIVE'
  }
}

/**
 * 下单目标组织不存在（遗留 B1）：organizationId 指向不存在组织时 FK P2003
 * 呈裸 500——create 前置校验后以命名错误抛出，router 映射 BAD_REQUEST：
 * name 固定为 ORGANIZATION_NOT_FOUND。
 */
export class OrganizationNotFoundError extends Error {
  constructor(organizationId: string) {
    super(`目标组织不存在，无法下单：${organizationId}`)
    this.name = 'ORGANIZATION_NOT_FOUND'
  }
}

// ---------------------------------------------------------------------------
// 任务 5：线下收款（对公转账回单 + 合同账期）错误类
// ---------------------------------------------------------------------------

/** 回单上传入参非法（base64 非法/超 7MB/扩展名白名单外）：name 固定为 INVALID_VOUCHER */
export class InvalidVoucherError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'INVALID_VOUCHER'
  }
}

/** 账期天数非法（非正整数或超 CREDIT_DUE_DAYS_MAX 上限，遗留 B2）：name 固定为 INVALID_DUE_DAYS */
export class InvalidDueDaysError extends Error {
  constructor(dueDays: number) {
    super(
      `dueDays 必须为 ≥ 1 且 ≤ ${CREDIT_DUE_DAYS_MAX} 的整数天数，当前：${dueDays}`,
    )
    this.name = 'INVALID_DUE_DAYS'
  }
}

/** 支付流水不存在：name 固定为 PAYMENT_NOT_FOUND */
export class PaymentNotFoundError extends Error {
  constructor(paymentId: string) {
    super(`支付流水不存在：${paymentId}`)
    this.name = 'PAYMENT_NOT_FOUND'
  }
}

/** 支付流水状态/通道不允许该操作（重复确认 / 非线下通道）：name 固定为 PAYMENT_STATE */
export class PaymentStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PAYMENT_STATE'
  }
}

/** prisma P2002（unique 冲突）鸭型判定：不引运行时 Prisma 命名空间，mock 与真实驱动通吃 */
function isPrismaUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === 'P2002'
}

/**
 * P2002 且冲突目标为 orderNo（meta.target 含 orderNo）才视为订单号冲突重试；
 * 其他唯一索引冲突原样上抛，避免误耗重试 / 误报订单号耗尽。
 */
function isOrderNoUniqueConflict(err: unknown): boolean {
  if (!isPrismaUniqueConstraintViolation(err)) return false
  const target = (err as { meta?: { target?: unknown } }).meta?.target
  if (Array.isArray(target)) return target.includes('orderNo')
  return target === 'orderNo'
}

// ---------------------------------------------------------------------------
// 状态机（规格 §6.2 迁移表逐字）
// ---------------------------------------------------------------------------

/** 订单事件名（12 个，与规格 §6.2 一致） */
export type OrderEventName =
  | 'cancel'
  | 'voucher.upload'
  | 'finance.reject'
  | 'payment.confirmed'
  | 'credit.open'
  | 'activate.start'
  | 'fulfill.complete'
  | 'refund.request'
  | 'refund.full'
  | 'refund.partial'
  | 'refund.reopen'
  | 'refund.reject'

/** OrderStatus 的字符串值形式（服务层不引枚举运行时，mock 直传字符串） */
export type OrderStatusValue = OrderStatus

export const ORDER_EVENT_NAMES: readonly OrderEventName[] = [
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
]

export const ORDER_STATUS_VALUES: readonly OrderStatusValue[] = [
  'PENDING_PAYMENT',
  'PENDING_CONFIRMATION',
  'PAID',
  'FULFILLING',
  'COMPLETED',
  'CANCELLED',
  'REFUNDING',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
]

interface TransitionRule {
  /** 合法 from 全集（updateMany where status IN (...) 的乐观并发闸） */
  from: OrderStatusValue[]
  /** 固定 to；null = 动态目标（仅 refund.reject，Ruling 12） */
  to: OrderStatusValue | null
}

/** 规格 §6.2 迁移表逐字：12 事件 × 9 状态矩阵中的 14 个合法格 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderEventName, TransitionRule>> = {
  cancel: { from: ['PENDING_PAYMENT'], to: 'CANCELLED' },
  'voucher.upload': { from: ['PENDING_PAYMENT'], to: 'PENDING_CONFIRMATION' },
  'finance.reject': { from: ['PENDING_CONFIRMATION'], to: 'PENDING_PAYMENT' },
  'payment.confirmed': { from: ['PENDING_PAYMENT', 'PENDING_CONFIRMATION'], to: 'PAID' },
  'credit.open': { from: ['PENDING_PAYMENT'], to: 'FULFILLING' },
  'activate.start': { from: ['PAID'], to: 'FULFILLING' },
  'fulfill.complete': { from: ['FULFILLING'], to: 'COMPLETED' },
  'refund.request': { from: ['COMPLETED', 'FULFILLING'], to: 'REFUNDING' },
  'refund.full': { from: ['REFUNDING'], to: 'REFUNDED' },
  'refund.partial': { from: ['REFUNDING'], to: 'PARTIALLY_REFUNDED' },
  'refund.reopen': { from: ['PARTIALLY_REFUNDED'], to: 'REFUNDING' },
  // 财务驳回 → 回到申请前状态（COMPLETED / FULFILLING）：运行时从 OrderEvent 解析
  'refund.reject': { from: ['REFUNDING'], to: null },
}

/** 迁移被拒的诊断消息：含 orderId、event、期望 from 集合与实际当前状态（裁定）。refund-service 内联闸门复用（任务 12 行锁修复），保持消息同源。 */
export function transitionRejected(
  orderId: string,
  event: string,
  expected: OrderStatusValue[],
  actual: OrderStatusValue | null,
): OrderTransitionError {
  const actualText = actual ?? '订单不存在'
  return new OrderTransitionError(
    `订单状态迁移被拒：orderId=${orderId}，event=${event}，期望 from=[${expected.join('、')}]，实际状态=${actualText}`,
  )
}

// ---------------------------------------------------------------------------
// 订单号：GEO + yyMMdd + 8 位随机 base36
// ---------------------------------------------------------------------------

/** 订单号随机段长度（8 位 base36 ≈ 2.8 万亿组合） */
export const ORDER_NO_RANDOM_LENGTH = 8

/** P2002 冲突时的总尝试上限（含首次，即至多重试 2 次；裁定"重试 ≤ 3"取保守上界） */
export const ORDER_NO_MAX_ATTEMPTS = 3

const BASE36_CHARSET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** crypto 随机 base36 串（node:crypto randomInt，可注入替换） */
export function randomBase36(length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += BASE36_CHARSET[randomInt(BASE36_CHARSET.length)]
  }
  return out
}

/** GEO + yyMMdd（UTC，跨时区确定性）+ 随机后缀 */
export function formatOrderNo(date: Date, suffix: string): string {
  const yy = String(date.getUTCFullYear()).slice(-2)
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  return `GEO${yy}${mm}${dd}${suffix}`
}

// ---------------------------------------------------------------------------
// 下单输入 / 输出
// ---------------------------------------------------------------------------

export interface CreateOrderItemInput {
  planId: string
  /** ≥ 1 整数 */
  quantity: number
  /** 加购包 / 专业服务目标 workspace */
  workspaceId?: string
}

export interface CreateOrderInput {
  organizationId: string
  items: CreateOrderItemInput[]
  actorId: string
  /** 折让（分）；> 0 时 remark 必填（"可改价，需填写原因"） */
  discountCents?: number
  remark?: string
}

export interface TransitionOptions {
  actorId?: string
  note?: string
}

/** 行项套餐快照：键名固定（任务 8 开通 worker 按此消费） */
export interface OrderPlanSnapshot {
  name: string
  kind: ProductKind
  priceCents: number
  billingPeriod: BillingPeriod | null
  entitlements: Prisma.InputJsonValue
  deliverables: Prisma.InputJsonValue
}

export interface CreateOrderResult {
  order: Order
  items: OrderItem[]
  events: OrderEvent[]
}

// ---------------------------------------------------------------------------
// 任务 5：线下收款常量 / 队列投递 / 方法输入输出
// ---------------------------------------------------------------------------

/** 回单文件大小上限：解码后 7MB */
export const VOUCHER_MAX_BYTES = 7 * 1024 * 1024

/** 回单扩展名白名单（与 files service FileExt 同源） */
export const VOUCHER_EXTENSIONS = ['png', 'jpg', 'pdf'] as const

/**
 * 合同账期天数上限（遗留 B2）：router zod 限 3650（≈10 年），service 层此前
 * 无上限——裸 service 可开超长账期。此常量为 service 层第二道闸的上界，
 * 与 admin-order-router 的 zod max 保持同值。
 */
export const CREDIT_DUE_DAYS_MAX = 3650

/** 订单开通任务队列名（收款确认/账期开通后投递，任务 8 worker 消费） */
export const ORDER_ACTIVATION_QUEUE = 'order.activate'

/** 合同账期超期暂停原因（账期巡检写入；应收确认时按此精确恢复，Ruling 4） */
export const CREDIT_OVERDUE_SUSPEND_REASON = '账期超期'

/**
 * 队列结构化类型（pg-boss boss 实例满足；测试 mock 同构）：
 * createQueue 幂等建队，send 投递消息（第三参为 pg-boss SendOptions 子集）。
 * 不引 PgBoss 运行时类型，服务层保持可 mock。
 */
export interface OrderQueueSendOptions {
  retryLimit?: number
  retryDelay?: number
}

export interface OrderQueueLike {
  createQueue(name: string): Promise<unknown>
  send(name: string, data: unknown, options?: OrderQueueSendOptions): Promise<unknown>
}

/**
 * 开通任务投递选项：worker 抛错（DB 抖动等瞬时故障）时 pg-boss 重试 5 次、
 * 间隔 30s——v10 默认 retryLimit=0 即不重试，必须显式配置（开通流程幂等，
 * 重试无重复副作用；模式同 diagnostic-sample-worker 的 boss.send 第三参）。
 */
export const ORDER_ACTIVATION_SEND_OPTIONS: OrderQueueSendOptions = {
  retryLimit: 5,
  retryDelay: 30,
}

/** 投递订单开通任务：createQueue 幂等 + send { orderId }（任务 8 worker 消费） */
export async function enqueueOrderActivation(boss: OrderQueueLike, orderId: string): Promise<void> {
  await boss.createQueue(ORDER_ACTIVATION_QUEUE)
  await boss.send(ORDER_ACTIVATION_QUEUE, { orderId }, ORDER_ACTIVATION_SEND_OPTIONS)
}

export interface UploadVoucherInput {
  /** 原始文件名（扩展名取自此处，白名单 png/jpg/pdf） */
  fileName?: string
  /** 文件内容 base64（解码后 ≤ VOUCHER_MAX_BYTES） */
  contentBase64: string
}

export interface UploadVoucherResult {
  event: OrderEvent
  payment: PaymentTransaction
  voucherFileKey: string
  orderId: string
  organizationId: string
}

export interface ConfirmPaymentResult {
  /** BANK_TRANSFER 分支返回迁移事件；CONTRACT_CREDIT 分支恒 null（不迁移） */
  event: OrderEvent | null
  payment: PaymentTransaction
  orderId: string
  organizationId: string
  paymentMethod: PaymentMethod
  /** CONTRACT_CREDIT 分支恢复的 workspace 行数（Ruling 4；BANK_TRANSFER 恒 0） */
  resumedWorkspaces: number
}

export interface RejectVoucherResult {
  event: OrderEvent
  payment: PaymentTransaction
  orderId: string
  organizationId: string
}

export interface OpenOnCreditInput {
  /** 账期天数（≥1 整数；dueAt = 确认时刻 + dueDays 天） */
  dueDays: number
}

export interface OpenOnCreditResult {
  event: OrderEvent
  payment: PaymentTransaction
  dueAt: Date
  orderId: string
  organizationId: string
  payableCents: number
}

// ---------------------------------------------------------------------------
// 任务 6：在线支付（微信/支付宝 mock）方法输入输出
// ---------------------------------------------------------------------------

/** 线上支付发起结果（商城扫码用：payUrl 收银台地址 + channelOrderNo 对账锚） */
export interface CreateOnlinePaymentResult {
  payUrl: string
  channelOrderNo: string
}

/** 线上回调/对账确认入参（handlePaymentCallback 与 reconcilePendingPayments 组装） */
export interface ConfirmChannelPaymentInput {
  paymentId: string
  orderId: string
  /** 回填 Order.paymentMethod（WECHAT / ALIPAY） */
  method: PaymentMethod
  /** 渠道交易号（幂等锚，@unique） */
  channelTxnNo: string
  channelOrderNo: string
  /** 原始回调/对账快照（rawPayload Json 列） */
  rawPayload?: Prisma.InputJsonValue
  note?: string
}

/**
 * 内部哨兵：事务内条件更新 count=0 且流水已是本交易号 SUCCEEDED（并发赢家已提交）——
 * 空回滚中断事务，confirmChannelPayment 转译为 { duplicate: true }（裁定）。
 */
class DuplicateCallbackSignal extends Error {}

export interface OrderServiceDeps {
  prisma: PrismaClient
  /** 时钟注入（订单号日期段/账期 dueAt/paidAt），缺省系统时间 */
  now?: () => Date
  /** 熵源注入（订单号随机段），缺省 crypto 随机 base36 */
  randomSuffix?: () => string
  /** files 服务（回单落盘）；uploadVoucher 未注入时显性报错 */
  files?: FilesService
  /** pg-boss 队列（投递 order.activate）；确认收款/开通账期未注入时显性报错 */
  boss?: OrderQueueLike
  /**
   * 线上支付渠道工厂（任务 6）：缺省 createChannelRegistry()（按 method 记忆单例——
   * mock 内存注册表跨 createPayment/回调/对账可见；P2 mock 先行）。生产装配注入共享实例。
   */
  channelFactory?: (method: PaymentMethod) => PaymentChannel
}

export interface OrderService {
  /**
   * 下单：校验目标组织存在（遗留 B1，OrganizationNotFoundError）、套餐（存在 +
   * active）、至多一个 SUBSCRIPTION 行（Ruling 8）、
   * SUBSCRIPTION/SERVICE 行 quantity 恒为 1（终审 C1，ADDON 才支持数量倍乘）、
   * 金额（整数分；discountCents > 0 时 remark 必填；payable ≥ 0），
   * 固化 planSnapshot，事务内建 Order + OrderItem[] + 初始 OrderEvent(create)，
   * 订单号 P2002 冲突自动重试（≤ ORDER_NO_MAX_ATTEMPTS 次）。
   */
  create(input: CreateOrderInput): Promise<CreateOrderResult>
  /**
   * 状态机迁移（规格 §6.2）：updateMany WHERE status IN (from) 乐观并发，
   * count=0 抛 OrderTransitionError（消息含 orderId/event/期望 from/实际状态）；
   * 每次迁移写一条 OrderEvent，返回该事件记录。
   * refund.reject 的目标状态从 OrderEvent 最近一条 toStatus=REFUNDING 的
   * fromStatus 解析（Ruling 12：财务驳回回到申请前状态）。
   * extraWrites（任务 12）：与迁移同事务的追加写（refund-service 组合退款流水 /
   * refundedCents / 配额回收，闸门 + 事件 + 追加写一个原子单元）；路由层不消费。
   */
  transition(
    orderId: string,
    event: OrderEventName,
    opts?: TransitionOptions,
    extraWrites?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<OrderEvent>
  /**
   * 对公转账回单上传（任务 5）：入参校验（base64/大小/扩展名白名单）→
   * files.put 落盘 → 迁移 'voucher.upload' 与建 PaymentTransaction(BANK_TRANSFER/
   * PENDING, amount=payableCents, voucherFileKey) 在同一事务（闸门+事件+流水原子）。
   * 事务失败回滚时清理已落盘的孤儿回单（遗留 D6，unlink 尽力而为——失败仅日志）。
   */
  uploadVoucher(
    orderId: string,
    input: UploadVoucherInput,
    actorId: string,
  ): Promise<UploadVoucherResult>
  /**
   * 财务确认收款（任务 5，只做三件事：置流水成功、迁移状态、投递开通）：
   * - BANK_TRANSFER：迁移 'payment.confirmed' → PAID、流水按 PENDING 条件更新为
   *   SUCCEEDED/confirmedById、Order.paidAt/paymentMethod 与迁移同事务（原子），
   *   事务提交后 enqueue order.activate（丢任务由任务 8 对账兜底）；
   * - CONTRACT_CREDIT（应收确认）：订单已 FULFILLING，不迁移不投递——流水条件更新 +
   *   paidAt + 恢复"账期超期"暂停的 workspace（Ruling 4）三笔写同一事务。
   * 流水条件更新 count=0（confirm/reject 竞态）→ PaymentStateError 整体回滚。
   */
  confirmPayment(paymentId: string, actorId: string): Promise<ConfirmPaymentResult>
  /**
   * 财务驳回回单（任务 5）：迁移 'finance.reject'（PENDING_CONFIRMATION→PENDING_PAYMENT）
   * 与流水按 PENDING 条件更新 FAILED + rawPayload.reason 同事务（竞态整体回滚）。
   */
  rejectVoucher(paymentId: string, reason: string, actorId: string): Promise<RejectVoucherResult>
  /**
   * 合同账期开通（任务 5，Ruling 11 先开通后收款）：迁移 'credit.open'
   * （PENDING_PAYMENT→FULFILLING）、Order.paymentMethod=CONTRACT_CREDIT/dueAt 与建
   * 应收流水 PaymentTransaction(CONTRACT_CREDIT/PENDING) 同事务，提交后 enqueue
   * order.activate。
   */
  openOnCredit(
    orderId: string,
    input: OpenOnCreditInput,
    actorId: string,
  ): Promise<OpenOnCreditResult>
  /**
   * 发起线上支付（任务 6）：校验订单 PENDING_PAYMENT → 渠道下单（channelFactory，
   * 微信/支付宝 mock）→ 建 method/PENDING 流水（channelOrderNo 回填）→ 返回扫码信息。
   * 幂等语义（裁定）：同一订单重复发起允许——每次返回新 payUrl，旧 PENDING 流水不清理，
   * 由 payment.reconcile 每日查单对账置终态（渠道侧超时关单）。
   */
  createPayment(orderId: string, method: PaymentMethod): Promise<CreateOnlinePaymentResult>
  /**
   * 线上支付回调确认（任务 6，handlePaymentCallback 第 4 步 / 对账补单共用）：
   * 流水条件更新 SUCCEEDED（channelTxnNo/channelOrderNo 回填）+ 迁移 payment.confirmed
   * （PENDING_PAYMENT|PENDING_CONFIRMATION → PAID）+ Order.paidAt/paymentMethod 回填，
   * 四笔写同一交互式事务（任务 5 修复轮模式），提交后 enqueue order.activate。
   * 并发重复回调（同交易号已 SUCCEEDED）→ { duplicate: true }，不重复投递。
   */
  confirmChannelPayment(input: ConfirmChannelPaymentInput): Promise<{ duplicate: boolean }>
}

/**
 * 订单服务：状态机（§6.2 迁移表）+ 下单 + 线下收款（任务 5）。
 * 错误类导出供 router mapServiceError 映射。
 */
export function createOrderService(deps: OrderServiceDeps): OrderService {
  const { prisma } = deps
  const files = deps.files
  const boss = deps.boss
  const now = deps.now ?? (() => new Date())
  const randomSuffix = deps.randomSuffix ?? (() => randomBase36(ORDER_NO_RANDOM_LENGTH))
  const channelFactory = deps.channelFactory ?? createChannelRegistry()

  function requireFiles(): FilesService {
    if (!files) {
      throw new Error('OrderService 未注入 files 服务，无法上传回单（检查 server.ts 装配）')
    }
    return files
  }

  function requireBoss(): OrderQueueLike {
    if (!boss) {
      throw new Error('OrderService 未注入 boss 队列，无法投递 order.activate（检查 server.ts 装配）')
    }
    return boss
  }

  /**
   * 落库失败后的孤儿回单清理（遗留 D6）：files.put 成功但事务/流水写入失败回滚时，
   * 盘上文件已无数据库引用——unlink 尽力而为（清理自身失败仅日志，不掩盖原错误）。
   */
  async function removeOrphanVoucher(fileKey: string): Promise<void> {
    try {
      await requireFiles().remove(fileKey)
    } catch (err) {
      console.error(`[order-service] 孤儿回单文件清理失败（fileKey=${fileKey}）`, err)
    }
  }

  /** 回单入参校验与解码：base64 形态 → 大小上限 → 扩展名白名单（顺序即错误优先级） */
  function decodeVoucher(input: UploadVoucherInput): { buffer: Buffer; ext: (typeof VOUCHER_EXTENSIONS)[number] } {
    const compact = input.contentBase64.replace(/\s+/g, '')
    if (compact === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
      throw new InvalidVoucherError('contentBase64 不是合法的 base64 编码')
    }
    const buffer = Buffer.from(compact, 'base64')
    if (buffer.byteLength > VOUCHER_MAX_BYTES) {
      throw new InvalidVoucherError(
        `回单文件过大：解码后 ${buffer.byteLength} 字节，上限 ${VOUCHER_MAX_BYTES} 字节（7MB）`,
      )
    }
    const extMatch = typeof input.fileName === 'string' ? /\.([A-Za-z0-9]+)$/.exec(input.fileName) : null
    const ext = extMatch ? extMatch[1].toLowerCase() : ''
    if (!(VOUCHER_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new InvalidVoucherError(
        `回单扩展名不在白名单（png/jpg/pdf）：${JSON.stringify(input.fileName ?? '')}`,
      )
    }
    return { buffer, ext: ext as (typeof VOUCHER_EXTENSIONS)[number] }
  }

  /** 支付流水 + 订单关系读取：不存在/无订单关系均 PAYMENT_NOT_FOUND */
  async function loadPaymentWithOrder(
    paymentId: string,
  ): Promise<PaymentTransaction & { order: Order }> {
    const payment = await prisma.paymentTransaction.findUnique({
      where: { id: paymentId },
      include: { order: true },
    })
    if (!payment || !payment.order) throw new PaymentNotFoundError(paymentId)
    return payment as PaymentTransaction & { order: Order }
  }

  /** 迁移前置守卫：状态不在事件合法 from 集合即拒（避免先写文件再被 transition 拒的浪费） */
  function guardTransitionFrom(
    orderId: string,
    event: OrderEventName,
    status: OrderStatusValue,
  ): void {
    const rule = ORDER_TRANSITIONS[event]
    if (!rule.from.includes(status)) {
      throw transitionRejected(orderId, event, rule.from, status)
    }
  }

  /**
   * 状态机迁移实现（对象方法 transition 与本文件收款/账期方法共用同一闭包）。
   * extraWrites：与迁移同事务的追加写（流水条件更新 / 订单账期字段 / 应收流水建行）——
   * 迁移闸门 + 事件 + 追加写在同一交互式事务内，任一抛错整体回滚，
   * 崩窗不留"状态已迁、流水/字段缺失"的账实断链（任务 5 修复轮）。
   */
  async function runTransition(
    orderId: string,
    event: OrderEventName,
    opts: TransitionOptions = {},
    extraWrites?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<OrderEvent> {
    const rule = ORDER_TRANSITIONS[event]
    if (!rule) {
      throw new OrderTransitionError(`未知订单事件：${String(event)}（orderId=${orderId}）`)
    }

    // 预检读当前状态（写 OrderEvent.fromStatus 的准确来源；并发窗口由下方 updateMany 兜底）
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true },
    })
    if (!order) throw new OrderNotFoundError(orderId)
    if (!rule.from.includes(order.status)) {
      throw transitionRejected(orderId, event, rule.from, order.status)
    }

    // Ruling 12：refund.reject 目标 = 最近一次进入 REFUNDING 前的状态。
    // 排序带 id desc tiebreak：同毫秒多条（refund.request 后又 refund.reopen）时
    // 确定取后写的一条（reopen 的 fromStatus=PARTIALLY_REFUNDED），
    // 否则可能把已部分退款的订单回退到 COMPLETED，重复打开全额退款路径。
    let to = rule.to
    if (to === null) {
      const lastRefundingEntry = await prisma.orderEvent.findFirst({
        where: { orderId, toStatus: 'REFUNDING' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { fromStatus: true },
      })
      if (!lastRefundingEntry || !lastRefundingEntry.fromStatus) {
        throw new OrderTransitionError(
          `refund.reject 无法确定回退目标：orderId=${orderId} 缺少有效的 toStatus=REFUNDING 历史事件（fromStatus）`,
        )
      }
      to = lastRefundingEntry.fromStatus
    }

    // 乐观并发 + 事件落库原子化：updateMany WHERE status IN (from) 与 OrderEvent
    // 写入包进同一交互式事务——崩溃窗口不留"状态已迁、事件缺失"（审计链断裂，
    // 且 refund.reject 的回退目标依赖事件历史完整性）。用交互式而非数组形式：
    // count=0 的闸门必须位于两次写之间，否则竞态窗口会提交一条记录了
    // "从未发生的迁移"的事件（比缺事件更糟）；事务内抛错整体回滚。
    return await prisma.$transaction(async (tx) => {
      const result = await tx.order.updateMany({
        where: { id: orderId, status: { in: rule.from } },
        data: { status: to },
      })
      if (result.count === 0) {
        const current = await tx.order.findUnique({
          where: { id: orderId },
          select: { status: true },
        })
        throw transitionRejected(orderId, event, rule.from, current?.status ?? null)
      }
      const created = await tx.orderEvent.create({
        data: {
          orderId,
          event,
          fromStatus: order.status,
          toStatus: to,
          actorId: opts.actorId ?? null,
          note: opts.note ?? null,
        },
      })
      // 追加写与迁移同事务：闸门 + 事件 + 流水/字段四笔写一个原子单元
      if (extraWrites) await extraWrites(tx)
      return created
    })
  }

  return {
    async create(input) {
      const { organizationId, items, actorId } = input
      const discountCents = input.discountCents ?? 0

      if (!Array.isArray(items) || items.length === 0) {
        throw new InvalidPriceError('订单至少包含一个商品行')
      }
      for (const item of items) {
        if (!Number.isInteger(item.quantity) || item.quantity < 1) {
          throw new InvalidQuantityError(item.quantity)
        }
      }
      if (!Number.isInteger(discountCents) || discountCents < 0) {
        throw new InvalidPriceError(`discountCents 必须为非负整数（分），当前：${discountCents}`)
      }

      // 遗留 B1：目标组织存在性前置校验——不存在的 organizationId 直落 create 会
      // 触发 FK P2003 呈裸 500；此处命名错误（router 映射 BAD_REQUEST）。
      // 客户侧 organizationId 恒由 actor 派生（必存在，一次冗余查询）；代客下单
      // 是主要防护面（platform 传错目标企业 id）。
      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { id: true },
      })
      if (!org) throw new OrganizationNotFoundError(organizationId)

      // 套餐存在性 + active 校验（含 product 取 kind 入快照）
      const planIds = [...new Set(items.map((item) => item.planId))]
      const plans = await prisma.productPlan.findMany({
        where: { id: { in: planIds } },
        include: { product: true },
      })
      const planById = new Map(plans.map((plan) => [plan.id, plan]))
      for (const planId of planIds) {
        if (!planById.has(planId)) throw new ProductPlanNotFoundError(planId)
      }
      for (const plan of plans) {
        if (!plan.active) throw new ProductPlanInactiveError(plan.id)
      }

      // 终审 C1：SUBSCRIPTION/SERVICE 行 quantity 恒为 1——quantity 只在 ADDON
      // 交付中有倍乘语义（activateAddon 容量 ×quantity 落 entitlements），
      // 订阅/服务行买 N 份无法对应 N 份交付（订阅单行锚 / 交付单按行项）
      for (const item of items) {
        const kind = planById.get(item.planId)!.product.kind
        if ((kind === 'SUBSCRIPTION' || kind === 'SERVICE') && item.quantity !== 1) {
          throw new QuantityMustBeOneError(item.planId, kind, item.quantity)
        }
      }

      // Ruling 8：一张订单至多一个 SUBSCRIPTION 行
      const subscriptionCount = items.filter(
        (item) => planById.get(item.planId)!.product.kind === 'SUBSCRIPTION',
      ).length
      if (subscriptionCount > 1) throw new MultipleSubscriptionItemsError(subscriptionCount)

      // §6.2：可改价，需填写原因
      const remark = typeof input.remark === 'string' ? input.remark.trim() : ''
      if (discountCents > 0 && remark === '') {
        throw new InvalidPriceError('discountCents > 0（可改价）时 remark 必填：需填写改价原因')
      }

      // 金额：整数分；total = Σ unitPrice × qty；payable = total - discount（禁负）
      let totalCents = 0
      const itemRows = items.map((item) => {
        const plan = planById.get(item.planId)!
        totalCents += plan.priceCents * item.quantity
        const snapshot: OrderPlanSnapshot = {
          name: plan.name,
          kind: plan.product.kind,
          priceCents: plan.priceCents,
          billingPeriod: plan.billingPeriod,
          entitlements: plan.entitlements as Prisma.InputJsonValue,
          deliverables: plan.deliverables as Prisma.InputJsonValue,
        }
        return {
          planId: item.planId,
          workspaceId: item.workspaceId ?? null,
          quantity: item.quantity,
          unitPriceCents: plan.priceCents,
          planSnapshot: snapshot,
        }
      })
      const payableCents = totalCents - discountCents
      if (payableCents < 0) {
        throw new InvalidPriceError(
          `应付金额不能为负：totalCents=${totalCents}，discountCents=${discountCents}，payableCents=${payableCents}`,
        )
      }

      // 订单号冲突重试在事务外层（P2002 会中止交互式事务，须整单重试）
      for (let attempt = 1; attempt <= ORDER_NO_MAX_ATTEMPTS; attempt++) {
        const orderNo = formatOrderNo(now(), randomSuffix())
        try {
          return await prisma.$transaction(async (tx) => {
            const order = await tx.order.create({
              data: {
                orderNo,
                organizationId,
                status: 'PENDING_PAYMENT',
                totalCents,
                discountCents,
                payableCents,
                remark: remark || null,
              },
            })
            const createdItems: OrderItem[] = []
            for (const row of itemRows) {
              createdItems.push(
                await tx.orderItem.create({
                  data: {
                    orderId: order.id,
                    planId: row.planId,
                    workspaceId: row.workspaceId,
                    quantity: row.quantity,
                    unitPriceCents: row.unitPriceCents,
                    planSnapshot: row.planSnapshot as unknown as Prisma.InputJsonValue,
                  },
                }),
              )
            }
            const event = await tx.orderEvent.create({
              data: {
                orderId: order.id,
                event: 'create',
                fromStatus: null,
                toStatus: 'PENDING_PAYMENT',
                actorId,
                note: null,
              },
            })
            return { order, items: createdItems, events: [event] }
          })
        } catch (err) {
          if (isOrderNoUniqueConflict(err)) {
            if (attempt < ORDER_NO_MAX_ATTEMPTS) continue
            throw new OrderNoExhaustedError(ORDER_NO_MAX_ATTEMPTS)
          }
          throw err
        }
      }
      // 循环正常退出即耗尽（TS 收口，不可达）
      throw new OrderNoExhaustedError(ORDER_NO_MAX_ATTEMPTS)
    },

    async transition(orderId, event, opts, extraWrites) {
      return runTransition(orderId, event, opts, extraWrites)
    },

    async uploadVoucher(orderId, input, actorId) {
      // 入参校验先行（不合法不触库不写盘）
      const { buffer, ext } = decodeVoucher(input)

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, payableCents: true, organizationId: true },
      })
      if (!order) throw new OrderNotFoundError(orderId)
      guardTransitionFrom(orderId, 'voucher.upload', order.status)

      // 先落盘再迁移：迁移失败只留孤儿文件（可清理），反向顺序会留下
      // "PENDING_CONFIRMATION 但无流水"的断链状态（财务无法确认）
      const voucherFileKey = await requireFiles().put(buffer, ext)

      // 迁移与流水建行同事务（修复轮）：闸门 + 事件 + BANK_TRANSFER/PENDING 流水
      // 一个原子单元——崩窗不留"PENDING_CONFIRMATION 但无流水"的提交态断链。
      // 落库失败（并发改态失闸 / 驱动异常）时清理已落盘的孤儿回单（遗留 D6），
      // 清理尽力而为，原错误照常上抛
      let payment!: PaymentTransaction
      try {
        const event = await runTransition(
          orderId,
          'voucher.upload',
          { actorId, note: input.fileName },
          async (tx) => {
            payment = await tx.paymentTransaction.create({
              data: {
                orderId,
                method: 'BANK_TRANSFER',
                status: 'PENDING',
                amountCents: order.payableCents,
                currency: 'CNY',
                voucherFileKey,
              },
            })
          },
        )
        return { event, payment, voucherFileKey, orderId, organizationId: order.organizationId }
      } catch (err) {
        await removeOrphanVoucher(voucherFileKey)
        throw err
      }
    },

    async confirmPayment(paymentId, actorId) {
      const payment = await loadPaymentWithOrder(paymentId)
      if (payment.status !== 'PENDING') {
        throw new PaymentStateError(
          `支付流水状态非 PENDING，不可确认（paymentId=${paymentId}，status=${payment.status}）`,
        )
      }

      if (payment.method === 'BANK_TRANSFER') {
        // 对公转账确认（只做三件事：置流水成功、迁移状态、投递开通）。
        // 迁移闸门 + 事件 + 流水条件更新 + paidAt/paymentMethod 四笔写同一事务（修复轮）：
        // 崩窗不留"订单 PAID + 流水 PENDING"的账实断链（该断链下重试还会被
        // transition 闸门 CONFLICT 拒绝，只能人工修数）；流水按 status=PENDING
        // 条件更新——confirm/reject 竞态下 count=0 抛 PaymentStateError 整体回滚。
        const event = await runTransition(
          payment.orderId,
          'payment.confirmed',
          { actorId },
          async (tx) => {
            const result = await tx.paymentTransaction.updateMany({
              where: { id: paymentId, status: 'PENDING' },
              data: { status: 'SUCCEEDED', confirmedById: actorId },
            })
            if (result.count === 0) {
              throw new PaymentStateError(
                `支付流水已被并发处理（非 PENDING），确认整体回滚：paymentId=${paymentId}`,
              )
            }
            await tx.order.update({
              where: { id: payment.orderId },
              data: { paidAt: now(), paymentMethod: 'BANK_TRANSFER' },
            })
          },
        )
        // 投递留在事务提交之后：队列不可参与 DB 回滚，崩窗丢任务由任务 8
        // 每日对账兜底（规格设计）
        await enqueueOrderActivation(requireBoss(), payment.orderId)
        return {
          event,
          payment: { ...payment, status: 'SUCCEEDED', confirmedById: actorId },
          orderId: payment.orderId,
          organizationId: payment.order.organizationId,
          paymentMethod: 'BANK_TRANSFER',
          resumedWorkspaces: 0,
        }
      }

      if (payment.method === 'CONTRACT_CREDIT') {
        // 应收确认（§6.2）：订单已 FULFILLING（credit.open 时即开通），不迁移不投递；
        // 只置流水成功 + paidAt，并恢复因"账期超期"暂停的 workspace（Ruling 4）。
        // 三笔写同一事务 + 流水按 PENDING 条件更新（修复轮，同 BANK 分支竞态防护）
        let resumedWorkspaces = 0
        await prisma.$transaction(async (tx) => {
          const result = await tx.paymentTransaction.updateMany({
            where: { id: paymentId, status: 'PENDING' },
            data: { status: 'SUCCEEDED', confirmedById: actorId },
          })
          if (result.count === 0) {
            throw new PaymentStateError(
              `支付流水已被并发处理（非 PENDING），确认整体回滚：paymentId=${paymentId}`,
            )
          }
          await tx.order.update({
            where: { id: payment.orderId },
            data: { paidAt: now() },
          })
          const resumed = await tx.workspace.updateMany({
            where: {
              organizationId: payment.order.organizationId,
              status: 'SUSPENDED',
              suspendReason: CREDIT_OVERDUE_SUSPEND_REASON,
            },
            data: { status: 'ACTIVE', suspendReason: null },
          })
          resumedWorkspaces = resumed.count
        })
        return {
          event: null,
          payment: { ...payment, status: 'SUCCEEDED', confirmedById: actorId },
          orderId: payment.orderId,
          organizationId: payment.order.organizationId,
          paymentMethod: 'CONTRACT_CREDIT',
          resumedWorkspaces,
        }
      }

      // WECHAT / ALIPAY 线上通道：回调驱动，不走人工确认（任务 6 范畴）
      throw new PaymentStateError(
        `支付通道 ${payment.method} 不支持人工确认（仅 BANK_TRANSFER / CONTRACT_CREDIT 线下收款）`,
      )
    },

    async rejectVoucher(paymentId, reason, actorId) {
      const payment = await loadPaymentWithOrder(paymentId)
      if (payment.status !== 'PENDING') {
        throw new PaymentStateError(
          `支付流水状态非 PENDING，不可驳回（paymentId=${paymentId}，status=${payment.status}）`,
        )
      }

      // 迁移 + 流水 FAILED 同事务（修复轮）；流水按 PENDING 条件更新——
      // 与 confirm 竞态时 count=0 抛 PaymentStateError 整体回滚（迁移不落）
      const event = await runTransition(
        payment.orderId,
        'finance.reject',
        { actorId, note: reason },
        async (tx) => {
          const result = await tx.paymentTransaction.updateMany({
            where: { id: paymentId, status: 'PENDING' },
            data: { status: 'FAILED', rawPayload: { reason } },
          })
          if (result.count === 0) {
            throw new PaymentStateError(
              `支付流水已被并发处理（非 PENDING），驳回整体回滚：paymentId=${paymentId}`,
            )
          }
        },
      )
      return {
        event,
        payment: { ...payment, status: 'FAILED', rawPayload: { reason } },
        orderId: payment.orderId,
        organizationId: payment.order.organizationId,
      }
    },

    async openOnCredit(orderId, input, actorId) {
      const dueDays = input.dueDays
      // 遗留 B2：service 层第二道闸——router zod 限 1..3650，裸 service 直调
      // 同规（此前无上限，可开超长账期）
      if (!Number.isInteger(dueDays) || dueDays < 1 || dueDays > CREDIT_DUE_DAYS_MAX) {
        throw new InvalidDueDaysError(dueDays)
      }

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, payableCents: true, organizationId: true },
      })
      if (!order) throw new OrderNotFoundError(orderId)
      guardTransitionFrom(orderId, 'credit.open', order.status)

      // 先开通（Ruling 11）：迁移 + 账期字段 + 应收流水同事务（修复轮：闸门 + 事件 +
      // paymentMethod/dueAt + CONTRACT_CREDIT/PENDING 流线四笔写一个原子单元，
      // 崩窗不留"FULFILLING 无应收流水/dueAt"断链）；投递在事务提交之后
      const dueAt = new Date(now().getTime() + dueDays * 24 * 60 * 60 * 1000)
      let payment!: PaymentTransaction
      const event = await runTransition(orderId, 'credit.open', { actorId }, async (tx) => {
        await tx.order.update({
          where: { id: orderId },
          data: { paymentMethod: 'CONTRACT_CREDIT', dueAt },
        })
        payment = await tx.paymentTransaction.create({
          data: {
            orderId,
            method: 'CONTRACT_CREDIT',
            status: 'PENDING',
            amountCents: order.payableCents,
            currency: 'CNY',
          },
        })
      })
      await enqueueOrderActivation(requireBoss(), orderId)
      return {
        event,
        payment,
        dueAt,
        orderId,
        organizationId: order.organizationId,
        payableCents: order.payableCents,
      }
    },

    async createPayment(orderId, method) {
      // 程序性双闸（路由 zod 已挡线下通道；service 直调同规）
      if (method !== 'WECHAT' && method !== 'ALIPAY') {
        throw new PaymentStateError(
          `支付通道 ${method} 不支持线上下单（仅 WECHAT / ALIPAY；线下收款走 uploadVoucher / openOnCredit）`,
        )
      }
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true, orderNo: true, status: true, payableCents: true },
      })
      if (!order) throw new OrderNotFoundError(orderId)
      if (order.status !== 'PENDING_PAYMENT') {
        throw new PaymentStateError(
          `订单状态 ${order.status} 不可发起线上支付（仅 PENDING_PAYMENT）：orderId=${orderId}`,
        )
      }

      const channel = channelFactory(method)
      const { channelOrderNo, payUrl } = await channel.createPayment({
        orderId,
        orderNo: order.orderNo,
        amountCents: order.payableCents,
      })
      // 幂等语义（裁定）：同一订单重复 createPayment 允许，返回新单号/payUrl；
      // 旧 PENDING 流水不清理，由 payment.reconcile 每日查单对账置终态（渠道侧超时关单）
      await prisma.paymentTransaction.create({
        data: {
          orderId,
          method,
          status: 'PENDING',
          amountCents: order.payableCents,
          currency: 'CNY',
          channelOrderNo,
        },
      })
      return { payUrl, channelOrderNo }
    },

    async confirmChannelPayment(input) {
      const { paymentId, orderId, method, channelTxnNo, channelOrderNo } = input
      try {
        // 迁移闸门 + 事件 + 流水条件更新 + paidAt/paymentMethod 四笔写一个交互式事务
        // （任务 5 修复轮模式）：崩窗不留"订单 PAID + 流水 PENDING"账实断链
        await runTransition(
          orderId,
          'payment.confirmed',
          { note: input.note ?? `线上支付回调：${channelTxnNo}` },
          async (tx) => {
            const result = await tx.paymentTransaction.updateMany({
              where: { id: paymentId, status: 'PENDING' },
              data: {
                status: 'SUCCEEDED',
                channelTxnNo,
                channelOrderNo,
                ...(input.rawPayload !== undefined ? { rawPayload: input.rawPayload } : {}),
              },
            })
            if (result.count === 0) {
              // 条件更新失闸（裁定）：再读流水裁断——同交易号已 SUCCEEDED 是并发重复
              // （空回滚转 duplicate）；FAILED/REFUNDED 等其他状态是终态冲突，整体拒绝
              const current = await tx.paymentTransaction.findUnique({
                where: { id: paymentId },
              })
              if (current?.status === 'SUCCEEDED' && current.channelTxnNo === channelTxnNo) {
                throw new DuplicateCallbackSignal(
                  `并发重复回调（同交易号已置成功）：paymentId=${paymentId}，channelTxnNo=${channelTxnNo}`,
                )
              }
              throw new PaymentStateError(
                `支付流水已被并发处理（status=${current?.status ?? '流水不存在'}），线上回调确认整体回滚：paymentId=${paymentId}`,
              )
            }
            await tx.order.update({
              where: { id: orderId },
              data: { paidAt: now(), paymentMethod: method },
            })
          },
        )
      } catch (err) {
        // 事务内哨兵 → duplicate（并发赢家已完整提交，本轮回调无需再做事）
        if (err instanceof DuplicateCallbackSignal) return { duplicate: true }
        // 迁移预检被拒的并发重复：订单已被并发回调整体置 PAID——再核流水是否本交易号已处理
        if (err instanceof OrderTransitionError) {
          const current = await prisma.paymentTransaction.findUnique({
            where: { id: paymentId },
          })
          if (current?.status === 'SUCCEEDED' && current.channelTxnNo === channelTxnNo) {
            return { duplicate: true }
          }
        }
        throw err
      }
      // 投递留在事务提交之后：队列不可参与 DB 回滚。注意 enqueue 丢失窗口不在
      // payment.reconcile 兜底面（它只扫线上渠道 PENDING 流水补单，
      // "SUCCEEDED+PAID 但未投递"的订单不在其扫描面）——该窗口由任务 8 的
      // order.reconcile（PAID 停留>1h 告警）兜底
      await enqueueOrderActivation(requireBoss(), orderId)
      return { duplicate: false }
    },
  }
}
