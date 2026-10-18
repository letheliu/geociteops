import { TRPCError } from '@trpc/server'
import type { PrismaClient } from '@prisma/client'
import { router, orgProcedure } from '../../core/trpc/init.js'
import type { Context } from '../../core/trpc/init.js'
import { getPrismaClient } from '../../core/db/client.js'
import { createEntitlementService } from './entitlement-service.js'
import type { EntitlementService } from './entitlement-service.js'
import { CAPACITY_FIELDS, OPTIONAL_CAPACITY_FIELDS, shanghaiMonthWindow } from './entitlement-merge.js'
import type { CapacityKey } from './entitlement-merge.js'

/** 遍历型配额字段全集（必填 + 可选），与 QUOTA_USAGE_KIND 的键域一致 */
const ALL_CAPACITY_FIELDS: readonly CapacityKey[] = [...CAPACITY_FIELDS, ...OPTIONAL_CAPACITY_FIELDS]

// ---------------------------------------------------------------------------
// 客户侧"我的服务"轻查询路由（任务 14，挂载于 appRouter.billing）：
// - subscriptions：本 org 的 Subscription 列表薄投影（id/planId/plan 名称/状态/
//   起止时间），Billing 页订阅卡片数据源；
// - entitlements：getLimits + 当月用量汇总 { limits, usage, periodStart, periodEnd }，
//   Billing 页配额进度条数据源。usage 直接 prisma 聚合 UsageRecord 当月 Σquantity by kind
//   （裁定：不依赖 meter 内存缓冲——读路径所见即落库事实，与软限检查口径一致）；
//   periodStart/periodEnd 为 usage 实际聚合的新鲜窗口（遗留 D4，非 OE 存量行窗口）。
// 服务层薄（订阅列表/用量聚合在路由层直连 prisma，照 order-router 的 list/get
// 模式；limits 复用 EntitlementService.getLimits 不重算）。
// ---------------------------------------------------------------------------

let defaultEntitlementService: EntitlementService | undefined

/** 取 prisma：优先 ctx.services.prisma（测试/组装注入），否则全局单例 */
export function resolveBillingPrisma(ctx: Context): PrismaClient {
  const injected = (ctx as { services?: { prisma?: PrismaClient } }).services?.prisma
  return injected ?? getPrismaClient()
}

/** 取 entitlement service：优先 ctx.services.entitlements（测试/组装注入），否则惰性默认 */
export function getBillingEntitlementService(ctx: Context): EntitlementService {
  const injected = (ctx as { services?: { entitlements?: EntitlementService } }).services
    ?.entitlements
  if (injected) return injected
  defaultEntitlementService ??= createEntitlementService({ prisma: getPrismaClient() })
  return defaultEntitlementService
}

/** 当前客户的企业 id：orgProcedure 已保证 CUSTOMER + orgRole；空 organizationId 兜底拦截 */
function actorOrgId(ctx: Context): string {
  if (ctx.actor.kind === 'user') {
    const orgId = ctx.actor.user.organizationId
    if (orgId) return orgId
  }
  throw new TRPCError({ code: 'FORBIDDEN', message: '当前账号未挂靠企业，禁止访问企业控制台接口' })
}

/**
 * 容量配额键 → 当月用量聚合来源：
 * - 计量类四键（与 entitlement-guard 的 SOFT_CHECK_USAGE_KIND 同映射）：UsageRecord
 *   当月 Σquantity；
 * - maxWorkspaces：用量 = 非 ARCHIVED workspace 计数（与硬限检查口径一致，不走
 *   UsageRecord）；
 * - samplesPerRun / monitorSampleCountMax：单次运行上限，无月度计量概念（恒 0，
 *   前端展示为"—/上限"，不画进度条）。
 */
const QUOTA_USAGE_KIND: Record<CapacityKey, string | null> = {
  maxQueries: 'QUERY_ADDED',
  maxPages: 'PAGE_CREATED',
  diagnosticRunsPerMonth: 'DIAGNOSTIC_RUN',
  optimizationsPerMonth: 'OPTIMIZATION_CREATED',
  maxWorkspaces: null,
  samplesPerRun: null,
  monitorSampleCountMax: null,
}

/** 初始全 0 用量表（未计量键保持 0） */
function zeroUsage(): Record<CapacityKey, number> {
  return {
    maxWorkspaces: 0,
    maxQueries: 0,
    maxPages: 0,
    diagnosticRunsPerMonth: 0,
    samplesPerRun: 0,
    optimizationsPerMonth: 0,
    monitorSampleCountMax: 0,
  }
}

/**
 * billing 路由（orgProcedure()：任意企业成员可看本企业订阅与配额——
 * 只读展示无动作，越权风险由企业边界 where 拦截）。
 */
export const billingRouter = router({
  subscriptions: orgProcedure().query(async ({ ctx }) => {
    const organizationId = actorOrgId(ctx)
    const rows = await resolveBillingPrisma(ctx).subscription.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      include: { plan: { select: { id: true, name: true } } },
    })
    return {
      items: rows.map((row) => ({
        id: row.id,
        planId: row.planId,
        planName: row.plan.name,
        status: row.status,
        startAt: row.startAt,
        endAt: row.endAt,
      })),
    }
  }),

  entitlements: orgProcedure().query(async ({ ctx }) => {
    const organizationId = actorOrgId(ctx)
    const prisma = resolveBillingPrisma(ctx)
    const view = await getBillingEntitlementService(ctx).getLimits(organizationId)

    // 当月用量（Asia/Shanghai 自然月，与配额统计窗口同源）：四个计量键并行聚合
    const window = shanghaiMonthWindow(new Date())
    const usage = zeroUsage()
    const meteredFields = ALL_CAPACITY_FIELDS.filter((field) => QUOTA_USAGE_KIND[field] !== null)
    await Promise.all(
      meteredFields.map(async (field) => {
        const aggregated = await prisma.usageRecord.aggregate({
          _sum: { quantity: true },
          where: {
            organizationId,
            kind: QUOTA_USAGE_KIND[field]!,
            occurredAt: { gte: window.periodStart, lt: window.periodEnd },
          },
        })
        usage[field] = aggregated._sum.quantity ?? 0
      }),
    )
    // maxWorkspaces 用量 = 非 ARCHIVED workspace 计数（硬限检查同口径）
    usage.maxWorkspaces = await prisma.workspace.count({
      where: { organizationId, status: { not: 'ARCHIVED' } },
    })

    return {
      limits: view.limits,
      // 遗留 D4：统计窗口标签返回 usage 实际聚合的新鲜窗口，而非 OE 存量行的
      // periodStart/periodEnd（跨月未 recompute 时存量窗口滞后，标签与用量错月）。
      // OE 行窗口仅作重算滚动的内部依据，不作为展示口径；前端据此渲染标签，
      // 字段缺省（null）时隐藏标签（Billing 页兜底）
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      usage,
    }
  }),
})
