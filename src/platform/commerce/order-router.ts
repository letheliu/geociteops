import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import type { Prisma, PrismaClient } from '@prisma/client'
import { router, orgProcedure, authedProcedure } from '../../core/trpc/init.js'
import type { Context } from '../../core/trpc/init.js'
import {
  getOrderAuditService,
  getOrderService,
  mapOrderServiceError,
  orderActorUserId,
  resolveOrderPrisma,
} from './router-utils.js'
import { getRefundService, mapRefundServiceError } from './refund-router.js'

/**
 * 客户侧订单路由（挂载于 appRouter.orders）。本文件的装配/映射/投影助手
 * 导出供 admin-order-router 复用（同一 service、同一投影，保证两侧同源）。
 *
 * 遗留 B8：装配/错误映射助手已拆至 router-utils.ts（order-router 的
 * refundRequest 与 refund-router 的装配互相引用成 ESM 环），此处 re-export
 * 保持既有从 order-router.js 导入的模块（admin-order-router /
 * admin-payment-router / invoice-router）不需改动。
 */
export {
  getOrderAuditService,
  getOrderService,
  mapOrderServiceError,
  orderActorUserId,
  resolveOrderPrisma,
} from './router-utils.js'

/** 当前客户的企业 id：orgProcedure 已保证 CUSTOMER + orgRole；空 organizationId 兜底拦截 */
function actorOrgId(ctx: Context): string {
  if (ctx.actor.kind === 'user') {
    const orgId = ctx.actor.user.organizationId
    if (orgId) return orgId
  }
  throw new TRPCError({ code: 'FORBIDDEN', message: '当前账号未挂靠企业，禁止访问企业控制台接口' })
}

// ---------------------------------------------------------------------------
// 投影：list 行（客户侧/admin 共用）与 get 详情
// ---------------------------------------------------------------------------

/** list 行项 include：快照名所需的最小列集（admin 复用，保证两侧投影同源） */
export const orderListInclude = {
  items: {
    select: { id: true, planId: true, quantity: true, unitPriceCents: true, planSnapshot: true },
  },
} satisfies Prisma.OrderInclude

type OrderListRow = Prisma.OrderGetPayload<{ include: typeof orderListInclude }>

/** planSnapshot.name 安全提取（JsonValue → string | null） */
function snapshotName(snapshot: Prisma.JsonValue): string | null {
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    const name = (snapshot as { name?: unknown }).name
    if (typeof name === 'string') return name
  }
  return null
}

/** list 行投影（裁定字段集 + organizationId，供平台侧区分归属） */
export function toOrderListItem(order: OrderListRow) {
  return {
    id: order.id,
    orderNo: order.orderNo,
    organizationId: order.organizationId,
    status: order.status,
    totalCents: order.totalCents,
    discountCents: order.discountCents,
    payableCents: order.payableCents,
    refundedCents: order.refundedCents,
    paymentMethod: order.paymentMethod,
    dueAt: order.dueAt,
    paidAt: order.paidAt,
    createdAt: order.createdAt,
    items: order.items.map((item) => ({
      id: item.id,
      planId: item.planId,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      name: snapshotName(item.planSnapshot),
    })),
  }
}

/** get 详情 include：行项全行（含快照）+ 支付流水（回单/在线支付预览）+ 事件时间线（createdAt asc，id tiebreak） */
const orderDetailInclude = {
  items: { orderBy: { id: 'asc' as const } },
  payments: { orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }] },
  events: { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] },
} satisfies Prisma.OrderInclude

type OrderDetailRow = Prisma.OrderGetPayload<{ include: typeof orderDetailInclude }>

/** get 详情查询（客户侧/admin 共用）：返回 { order(去关系), items, payments, events } 形状的原料行 */
export function fetchOrderDetail(
  prisma: PrismaClient,
  orderId: string,
): Promise<OrderDetailRow | null> {
  return prisma.order.findUnique({
    where: { id: orderId },
    include: orderDetailInclude,
  })
}

/** OrderDetailRow → { order, items, payments, events }（order 为去关系后的标量字段全集） */
export function splitOrderDetail(row: OrderDetailRow) {
  const { items, payments, events, ...order } = row
  return { order, items, payments, events }
}

// ---------------------------------------------------------------------------
// 输入 schema
// ---------------------------------------------------------------------------

export const orderItemInput = z.object({
  planId: z.string().min(1),
  /** ≥ 1 整数（zod 物理拒绝 0/负数/小数；service 层为第二道闸） */
  quantity: z.number().int().min(1),
  /** 加购包 / 专业服务目标 workspace */
  workspaceId: z.string().min(1).optional(),
})

/**
 * 客户侧下单入参：strict——物理排除 discountCents/organizationId
 * （改价为平台代客专属能力；企业边界恒由 actor 派生）。
 */
const orgOrderCreateInput = z
  .object({
    items: z.array(orderItemInput).min(1),
    remark: z.string().max(500).optional(),
  })
  .strict()

/** 分页入参（客户/admin 共用形状：默认 20、上限 100） */
const pageInput = {
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
}

/**
 * 回单上传入参（任务 5）：contentBase64 物理上限由 service 层按解码后字节数
 * （≤ 7MB）判定——base64 长度与原始大小的换算因 padding/空白而不定，解码后判更准。
 */
const uploadVoucherInput = z.object({
  orderId: z.string().min(1),
  fileName: z.string().min(1).max(255).optional(),
  contentBase64: z.string().min(1),
})

/**
 * 线上支付发起入参（任务 6）：method 物理限定线上通道（线下收款走回单/账期流程），
 * service 层为第二道闸。
 */
const createPaymentInput = z.object({
  orderId: z.string().min(1),
  method: z.enum(['WECHAT', 'ALIPAY']),
})

/**
 * 企业控制台订单路由（挂载于 appRouter.orders）：
 * - create/cancel/uploadVoucher/createPayment/refundRequest：order.create（ORG_OWNER 经
 *   '*' 通配；ORG_MEMBER 不可下单/上传回单/申请退款）；
 * - list/get：order.view（ORG_MEMBER 可看本企业订单，Ruling 14；ORG_VIEWER 恒拒）。
 * 越权（他企业订单）一律 NOT_FOUND，不泄露订单存在性（照 org router 惯例）。
 */
export const orderRouter = router({
  create: orgProcedure('order.create')
    .input(orgOrderCreateInput)
    .mutation(async ({ ctx, input }) => {
      const organizationId = actorOrgId(ctx)
      try {
        const result = await getOrderService(ctx).create({
          organizationId,
          items: input.items,
          actorId: orderActorUserId(ctx),
          remark: input.remark,
        })
        await getOrderAuditService(ctx).record({
          actorId: orderActorUserId(ctx),
          actorType: 'USER',
          action: 'order.create',
          organizationId,
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

  list: orgProcedure('order.view')
    .input(z.object(pageInput).optional())
    .query(async ({ ctx, input }) => {
      const organizationId = actorOrgId(ctx)
      const page = input?.page ?? 1
      const pageSize = input?.pageSize ?? 20
      const where: Prisma.OrderWhereInput = { organizationId }
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

  get: orgProcedure('order.view')
    .input(z.object({ orderId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const organizationId = actorOrgId(ctx)
      const row = await fetchOrderDetail(resolveOrderPrisma(ctx), input.orderId)
      if (!row || row.organizationId !== organizationId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `订单不存在：${input.orderId}` })
      }
      return splitOrderDetail(row)
    }),

  cancel: orgProcedure('order.create')
    .input(z.object({ orderId: z.string().min(1), reason: z.string().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const organizationId = actorOrgId(ctx)
      // 企业边界前置校验（不匹配/不存在一律 NOT_FOUND，不泄露存在性）
      const order = await resolveOrderPrisma(ctx).order.findUnique({
        where: { id: input.orderId },
        select: { organizationId: true },
      })
      if (!order || order.organizationId !== organizationId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `订单不存在：${input.orderId}` })
      }
      try {
        return await getOrderService(ctx).transition(input.orderId, 'cancel', {
          actorId: orderActorUserId(ctx),
          note: input.reason,
        })
      } catch (err) {
        mapOrderServiceError(err)
      }
    }),

  uploadVoucher: orgProcedure('order.create')
    .input(uploadVoucherInput)
    .mutation(async ({ ctx, input }) => {
      const organizationId = actorOrgId(ctx)
      // 企业边界前置校验（照 cancel 模式：不匹配/不存在一律 NOT_FOUND）
      const order = await resolveOrderPrisma(ctx).order.findUnique({
        where: { id: input.orderId },
        select: { organizationId: true },
      })
      if (!order || order.organizationId !== organizationId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `订单不存在：${input.orderId}` })
      }
      try {
        const result = await getOrderService(ctx).uploadVoucher(
          input.orderId,
          { fileName: input.fileName, contentBase64: input.contentBase64 },
          orderActorUserId(ctx),
        )
        await getOrderAuditService(ctx).record({
          actorId: orderActorUserId(ctx),
          actorType: 'USER',
          action: 'order.voucher_upload',
          organizationId,
          target: `Order:${input.orderId}`,
          diff: {
            paymentId: result.payment.id,
            voucherFileKey: result.voucherFileKey,
            amountCents: result.payment.amountCents,
          },
        })
        return result
      } catch (err) {
        mapOrderServiceError(err)
      }
    }),

  /**
   * 发起线上支付（任务 6，微信/支付宝 mock）：渠道下单 → 建 PENDING 流水
   * （channelOrderNo 回填）→ 返回 { payUrl, channelOrderNo }（商城扫码用）。
   * 与下单/取消/回单同权限点 order.create；越权一律 NOT_FOUND 不泄露存在性。
   */
  createPayment: orgProcedure('order.create')
    .input(createPaymentInput)
    .mutation(async ({ ctx, input }) => {
      const organizationId = actorOrgId(ctx)
      // 企业边界前置校验（照 uploadVoucher 模式：不匹配/不存在一律 NOT_FOUND）
      const order = await resolveOrderPrisma(ctx).order.findUnique({
        where: { id: input.orderId },
        select: { organizationId: true, payableCents: true },
      })
      if (!order || order.organizationId !== organizationId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `订单不存在：${input.orderId}` })
      }
      try {
        const result = await getOrderService(ctx).createPayment(input.orderId, input.method)
        await getOrderAuditService(ctx).record({
          actorId: orderActorUserId(ctx),
          actorType: 'USER',
          action: 'order.create_payment',
          organizationId,
          target: `Order:${input.orderId}`,
          diff: {
            method: input.method,
            channelOrderNo: result.channelOrderNo,
            amountCents: order.payableCents,
          },
        })
        return result
      } catch (err) {
        mapOrderServiceError(err)
      }
    }),

  /**
   * 申请退款（任务 12）：order.create（与下单同权限点——ORG_OWNER 经 '*' 通配，
   * ORG_MEMBER 不可发起）；企业边界前置校验后委托 refund service。
   * 状态由 service 校验（COMPLETED|FULFILLING → refund.request；
   * PARTIALLY_REFUNDED → refund.reopen）；amountCents 缺省=全额可退额
   * （proration）。审计 refund.request 在 service 层单一来源记录。
   */
  refundRequest: orgProcedure('order.create')
    .input(
      z.object({
        orderId: z.string().min(1),
        reason: z.string().max(500).optional(),
        amountCents: z.number().int().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = actorOrgId(ctx)
      // 企业边界前置校验（照 cancel/uploadVoucher 模式：不匹配/不存在一律 NOT_FOUND）
      const order = await resolveOrderPrisma(ctx).order.findUnique({
        where: { id: input.orderId },
        select: { organizationId: true },
      })
      if (!order || order.organizationId !== organizationId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `订单不存在：${input.orderId}` })
      }
      try {
        return await getRefundService(ctx).request(
          input.orderId,
          { reason: input.reason, amountCents: input.amountCents },
          orderActorUserId(ctx),
        )
      } catch (err) {
        mapRefundServiceError(err)
      }
    }),

  /**
   * 平台收款账户信息（任务 14，规格 §6.3"平台展示收款账户信息与订单号作为转账备注"）：
   * authed（登录即可见——纯展示信息，无企业边界动作）。env PAYMENT_BANK_INFO 为
   * JSON 字符串（{ accountName, accountNo, bankName }）；未配置/解析失败/形状不符
   * 一律返回 null（前端显示"联系顾问获取收款信息"），不区分原因不报错。
   */
  bankInfo: authedProcedure.query(() => parseBankInfo(process.env.PAYMENT_BANK_INFO)),
})

/** PAYMENT_BANK_INFO 解析（导出供测试）：合法返回三字段对象，否则 null */
export function parseBankInfo(raw: string | undefined): {
  accountName: string
  accountNo: string
  bankName: string
} | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (
      typeof record.accountName !== 'string' ||
      typeof record.accountNo !== 'string' ||
      typeof record.bankName !== 'string'
    ) {
      return null
    }
    return { accountName: record.accountName, accountNo: record.accountNo, bankName: record.bankName }
  } catch {
    return null
  }
}
