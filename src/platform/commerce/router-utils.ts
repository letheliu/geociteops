import { TRPCError } from '@trpc/server'
import type { PrismaClient } from '@prisma/client'
import type { Context } from '../../core/trpc/init.js'
import { getPrismaClient } from '../../core/db/client.js'
import { createAuditService } from '../audit/service.js'
import type { AuditService } from '../audit/service.js'
import { ProductPlanNotFoundError } from '../catalog/service.js'
import { createOrderService } from './order-service.js'
import type { OrderService } from './order-service.js'
import {
  InvalidDueDaysError,
  InvalidPriceError,
  InvalidQuantityError,
  InvalidVoucherError,
  MultipleSubscriptionItemsError,
  OrderNotFoundError,
  OrderTransitionError,
  OrganizationNotFoundError,
  PaymentNotFoundError,
  PaymentStateError,
  ProductPlanInactiveError,
  QuantityMustBeOneError,
} from './order-service.js'

// ---------------------------------------------------------------------------
// 订单域路由共享助手（遗留 B8 自 order-router.ts 拆出）：
// order-router（refundRequest）与 refund-router（getRefundService 装配）互相
// 引用对方的 helper/错误映射，构成 ESM 循环。共享件下沉到本文件后依赖图
// 无环：order-router → refund-router → router-utils；order-router → router-utils。
// order-router 对本文件 re-export，既有从 order-router.js 导入的模块
// （admin-order-router / admin-payment-router / invoice-router）不需改动。
// ---------------------------------------------------------------------------

let defaultOrderService: OrderService | undefined

/**
 * 取 prisma：优先 ctx.services.prisma（测试/组装注入），否则全局单例。
 * list/get 的查询在路由层直连 prisma（OrderService 只承载下单与状态机）。
 */
export function resolveOrderPrisma(ctx: Context): PrismaClient {
  const injected = (ctx as { services?: { prisma?: PrismaClient } }).services?.prisma
  return injected ?? getPrismaClient()
}

/** 取 order service：优先 ctx.services.orders（测试/组装注入），否则惰性构建默认实例 */
export function getOrderService(ctx: Context): OrderService {
  const injected = (ctx as { services?: { orders?: OrderService } }).services?.orders
  if (injected) return injected
  if (!defaultOrderService) {
    defaultOrderService = createOrderService({ prisma: getPrismaClient() })
  }
  return defaultOrderService
}

/** 取 audit service：优先 ctx.services.audit，否则建在解析出的 prisma 上 */
export function getOrderAuditService(ctx: Context): AuditService {
  const injected = (ctx as { services?: { audit?: AuditService } }).services?.audit
  if (injected) return injected
  return createAuditService(resolveOrderPrisma(ctx))
}

/** 操作者 id（orgProcedure/platformProcedure 均基于 authedProcedure：actor 必为 user 会话） */
export function orderActorUserId(ctx: Context): string {
  return ctx.actor.kind === 'user' ? ctx.actor.user.id : (ctx.userId ?? '')
}

/**
 * service 层命名错误 → TRPCError 映射：
 * - OrderTransitionError（非法迁移/并发冲突）/ PaymentStateError（流水状态/通道不允许）→ CONFLICT；
 * - OrderNotFoundError / ProductPlanNotFoundError / PaymentNotFoundError → NOT_FOUND；
 * - InvalidPriceError / InvalidQuantityError / QuantityMustBeOneError /
 *   MultipleSubscriptionItemsError /
 *   ProductPlanInactiveError / InvalidVoucherError / InvalidDueDaysError /
 *   OrganizationNotFoundError（遗留 B1：目标组织不存在）→ BAD_REQUEST（输入校验域）。
 * 其余错误原样上抛（INTERNAL_SERVER_ERROR 由 tRPC 兜底）。
 */
export function mapOrderServiceError(err: unknown): never {
  if (err instanceof OrderTransitionError || err instanceof PaymentStateError) {
    throw new TRPCError({ code: 'CONFLICT', message: err.message })
  }
  if (
    err instanceof OrderNotFoundError ||
    err instanceof ProductPlanNotFoundError ||
    err instanceof PaymentNotFoundError
  ) {
    throw new TRPCError({ code: 'NOT_FOUND', message: err.message })
  }
  if (
    err instanceof InvalidPriceError ||
    err instanceof InvalidQuantityError ||
    err instanceof QuantityMustBeOneError ||
    err instanceof MultipleSubscriptionItemsError ||
    err instanceof ProductPlanInactiveError ||
    err instanceof InvalidVoucherError ||
    err instanceof InvalidDueDaysError ||
    err instanceof OrganizationNotFoundError
  ) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
  }
  throw err
}
