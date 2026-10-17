import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { OrderStatus } from '@prisma/client'
import type { Prisma } from '@prisma/client'
import { router, platformProcedure } from '../../core/trpc/init.js'
import { CREDIT_DUE_DAYS_MAX } from './order-service.js'
import {
  fetchOrderDetail,
  getOrderAuditService,
  getOrderService,
  mapOrderServiceError,
  orderActorUserId,
  orderItemInput,
  orderListInclude,
  resolveOrderPrisma,
  splitOrderDetail,
  toOrderListItem,
} from './order-router.js'

/**
 * 平台侧订单管理路由（挂载于 appRouter.admin.orders，代客下单/全量视图）：
 * - create/cancel：order.manage（OPERATOR/SUPER_ADMIN；FINANCE/SUPPORT 恒拒）；
 * - list/get：order.view（FINANCE/SUPPORT 只读放行）。
 * 无企业边界（平台视角全量）；下单与状态机复用客户侧同一 OrderService，
 * 改价（discountCents>0 → remark 必填）联动复用任务 3 的 service 校验。
 */

/** 代客下单入参：organizationId 必填；discountCents 可选（service 层校验 remark 联动） */
const adminOrderCreateInput = z.object({
  organizationId: z.string().min(1),
  items: z.array(orderItemInput).min(1),
  discountCents: z.number().int().min(0).optional(),
  remark: z.string().max(500).optional(),
})

/** 状态机视图筛选：status/organizationId/q（orderNo contains，简化裁定）+ 分页 */
const adminOrderListInput = z
  .object({
    status: z.nativeEnum(OrderStatus).optional(),
    organizationId: z.string().min(1).optional(),
    q: z.string().min(1).optional(),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(20),
  })
  .optional()

export const adminOrderRouter = router({
  create: platformProcedure('order.manage')
    .input(adminOrderCreateInput)
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await getOrderService(ctx).create({
          organizationId: input.organizationId,
          items: input.items,
          actorId: orderActorUserId(ctx),
          discountCents: input.discountCents,
          remark: input.remark,
        })
        await getOrderAuditService(ctx).record({
          actorId: orderActorUserId(ctx),
          actorType: 'USER',
          action: 'order.create',
          organizationId: input.organizationId,
          target: `Order:${result.order.id}`,
          diff: {
            orderNo: result.order.orderNo,
            totalCents: result.order.totalCents,
            discountCents: result.order.discountCents,
            payableCents: result.order.payableCents,
          },
        })
        return result
      } catch (err) {
        mapOrderServiceError(err)
      }
    }),

  list: platformProcedure('order.view')
    .input(adminOrderListInput)
    .query(async ({ ctx, input }) => {
      const where: Prisma.OrderWhereInput = {}
      if (input?.status) where.status = input.status
      if (input?.organizationId) where.organizationId = input.organizationId
      if (input?.q) where.orderNo = { contains: input.q }
      const page = input?.page ?? 1
      const pageSize = input?.pageSize ?? 20
      const prisma = resolveOrderPrisma(ctx)
      const [rows, total] = await Promise.all([
        prisma.order.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: orderListInclude,
        }),
        prisma.order.count({ where }),
      ])
      return { items: rows.map(toOrderListItem), total }
    }),

  get: platformProcedure('order.view')
    .input(z.object({ orderId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const row = await fetchOrderDetail(resolveOrderPrisma(ctx), input.orderId)
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `订单不存在：${input.orderId}` })
      }
      return splitOrderDetail(row)
    }),

  cancel: platformProcedure('order.manage')
    .input(z.object({ orderId: z.string().min(1), reason: z.string().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await getOrderService(ctx).transition(input.orderId, 'cancel', {
          actorId: orderActorUserId(ctx),
          note: input.reason,
        })
      } catch (err) {
        mapOrderServiceError(err)
      }
    }),

  /**
   * 合同账期开通（任务 5，Ruling 11 先开通后收款）：order.manage（运营动作，
   * 非 payment.confirm 资金域——财务只在收款确认时介入）。
   * credit.open 迁移 PENDING_PAYMENT→FULFILLING + paymentMethod/dueAt 落库
   * + 应收流水（CONTRACT_CREDIT/PENDING）+ 投递 order.activate。
   */
  openOnCredit: platformProcedure('order.manage')
    .input(
      z.object({
        orderId: z.string().min(1),
        dueDays: z.number().int().min(1).max(CREDIT_DUE_DAYS_MAX),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await getOrderService(ctx).openOnCredit(
          input.orderId,
          { dueDays: input.dueDays },
          orderActorUserId(ctx),
        )
        await getOrderAuditService(ctx).record({
          actorId: orderActorUserId(ctx),
          actorType: 'USER',
          action: 'order.credit_open',
          organizationId: result.organizationId,
          target: `Order:${input.orderId}`,
          diff: {
            dueDays: input.dueDays,
            dueAt: result.dueAt,
            paymentId: result.payment.id,
            payableCents: result.payableCents,
          },
        })
        return result
      } catch (err) {
        mapOrderServiceError(err)
      }
    }),
})
