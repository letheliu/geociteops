import type { Invoice, InvoiceStatus, Prisma, PrismaClient } from '@prisma/client'
import type { AuditService } from '../audit/service.js'
import type { FilesService, FileExt } from './files.js'
import { VOUCHER_EXTENSIONS, VOUCHER_MAX_BYTES } from './order-service.js'

// ---------------------------------------------------------------------------
// 手工发票服务（任务 13，规格 §6.3 发票 P2=手工）：
//   request（客户申请：合并多张已支付订单，抬头快照自 org.billingProfile）
//   → issue（财务登记签发：invoiceNo + 可选 PDF 落盘）/ reject（财务驳回）。
// 开票前提 = 订单 paidAt != null（收款到账才可开票）；金额恒整数分
// （amountCents = Σ payableCents，orderIds 先去重防同单重复计入）。
// 同一订单已有 PENDING 发票未处理时再次申请：放行（裁定——P2 手工流程，
// 财务驳回旧的或合并处理，不做防重）。
// ---------------------------------------------------------------------------

/** 订单不可开票（未支付 / 已全额退款 / 非本企业 / 不存在）：name 固定为 ORDER_NOT_PAID */
export class OrderNotPaidError extends Error {
  /** 违规 orderId 列表（越权、已退款与不存在统一并入，不泄露存在性差异） */
  readonly orderIds: string[]

  constructor(orderIds: string[]) {
    super(
      `存在不可开票的订单（未支付、已全额退款或非本企业）：${orderIds.join('、')}（仅已支付且未全额退款的订单可申请开票）`,
    )
    this.name = 'ORDER_NOT_PAID'
    this.orderIds = orderIds
  }
}

/** 发票不存在：name 固定为 INVOICE_NOT_FOUND（router 映射 404） */
export class InvoiceNotFoundError extends Error {
  constructor(invoiceId: string) {
    super(`发票不存在：${invoiceId}`)
    this.name = 'INVOICE_NOT_FOUND'
  }
}

/** 发票状态不允许该操作（非 PENDING 签发/驳回、竞态条件更新失闸）：name 固定为 INVOICE_STATE */
export class InvoiceStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'INVOICE_STATE'
  }
}

/** 发票号已被占用（invoiceNo @unique 预查命中 / P2002 竞态）：name 固定为 INVOICE_NO_CONFLICT */
export class InvoiceNoConflictError extends Error {
  constructor(invoiceNo: string, invoiceId: string) {
    super(`发票号已被占用：${invoiceNo}（当前发票 invoiceId=${invoiceId}，invoiceNo 全局唯一）`)
    this.name = 'INVOICE_NO_CONFLICT'
  }
}

/** 发票文件非法（base64 形态 / 超 7MB / 扩展名白名单外）：name 固定为 INVALID_INVOICE_FILE */
export class InvalidInvoiceFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'INVALID_INVOICE_FILE'
  }
}

export interface InvoiceRequestInput {
  /** 合并开票的订单 id 列表（service 层去重；router 层 zod 限 1-50） */
  orderIds: string[]
}

export interface InvoiceIssueInput {
  /** 发票号（全局唯一，冲突 InvoiceNoConflictError） */
  invoiceNo: string
  /** 原始文件名（扩展名取自此处，白名单 png/jpg/pdf） */
  fileName?: string
  /** PDF 文件内容 base64（解码后 ≤ 7MB）；缺省 = 纯登记不落盘 */
  contentBase64?: string
}

export interface InvoiceListOptions {
  status?: InvoiceStatus
  page?: number
  pageSize?: number
}

export interface InvoiceListResult {
  items: Invoice[]
  total: number
}

export interface InvoiceServiceDeps {
  prisma: PrismaClient
  /** 文件落盘（发票 PDF）与孤儿清理（遗留 D6）；必注入 */
  files: Pick<FilesService, 'put' | 'remove'>
  /** 审计（invoice.request/issue/reject 三动作，服务层单一来源） */
  audit: AuditService
}

export interface InvoiceService {
  /** 客户申请开票：校验订单全部属本 org 且已支付（否则 OrderNotPaidError 含违规列表）；
   *  titleSnapshot = org.billingProfile 原样快照（空对象也存，签发时以快照为准） */
  request(
    input: InvoiceRequestInput,
    actorId: string,
    organizationId: string,
  ): Promise<{ invoice: Invoice }>
  /** 财务登记签发：invoiceNo 唯一（预查 + P2002 双闸）+ 可选 PDF 落盘 → ISSUED；
   *  落库失败（唯一冲突 / 竞态失闸）时清理已落盘的孤儿 PDF（遗留 D6，尽力而为） */
  issue(invoiceId: string, input: InvoiceIssueInput, actorId: string): Promise<{ invoice: Invoice }>
  /** 财务驳回：REJECTED + remark=reason */
  reject(invoiceId: string, reason: string, actorId: string): Promise<{ invoice: Invoice }>
  /** 客户侧列表：本企业 + status 筛选 + 分页（createdAt desc） */
  list(organizationId: string, options?: InvoiceListOptions): Promise<InvoiceListResult>
  /** 平台侧列表：全企业 + status 筛选 + 分页 */
  listAll(options?: InvoiceListOptions): Promise<InvoiceListResult>
}

/** JsonValue → InputJsonValue 容错投影（null/undefined/非对象按空对象，空抬头快照存 {}） */
function asSnapshot(raw: Prisma.JsonValue | undefined | null): Prisma.InputJsonValue {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Prisma.InputJsonValue
  }
  return {}
}

/**
 * 发票文件入参校验与解码（照 order-service decodeVoucher 模式，单一常量来源）：
 * base64 形态 → 大小上限（解码后 ≤ 7MB）→ 扩展名白名单（png/jpg/pdf），
 * 顺序即错误优先级。无 contentBase64 返回 null（纯登记路径）。
 */
function decodeInvoiceFile(input: InvoiceIssueInput): {
  buffer: Buffer
  ext: FileExt
} | null {
  if (input.contentBase64 === undefined) return null
  const compact = input.contentBase64.replace(/\s+/g, '')
  if (compact === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new InvalidInvoiceFileError('contentBase64 不是合法的 base64 编码')
  }
  const buffer = Buffer.from(compact, 'base64')
  if (buffer.byteLength > VOUCHER_MAX_BYTES) {
    throw new InvalidInvoiceFileError(
      `发票文件过大：解码后 ${buffer.byteLength} 字节，上限 ${VOUCHER_MAX_BYTES} 字节（7MB）`,
    )
  }
  const extMatch =
    typeof input.fileName === 'string' ? /\.([A-Za-z0-9]+)$/.exec(input.fileName) : null
  const ext = extMatch ? extMatch[1].toLowerCase() : ''
  if (!(VOUCHER_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new InvalidInvoiceFileError(
      `发票扩展名不在白名单（png/jpg/pdf）：${JSON.stringify(input.fileName ?? '')}`,
    )
  }
  return { buffer, ext: ext as FileExt }
}

/**
 * 手工发票服务。并发闸门复用退款模式：issue/reject 以
 * updateMany WHERE status='PENDING' 条件更新（count=0 → InvoiceStateError
 * 整体拒绝），invoiceNo 唯一为预查 + P2002 双闸（竞态窗口由数据库兜底）。
 */
export function createInvoiceService(deps: InvoiceServiceDeps): InvoiceService {
  const { prisma, files, audit } = deps

  /**
   * 签发落库失败后的孤儿 PDF 清理（遗留 D6）：files.put 成功但条件更新失闸 /
   * 唯一冲突时数据库无行引用该文件——unlink 尽力而为（清理自身失败仅日志，
   * 不掩盖原错误）；纯登记路径（fileKey=null）no-op。
   */
  async function removeOrphanIssueFile(fileKey: string | null): Promise<void> {
    if (!fileKey) return
    try {
      await files.remove(fileKey)
    } catch (err) {
      console.error(`[invoice-service] 孤儿发票文件清理失败（fileKey=${fileKey}）`, err)
    }
  }

  /** 分页查询骨架：where + createdAt desc + skip/take（list/listAll 共用） */
  async function pageQuery(
    where: Prisma.InvoiceWhereInput,
    options?: InvoiceListOptions,
  ): Promise<InvoiceListResult> {
    const page = options?.page ?? 1
    const pageSize = options?.pageSize ?? 20
    const [items, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.invoice.count({ where }),
    ])
    return { items, total }
  }

  return {
    async request(input, actorId, organizationId) {
      // 去重（防同单重复计入金额）；zod 已限 1-50，此处为第二道闸
      const uniqueIds = [...new Set(input.orderIds)]
      const orders = await prisma.order.findMany({
        where: { id: { in: uniqueIds } },
        select: { id: true, organizationId: true, status: true, paidAt: true, payableCents: true },
      })
      // 违规收集：不存在 / 非本企业 / 未支付 / 全额退款（遗留 A4）统一并入
      // （不泄露存在性差异）。PARTIALLY_REFUNDED 保留可开票——部分退款的钱
      // 大部分已收，开票金额语义由财务把握（合并开票金额 = Σ payableCents，
      // 有争议时财务在 issue 前人工核对），全额退款（REFUNDED）分文未留不可开
      const violating = uniqueIds.filter((id) => {
        const order = orders.find((o) => o.id === id)
        return (
          !order ||
          order.organizationId !== organizationId ||
          order.paidAt === null ||
          order.status === 'REFUNDED'
        )
      })
      if (violating.length > 0) {
        throw new OrderNotPaidError(violating)
      }

      // 抬头快照：org.billingProfile 原样（空对象也存——客户可后补抬头，签发以快照为准）
      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { billingProfile: true },
      })
      const amountCents = orders.reduce((sum, order) => sum + order.payableCents, 0)

      const invoice = await prisma.invoice.create({
        data: {
          organizationId,
          orderIds: uniqueIds,
          titleSnapshot: asSnapshot(org?.billingProfile),
          amountCents,
          currency: 'CNY',
          status: 'PENDING',
          requestedById: actorId,
        },
      })
      await audit.record({
        actorType: 'USER',
        actorId,
        action: 'invoice.request',
        organizationId,
        target: `Invoice:${invoice.id}`,
        diff: { orderIds: uniqueIds, amountCents, currency: 'CNY' },
      })
      return { invoice }
    },

    async issue(invoiceId, input, actorId) {
      const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } })
      if (!invoice) throw new InvoiceNotFoundError(invoiceId)
      if (invoice.status !== 'PENDING') {
        throw new InvoiceStateError(
          `发票状态 ${invoice.status} 不可签发（invoiceId=${invoiceId}，仅 PENDING）`,
        )
      }

      // invoiceNo 唯一预查（竞态窗口由下方 P2002 兜底）；命中即拒，不落盘文件
      const taken = await prisma.invoice.findUnique({
        where: { invoiceNo: input.invoiceNo },
        select: { id: true },
      })
      if (taken) throw new InvoiceNoConflictError(input.invoiceNo, invoiceId)

      // PDF 落盘（照 uploadVoucher 模式：先写盘后写库）；落库失败时由下方
      // removeOrphanIssueFile 清理孤儿文件（遗留 D6——不再接受"孤儿文件可接受"）
      const decoded = decodeInvoiceFile(input)
      const fileKey = decoded ? await files.put(decoded.buffer, decoded.ext) : null

      // 条件更新（并发闸）：PENDING 才可签发；P2002 = 预查后竞态占用同号 → 唯一冲突。
      // 失闸/冲突即数据库无行引用已落盘文件 → 清理孤儿 PDF（尽力而为）后按原语义拒绝
      let updated: { count: number }
      try {
        updated = await prisma.invoice.updateMany({
          where: { id: invoiceId, status: 'PENDING' },
          data: {
            status: 'ISSUED',
            invoiceNo: input.invoiceNo,
            fileKey,
            issuedById: actorId,
          },
        })
      } catch (err) {
        await removeOrphanIssueFile(fileKey)
        if ((err as { code?: string }).code === 'P2002') {
          throw new InvoiceNoConflictError(input.invoiceNo, invoiceId)
        }
        throw err
      }
      if (updated.count === 0) {
        await removeOrphanIssueFile(fileKey)
        throw new InvoiceStateError(
          `发票已被并发处理（非 PENDING），签发整体拒绝：invoiceId=${invoiceId}`,
        )
      }

      // 条件更新成功后回读 DB 真实行态（含落库后的全字段），不再手工合成返回对象
      const fresh = await prisma.invoice.findUnique({ where: { id: invoiceId } })
      if (!fresh) {
        // count=1 后行消失属存储层异常，按状态失闸语义整体拒绝（不审计）
        throw new InvoiceStateError(
          `发票签发后回读失败（行不存在）：invoiceId=${invoiceId}`,
        )
      }

      await audit.record({
        actorType: 'USER',
        actorId,
        action: 'invoice.issue',
        organizationId: invoice.organizationId,
        target: `Invoice:${invoiceId}`,
        diff: { invoiceNo: input.invoiceNo, fileKey, amountCents: invoice.amountCents },
      })
      return { invoice: fresh }
    },

    async reject(invoiceId, reason, actorId) {
      const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } })
      if (!invoice) throw new InvoiceNotFoundError(invoiceId)
      if (invoice.status !== 'PENDING') {
        throw new InvoiceStateError(
          `发票状态 ${invoice.status} 不可驳回（invoiceId=${invoiceId}，仅 PENDING）`,
        )
      }

      const updated = await prisma.invoice.updateMany({
        where: { id: invoiceId, status: 'PENDING' },
        data: { status: 'REJECTED', remark: reason },
      })
      if (updated.count === 0) {
        throw new InvoiceStateError(
          `发票已被并发处理（非 PENDING），驳回整体拒绝：invoiceId=${invoiceId}`,
        )
      }

      // 条件更新成功后回读 DB 真实行态（含落库后的全字段），不再手工合成返回对象
      const fresh = await prisma.invoice.findUnique({ where: { id: invoiceId } })
      if (!fresh) {
        throw new InvoiceStateError(
          `发票驳回后回读失败（行不存在）：invoiceId=${invoiceId}`,
        )
      }

      await audit.record({
        actorType: 'USER',
        actorId,
        action: 'invoice.reject',
        organizationId: invoice.organizationId,
        target: `Invoice:${invoiceId}`,
        diff: { reason },
      })
      return { invoice: fresh }
    },

    async list(organizationId, options) {
      const where: Prisma.InvoiceWhereInput = { organizationId }
      if (options?.status) where.status = options.status
      return pageQuery(where, options)
    },

    async listAll(options) {
      const where: Prisma.InvoiceWhereInput = {}
      if (options?.status) where.status = options.status
      return pageQuery(where, options)
    },
  }
}
