import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { router, platformProcedure } from '../../core/trpc/init.js'
import {
  getOrderAuditService,
  getOrderService,
  mapOrderServiceError,
  orderActorUserId,
  resolveOrderPrisma,
} from './order-router.js'

/**
 * 平台侧收款路由（挂载于 appRouter.admin.payments，任务 5）：
 * - list/confirm/reject 一律 payment.confirm（FINANCE/SUPER_ADMIN；OPERATOR/SUPPORT 恒拒）——
 *   资金域动作（含待确认列表，避免无资金权限者探得回单/应收流水）。
 * - list 两视图：VOUCHER = 待确认回单（BANK_TRANSFER/PENDING）；
 *   CREDIT = 应收账期（CONTRACT_CREDIT/PENDING）。
 * 服务复用客户侧同一 OrderService（confirmPayment/rejectVoucher），
 * 审计动作 payment.confirm / payment.reject。
 */

/** 收款工作台列表视图 */
const adminPaymentListInput = z
  .object({
    view: z.enum(['VOUCHER', 'CREDIT']).default('VOUCHER'),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(20),
  })
  .optional()

/** 列表行 include：订单摘要（orderNo/归属/状态/金额/账期） */
const paymentListInclude = {
  order: {
    select: {
      id: true,
      orderNo: true,
      organizationId: true,
      status: true,
      payableCents: true,
      dueAt: true,
      paidAt: true,
    },
  },
} satisfies Prisma.PaymentTransactionInclude

type PaymentListRow = Prisma.PaymentTransactionGetPayload<{ include: typeof paymentListInclude }>

function toPaymentListItem(payment: PaymentListRow) {
  return {
    id: payment.id,
    orderId: payment.orderId,
    method: payment.method,
    amountCents: payment.amountCents,
    currency: payment.currency,
    status: payment.status,
    voucherFileKey: payment.voucherFileKey,
    confirmedById: payment.confirmedById,
    createdAt: payment.createdAt,
    order: payment.order,
  }
}

export const adminPaymentRouter = router({
  list: platformProcedure('payment.confirm')
    .input(adminPaymentListInput)
    .query(async ({ ctx, input }) => {
      // 两视图共用 PENDING 待处理闸，仅按通道分流
      const where: Prisma.PaymentTransactionWhereInput =
        input?.view === 'CREDIT'
          ? { method: 'CONTRACT_CREDIT', status: 'PENDING' }
          : { method: 'BANK_TRANSFER', status: 'PENDING' }
      const page = input?.page ?? 1
      const pageSize = input?.pageSize ?? 20
      const prisma = resolveOrderPrisma(ctx)
      const [rows, total] = await Promise.all([
        prisma.paymentTransaction.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: paymentListInclude,
        }),
        prisma.paymentTransaction.count({ where }),
      ])
      return { items: rows.map(toPaymentListItem), total }
    }),

  confirm: platformProcedure('payment.confirm')
    .input(z.object({ paymentId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await getOrderService(ctx).confirmPayment(
          input.paymentId,
          orderActorUserId(ctx),
        )
        await getOrderAuditService(ctx).record({
          actorId: orderActorUserId(ctx),
          actorType: 'USER',
          action: 'payment.confirm',
          organizationId: result.organizationId,
          target: `Payment:${input.paymentId}`,
          diff: {
            orderId: result.orderId,
            method: result.paymentMethod,
            // 遗留 B3：流水终态取结果对象实际值（此前硬编码 'SUCCEEDED'，service
            // 返回值调整时审计会与库内实况漂移）
            status: result.payment.status,
            resumedWorkspaces: result.resumedWorkspaces,
          },
        })
        return result
      } catch (err) {
        mapOrderServiceError(err)
      }
    }),

  reject: platformProcedure('payment.confirm')
    .input(z.object({ paymentId: z.string().min(1), reason: z.string().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await getOrderService(ctx).rejectVoucher(
          input.paymentId,
          input.reason,
          orderActorUserId(ctx),
        )
        await getOrderAuditService(ctx).record({
          actorId: orderActorUserId(ctx),
          actorType: 'USER',
          action: 'payment.reject',
          organizationId: result.organizationId,
          target: `Payment:${input.paymentId}`,
          diff: {
            orderId: result.orderId,
            // 遗留 B3：同上，取结果对象实际终态（此前硬编码 'FAILED'）
            status: result.payment.status,
            reason: input.reason,
          },
        })
        return result
      } catch (err) {
        mapOrderServiceError(err)
      }
    }),
})
