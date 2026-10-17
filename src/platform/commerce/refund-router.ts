import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { RefundStatus } from '@prisma/client'
import type { Prisma } from '@prisma/client'
import { router, platformProcedure } from '../../core/trpc/init.js'
import type { Context } from '../../core/trpc/init.js'
import { getPrismaClient } from '../../core/db/client.js'
import { createAuditService } from '../audit/service.js'
import { createEntitlementService } from '../billing/entitlement-service.js'
// 遗留 B8：装配/错误映射助手改自 router-utils 导入（此前经 order-router，
// 与 order-router 的 refundRequest → getRefundService 反向引用构成 ESM 环）
import {
  getOrderService,
  mapOrderServiceError,
  orderActorUserId,
  resolveOrderPrisma,
} from './router-utils.js'
import { createRefundService } from './refund-service.js'
import type { RefundService } from './refund-service.js'
import {
  RefundAlreadyExecutedError,
  RefundAmountExceededError,
  RefundNotFoundError,
  RefundNotPaidError,
  RefundStateError,
} from './refund-service.js'

/**
 * 平台侧退款路由（挂载于 appRouter.admin.refunds，任务 12）：
 * - list/approve/reject 一律 refund.manage（FINANCE/SUPER_ADMIN；OPERATOR/SUPPORT 恒拒）——
 *   资金域动作（含待审批列表，避免无资金权限者探得退款流水）。
 * - list 默认 PENDING 待审批工作队列（FIFO：createdAt asc），支持 status / 关联
 *   order organizationId 筛选 + 分页；行带 suggestedAmountCents（calcRefundable
 *   同源计算）前置展示给财务。
 * - approve 线上渠道（WECHAT/ALIPAY）走渠道退款，线下（转账/账期）为打款后登记；
 *   reject 驳回回退申请前状态（Ruling 12）。审计 refund.request/approve/reject
 *   在 service 层单一来源记录（两侧路由零重复）。
 */

let defaultRefundService: RefundService | undefined

/** 取 refund service：优先 ctx.services.refunds（测试/组装注入），否则惰性构建默认实例 */
export function getRefundService(ctx: Context): RefundService {
  const injected = (ctx as { services?: { refunds?: RefundService } }).services?.refunds
  if (injected) return injected
  if (!defaultRefundService) {
    const prisma = getPrismaClient()
    defaultRefundService = createRefundService({
      prisma,
      orders: getOrderService(ctx),
      entitlements: createEntitlementService({ prisma }),
      audit: createAuditService(prisma),
    })
  }
  return defaultRefundService
}

/**
 * refund-service 命名错误 → TRPCError 映射：
 * - RefundStateError（流水状态不允许）/ RefundAlreadyExecutedError（重复执行）→ CONFLICT；
 * - RefundNotFoundError → NOT_FOUND；
 * - RefundAmountExceededError（金额非法/超上限）/ RefundNotPaidError（原流水未收款，
 *   终审 I3——账期/转账未到账不可执行退款）→ BAD_REQUEST；
 * 其余复用订单域映射（OrderTransitionError → CONFLICT、OrderNotFoundError → NOT_FOUND 等）。
 */
export function mapRefundServiceError(err: unknown): never {
  if (err instanceof RefundStateError || err instanceof RefundAlreadyExecutedError) {
    throw new TRPCError({ code: 'CONFLICT', message: err.message })
  }
  if (err instanceof RefundNotFoundError) {
    throw new TRPCError({ code: 'NOT_FOUND', message: err.message })
  }
  if (err instanceof RefundAmountExceededError || err instanceof RefundNotPaidError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
  }
  mapOrderServiceError(err)
}

/** 退款工作台列表入参：status 缺省 PENDING（待审批优先）+ 企业筛选 + 分页 */
const adminRefundListInput = z
  .object({
    status: z.nativeEnum(RefundStatus).optional(),
    organizationId: z.string().min(1).optional(),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(20),
  })
  .optional()

/** 列表行 include：订单摘要（归属/状态/金额）+ 原支付通道（线上/线下判别） */
const refundListInclude = {
  order: {
    select: {
      id: true,
      orderNo: true,
      organizationId: true,
      status: true,
      payableCents: true,
      refundedCents: true,
    },
  },
  payment: {
    select: { id: true, method: true, status: true, channelOrderNo: true },
  },
} satisfies Prisma.RefundTransactionInclude

type RefundListRow = Prisma.RefundTransactionGetPayload<{ include: typeof refundListInclude }>

function toRefundListItem(refund: RefundListRow) {
  return {
    id: refund.id,
    orderId: refund.orderId,
    paymentId: refund.paymentId,
    amountCents: refund.amountCents,
    currency: refund.currency,
    reason: refund.reason,
    status: refund.status,
    requestedById: refund.requestedById,
    approvedById: refund.approvedById,
    channelRefundNo: refund.channelRefundNo,
    executedAt: refund.executedAt,
    createdAt: refund.createdAt,
    order: refund.order,
    payment: refund.payment,
  }
}

export const adminRefundRouter = router({
  /**
   * 待审批列表（refund.manage）：缺省 PENDING、createdAt asc（FIFO 工作队列）；
   * 每行附 suggestedAmountCents = calcRefundable（proration/上限同源计算，
   * 供财务在 approve 前核对建议执行金额）。
   */
  list: platformProcedure('refund.manage')
    .input(adminRefundListInput)
    .query(async ({ ctx, input }) => {
      const where: Prisma.RefundTransactionWhereInput = {
        status: input?.status ?? 'PENDING',
      }
      if (input?.organizationId) where.order = { organizationId: input.organizationId }
      const page = input?.page ?? 1
      const pageSize = input?.pageSize ?? 20
      const prisma = resolveOrderPrisma(ctx)
      const [rows, total] = await Promise.all([
        prisma.refundTransaction.findMany({
          where,
          orderBy: { createdAt: 'asc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: refundListInclude,
        }),
        prisma.refundTransaction.count({ where }),
      ])
      const service = getRefundService(ctx)
      const items = await Promise.all(
        rows.map(async (row) => ({
          ...toRefundListItem(row),
          suggestedAmountCents: await service.calcRefundable(row.order),
        })),
      )
      return { items, total }
    }),

  /** 审批执行（refund.manage，财务）：线上渠道退款 / 线下打款登记；executeAmountCents 可在上限内酌减 */
  approve: platformProcedure('refund.manage')
    .input(
      z.object({
        refundId: z.string().min(1),
        executeAmountCents: z.number().int().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await getRefundService(ctx).approve(
          input.refundId,
          { executeAmountCents: input.executeAmountCents },
          orderActorUserId(ctx),
        )
      } catch (err) {
        mapRefundServiceError(err)
      }
    }),

  /** 驳回（refund.manage，财务）：流水 REJECTED + 订单回退申请前状态（Ruling 12） */
  reject: platformProcedure('refund.manage')
    .input(z.object({ refundId: z.string().min(1), reason: z.string().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await getRefundService(ctx).reject(
          input.refundId,
          input.reason,
          orderActorUserId(ctx),
        )
      } catch (err) {
        mapRefundServiceError(err)
      }
    }),
})
