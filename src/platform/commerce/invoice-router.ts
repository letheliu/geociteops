import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { InvoiceStatus } from '@prisma/client'
import type { Invoice } from '@prisma/client'
import { router, orgProcedure, platformProcedure } from '../../core/trpc/init.js'
import type { Context } from '../../core/trpc/init.js'
import { getPrismaClient } from '../../core/db/client.js'
import { createAuditService } from '../audit/service.js'
import { createFilesService } from './files.js'
import { createInvoiceService } from './invoice-service.js'
import type { InvoiceService } from './invoice-service.js'
import {
  InvoiceNoConflictError,
  InvoiceNotFoundError,
  InvoiceStateError,
  InvalidInvoiceFileError,
  OrderNotPaidError,
} from './invoice-service.js'
import { orderActorUserId } from './order-router.js'

/**
 * 发票路由（任务 13，挂载于 appRouter.org.invoices / appRouter.admin.invoices）：
 * - org.invoices.list / request：orgProcedure()（任意客户角色可看可申请——开票为
 *   通用财务诉求，MEMBER/VIEWER 亦可见可申请；企业边界由 service 校验，越权/未支付
 *   统一 OrderNotPaidError → BAD_REQUEST，不泄露他企订单存在性）。
 * - admin.invoices.list / issue / reject：invoice.manage（FINANCE/SUPER_ADMIN；
 *   OPERATOR/SUPPORT 恒拒——资金域动作，含待处理列表）。
 * - 审计 invoice.request/issue/reject 在 service 层单一来源记录（两侧路由零重复）。
 * - 下载 URL 前端拼 /files/{fileKey}（GET /files/:key 会话鉴权 + key 白名单）。
 */

let defaultInvoiceService: InvoiceService | undefined

/** 取 invoice service：优先 ctx.services.invoices（测试/组装注入），否则惰性构建默认实例 */
export function getInvoiceService(ctx: Context): InvoiceService {
  const injected = (ctx as { services?: { invoices?: InvoiceService } }).services?.invoices
  if (injected) return injected
  if (!defaultInvoiceService) {
    const prisma = getPrismaClient()
    defaultInvoiceService = createInvoiceService({
      prisma,
      files: createFilesService({}),
      audit: createAuditService(prisma),
    })
  }
  return defaultInvoiceService
}

/**
 * invoice-service 命名错误 → TRPCError 映射：
 * - InvoiceStateError（状态不允许/并发失闸）/ InvoiceNoConflictError（发票号占用）→ CONFLICT；
 * - InvoiceNotFoundError → NOT_FOUND；
 * - OrderNotPaidError（未支付/越权/不存在） / InvalidInvoiceFileError（base64/大小/扩展名）→ BAD_REQUEST；
 * 其余原样上抛（INTERNAL_SERVER_ERROR 由 tRPC 兜底）。
 */
export function mapInvoiceServiceError(err: unknown): never {
  if (err instanceof InvoiceStateError || err instanceof InvoiceNoConflictError) {
    throw new TRPCError({ code: 'CONFLICT', message: err.message })
  }
  if (err instanceof InvoiceNotFoundError) {
    throw new TRPCError({ code: 'NOT_FOUND', message: err.message })
  }
  if (err instanceof OrderNotPaidError || err instanceof InvalidInvoiceFileError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
  }
  throw err
}

/** 当前客户的企业 id：orgProcedure 已保证 CUSTOMER + orgRole；空 organizationId 兜底拦截 */
function actorOrgId(ctx: Context): string {
  if (ctx.actor.kind === 'user') {
    const orgId = ctx.actor.user.organizationId
    if (orgId) return orgId
  }
  throw new TRPCError({ code: 'FORBIDDEN', message: '当前账号未挂靠企业，禁止访问企业控制台接口' })
}

/** 列表行投影：fileUrl 前端拼 /files/{fileKey}（fileKey 为空 = 尚未上传 PDF） */
function toInvoiceListItem(invoice: Invoice) {
  return {
    id: invoice.id,
    organizationId: invoice.organizationId,
    orderIds: invoice.orderIds,
    titleSnapshot: invoice.titleSnapshot,
    amountCents: invoice.amountCents,
    currency: invoice.currency,
    status: invoice.status,
    invoiceNo: invoice.invoiceNo,
    fileKey: invoice.fileKey,
    fileUrl: invoice.fileKey ? `/files/${invoice.fileKey}` : null,
    requestedById: invoice.requestedById,
    issuedById: invoice.issuedById,
    remark: invoice.remark,
    createdAt: invoice.createdAt,
    updatedAt: invoice.updatedAt,
  }
}

/** 分页入参（org/admin 共用形状：默认 20、上限 100；status 缺省 = 全部状态） */
const invoicePageInput = {
  status: z.nativeEnum(InvoiceStatus).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
}

/**
 * 客户侧发票路由（挂载于 appRouter.org.invoices）：
 * list / request 均为 orgProcedure()（任意客户角色）；申请入参 orderIds 物理限
 * 1-50（合并开票上限），去重与已支付校验在 service 层（OrderNotPaidError）。
 */
export const orgInvoicesRouter = router({
  list: orgProcedure()
    .input(z.object(invoicePageInput).optional())
    .query(async ({ ctx, input }) => {
      const organizationId = actorOrgId(ctx)
      try {
        const { items, total } = await getInvoiceService(ctx).list(organizationId, input)
        return { items: items.map(toInvoiceListItem), total }
      } catch (err) {
        mapInvoiceServiceError(err)
      }
    }),

  request: orgProcedure()
    .input(
      z.object({
        orderIds: z.array(z.string().min(1)).min(1).max(50),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = actorOrgId(ctx)
      try {
        const result = await getInvoiceService(ctx).request(
          { orderIds: input.orderIds },
          orderActorUserId(ctx),
          organizationId,
        )
        return { invoice: toInvoiceListItem(result.invoice) }
      } catch (err) {
        mapInvoiceServiceError(err)
      }
    }),
})

/**
 * 平台侧发票路由（挂载于 appRouter.admin.invoices，财务工作台）：
 * list 全企业（status 筛选 + 分页，createdAt desc）；issue 登记签发（invoiceNo 唯一 +
 * 可选 PDF 上传 7MB 白名单同回单规则）；reject 驳回（remark=reason）。
 */
export const adminInvoicesRouter = router({
  list: platformProcedure('invoice.manage')
    .input(z.object(invoicePageInput).optional())
    .query(async ({ ctx, input }) => {
      try {
        const { items, total } = await getInvoiceService(ctx).listAll(input)
        return { items: items.map(toInvoiceListItem), total }
      } catch (err) {
        mapInvoiceServiceError(err)
      }
    }),

  issue: platformProcedure('invoice.manage')
    .input(
      z.object({
        invoiceId: z.string().min(1),
        invoiceNo: z.string().min(1).max(64),
        fileName: z.string().min(1).max(255).optional(),
        contentBase64: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await getInvoiceService(ctx).issue(
          input.invoiceId,
          { invoiceNo: input.invoiceNo, fileName: input.fileName, contentBase64: input.contentBase64 },
          orderActorUserId(ctx),
        )
        return { invoice: toInvoiceListItem(result.invoice) }
      } catch (err) {
        mapInvoiceServiceError(err)
      }
    }),

  reject: platformProcedure('invoice.manage')
    .input(z.object({ invoiceId: z.string().min(1), reason: z.string().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await getInvoiceService(ctx).reject(
          input.invoiceId,
          input.reason,
          orderActorUserId(ctx),
        )
        return { invoice: toInvoiceListItem(result.invoice) }
      } catch (err) {
        mapInvoiceServiceError(err)
      }
    }),
})
