import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { BillingPeriod, ProductKind } from '@prisma/client'
import { router, authedProcedure, platformProcedure } from '../../core/trpc/init.js'
import type { Context } from '../../core/trpc/init.js'
import { getPrismaClient } from '../../core/db/client.js'
import { createAuditService } from '../audit/service.js'
import { createCatalogService } from './service.js'
import type { CatalogService } from './service.js'
import {
  ProductCodeConflictError,
  ProductNotFoundError,
  ProductPlanNotFoundError,
} from './service.js'

let defaultService: CatalogService | undefined

/**
 * 取 catalog service：优先 ctx.services.catalog（测试/组装注入），
 * 否则惰性构建默认实例（真实 prisma + audit）。
 */
function getCatalogService(ctx: Context): CatalogService {
  const injected = (ctx as { services?: { catalog?: CatalogService } }).services?.catalog
  if (injected) return injected
  if (!defaultService) {
    const prisma = getPrismaClient()
    defaultService = createCatalogService({ prisma, audit: createAuditService(prisma) })
  }
  return defaultService
}

/**
 * service 层命名错误 → TRPCError 映射（code 冲突 CONFLICT / 商品·套餐不存在 NOT_FOUND）。
 * 其余错误原样上抛（INTERNAL_SERVER_ERROR 由 tRPC 兜底）。
 */
function mapServiceError(err: unknown): never {
  if (err instanceof ProductCodeConflictError) {
    throw new TRPCError({ code: 'CONFLICT', message: err.message })
  }
  if (err instanceof ProductNotFoundError || err instanceof ProductPlanNotFoundError) {
    throw new TRPCError({ code: 'NOT_FOUND', message: err.message })
  }
  throw err
}

/** platformProcedure 基于 authedProcedure：actor 必为 user 会话 */
function actorUserId(ctx: Context): string {
  return ctx.actor.kind === 'user' ? ctx.actor.user.id : (ctx.userId ?? '')
}

const productIdSchema = z.string().min(1)
const planIdSchema = z.string().min(1)

const productCreateInput = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(100),
  kind: z.nativeEnum(ProductKind),
  description: z.string().max(2000).optional(),
})

const productUpdateInput = z.object({
  productId: productIdSchema,
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
})

const planCreateInput = z.object({
  productId: productIdSchema,
  name: z.string().min(1).max(100),
  /** 价格：整数分（199.5 / -1 由 zod 物理拒绝） */
  priceCents: z.number().int().min(0),
  /** 计费周期：MONTH/YEAR，缺省 = 一次性 */
  billingPeriod: z.nativeEnum(BillingPeriod).optional(),
  /** 配额声明（商城展示与配额扣减依据） */
  entitlements: z.record(z.any()),
  /** 交付模板（专业服务里程碑），缺省 [] */
  deliverables: z.array(z.any()).optional(),
})

const planUpdateInput = z.object({
  planId: planIdSchema,
  name: z.string().min(1).max(100).optional(),
  priceCents: z.number().int().min(0).optional(),
  /** null = 清除（转一次性） */
  billingPeriod: z.nativeEnum(BillingPeriod).nullable().optional(),
  entitlements: z.record(z.any()).optional(),
  deliverables: z.array(z.any()).optional(),
})

/**
 * 商城目录路由（挂载于 appRouter.catalog，Ruling 7：authedProcedure——
 * 登录即可见在售商品目录，客户/平台账号无差异；无参或 { kind } 过滤）。
 */
export const catalogRouter = router({
  list: authedProcedure
    .input(z.object({ kind: z.nativeEnum(ProductKind).optional() }).optional())
    .query(async ({ ctx, input }) => getCatalogService(ctx).listActive(input ?? {})),
})

/**
 * 目录管理路由（挂载于 appRouter.admin.catalog，platformProcedure('catalog.manage')——
 * §2.2：仅 SUPER_ADMIN（经 '*' 通配）；OPERATOR/FINANCE/SUPPORT 均不具此权限点）。
 *
 * 端点命名（裁定）：product.list（全量，任务 15 审查修复）/ product.create /
 * product.update / product.setActive、plan.create / plan.update / plan.setActive
 * （input 带 productId 或 planId）。
 * code/kind 不可变（service 层 update 不接受这两个字段）。
 * 审计动作：catalog.product.create / catalog.product.update / catalog.product.set_active、
 * catalog.plan.* 同风格（actorType='USER'，与 workspace-admin 侧惯例一致）。
 */
export const adminCatalogRouter = router({
  product: router({
    /**
     * 后台全量列表（任务 15 审查修复）：含 inactive 产品与 plans 的 AdminView 投影
     * （下架条目可见可再上架）；q 可选 code/name contains 简单过滤。
     */
    list: platformProcedure('catalog.manage')
      .input(z.object({ q: z.string().min(1).optional() }).optional())
      .query(async ({ ctx, input }) => getCatalogService(ctx).listAll(input ?? {})),

    create: platformProcedure('catalog.manage')
      .input(productCreateInput)
      .mutation(async ({ ctx, input }) => {
        try {
          return await getCatalogService(ctx).createProduct(input, actorUserId(ctx))
        } catch (err) {
          mapServiceError(err)
        }
      }),

    update: platformProcedure('catalog.manage')
      .input(productUpdateInput)
      .mutation(async ({ ctx, input }) => {
        const { productId, ...fields } = input
        try {
          return await getCatalogService(ctx).updateProduct(productId, fields, actorUserId(ctx))
        } catch (err) {
          mapServiceError(err)
        }
      }),

    setActive: platformProcedure('catalog.manage')
      .input(z.object({ productId: productIdSchema, active: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await getCatalogService(ctx).setProductActive(
            input.productId,
            input.active,
            actorUserId(ctx),
          )
        } catch (err) {
          mapServiceError(err)
        }
      }),
  }),

  plan: router({
    create: platformProcedure('catalog.manage')
      .input(planCreateInput)
      .mutation(async ({ ctx, input }) => {
        const { productId, ...fields } = input
        try {
          return await getCatalogService(ctx).createPlan(productId, fields, actorUserId(ctx))
        } catch (err) {
          mapServiceError(err)
        }
      }),

    update: platformProcedure('catalog.manage')
      .input(planUpdateInput)
      .mutation(async ({ ctx, input }) => {
        const { planId, ...fields } = input
        try {
          return await getCatalogService(ctx).updatePlan(planId, fields, actorUserId(ctx))
        } catch (err) {
          mapServiceError(err)
        }
      }),

    setActive: platformProcedure('catalog.manage')
      .input(z.object({ planId: planIdSchema, active: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await getCatalogService(ctx).setPlanActive(
            input.planId,
            input.active,
            actorUserId(ctx),
          )
        } catch (err) {
          mapServiceError(err)
        }
      }),
  }),
})
