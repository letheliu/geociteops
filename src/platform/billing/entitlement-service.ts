import type { Prisma, PrismaClient } from '@prisma/client'
import {
  mergeEntitlements,
  normalizeEntitlements,
  shanghaiMonthWindow,
  zeroEntitlements,
  type MergedEntitlements,
} from './entitlement-merge.js'

// ---------------------------------------------------------------------------
// OrganizationEntitlement 重算服务（规格 §6.4）：
// 开通/到期/退款回收时调 recompute 在行锁事务内重写企业配额汇总；
// 读路径 getLimits 不重算——无行返回全 0 默认。
// ---------------------------------------------------------------------------

export interface EntitlementServiceDeps {
  prisma: PrismaClient
  /** 时钟注入（月度窗口/有效期判定），缺省系统时间 */
  now?: () => Date
}

/** getLimits 的读视图：limits 同规投影 + 当前月度窗口（无行时 null） */
export interface OrganizationEntitlementView {
  limits: MergedEntitlements
  periodStart: Date | null
  periodEnd: Date | null
}

export interface EntitlementService {
  /**
   * 重算并落库企业配额（行锁事务内）：
   * 1. upsert OE 行（不存在则先建 limits 全 0 + 当月窗口，存在则不动）；
   * 2. `SELECT ... FOR UPDATE`（参数化 organizationId）锁行——与并发的开通/退款重算
   *    互斥，读-合并-写不交错；
   * 3. 查该 org 全部 Subscription（join plan→product 取 kind）；
   * 4. mergeEntitlements 按 §6.4 合并；
   * 5. update limits；当前窗口已过期（periodEnd < now）则滚动到当月窗口
   *    （月中重算不重置统计窗口）。
   * 返回合并后的 limits。
   */
  recompute(organizationId: string): Promise<MergedEntitlements>
  /** 读当前配额：无行 → 全 0 默认（periodStart/periodEnd null），不重算不建行 */
  getLimits(organizationId: string): Promise<OrganizationEntitlementView>
}

/** FOR UPDATE 行锁查询的返回行形状（列名即 schema 的带引号 camelCase 列） */
interface LockedEntitlementRow {
  organizationId: string
  periodStart: Date
  periodEnd: Date
}

export function createEntitlementService(deps: EntitlementServiceDeps): EntitlementService {
  const { prisma } = deps
  const now = deps.now ?? (() => new Date())

  return {
    async recompute(organizationId) {
      const nowValue = now()
      const window = shanghaiMonthWindow(nowValue)

      return prisma.$transaction(async (tx) => {
        // 1) 行不存在则先建空行（limits 全 0 + 当月窗口）；已存在则 update 空对象不动
        await tx.organizationEntitlement.upsert({
          where: { organizationId },
          create: {
            organizationId,
            limits: zeroEntitlements() as unknown as Prisma.InputJsonValue,
            periodStart: window.periodStart,
            periodEnd: window.periodEnd,
          },
          update: {},
        })

        // 2) 行锁：参数化 organizationId（$queryRaw tagged template 无拼接注入面）
        const locked = await tx.$queryRaw<LockedEntitlementRow[]>`
          SELECT "organizationId", "periodStart", "periodEnd"
          FROM "OrganizationEntitlement"
          WHERE "organizationId" = ${organizationId}
          FOR UPDATE`

        // 3) 订阅全量（planKind 不在订阅行上，join plan→product 取 kind）
        const subscriptions = await tx.subscription.findMany({
          where: { organizationId },
          include: { plan: { include: { product: true } } },
        })

        // 4) §6.4 逐字段合并
        const limits = mergeEntitlements(
          subscriptions.map((sub) => ({
            planKind: sub.plan.product.kind,
            entitlements: (sub.entitlements ?? {}) as Record<string, unknown>,
            status: sub.status,
            endAt: sub.endAt,
          })),
          nowValue,
        )

        // 5) 写 limits；窗口过期（periodEnd < now）滚动到当月（upsert 新建行窗口
        //    必然覆盖 now，不会触发滚动；锁行缺失为防御分支，同样滚动）
        const data: Prisma.OrganizationEntitlementUpdateInput = {
          limits: limits as unknown as Prisma.InputJsonValue,
        }
        const lockedRow = locked[0]
        if (!lockedRow || lockedRow.periodEnd.getTime() < nowValue.getTime()) {
          data.periodStart = window.periodStart
          data.periodEnd = window.periodEnd
        }
        await tx.organizationEntitlement.update({ where: { organizationId }, data })

        return limits
      })
    },

    async getLimits(organizationId) {
      const row = await prisma.organizationEntitlement.findUnique({
        where: { organizationId },
      })
      if (!row) {
        return { limits: zeroEntitlements(), periodStart: null, periodEnd: null }
      }
      return {
        limits: normalizeEntitlements(row.limits),
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
      }
    },
  }
}
