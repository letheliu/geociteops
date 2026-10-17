import type { PrismaClient } from '@prisma/client'

// ---------------------------------------------------------------------------
// 服务状态判定（任务 10，规格 §3.3）：requireWorkspace 在 BILLING_ENFORCEMENT
// 开启时按企业（organizationId）解析服务状态列——
// - ACTIVE：存在有效订阅（status=ACTIVE 且 endAt>now）**或** 进行中一次性服务交付
//   （PENDING_ASSIGN | IN_PROGRESS | PENDING_ACCEPTANCE，交付期同样构成有效服务）；
// - GRACE：无 ACTIVE 但存在 GRACE 订阅（expire-check 迁移后订阅本身即 GRACE，
//   存在即宽限中，不再看 endAt）；
// - NONE：皆无（正常流程不应与 workspace=ACTIVE 并存，兜底 FORBIDDEN"无有效服务"）。
//
// 全局约束：进程内 Map TTL 缓存（默认 60s——续费后最迟 1 分钟生效）；
// 条目超过 SERVICE_STATE_CACHE_MAX_ENTRIES 时清空重建（防 org 量大内存膨胀）。
// resolver 不感知 BILLING_ENFORCEMENT（开关判定收敛在 requireWorkspace），
// 也不计算 GRACE 剩余天数（subscriptionGraceDays 常量供任务 11 消费）。
// ---------------------------------------------------------------------------

/** 服务状态三态（§3.3 矩阵的列维度） */
export type ServiceState = 'ACTIVE' | 'GRACE' | 'NONE'

/** 一次性服务交付"进行中"状态集合（ACCEPTED 已交付完毕，不算有效服务） */
export const ACTIVE_DELIVERY_STATUSES = [
  'PENDING_ASSIGN',
  'IN_PROGRESS',
  'PENDING_ACCEPTANCE',
] as const

/** 进程内缓存 TTL（默认值）：续费/到期迁移后最迟 1 分钟生效 */
export const SERVICE_STATE_TTL_MS = 60_000

/** 缓存条目上限：超过即整体清空重建（简单防膨胀，不维护 LRU 序） */
export const SERVICE_STATE_CACHE_MAX_ENTRIES = 10_000

/**
 * 订阅宽限天数（env SUBSCRIPTION_GRACE_DAYS，缺省 7）。
 * 本任务仅常量导出：GRACE 剩余天数计算与 expire-check 迁移属于任务 11，
 * resolver 判定 GRACE 只看订阅 status，不消费此值。
 */
export function subscriptionGraceDays(
  env: { SUBSCRIPTION_GRACE_DAYS?: string } = process.env,
): number {
  const raw = Number.parseInt(env.SUBSCRIPTION_GRACE_DAYS ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : 7
}

export interface ServiceStateResolverDeps {
  prisma: PrismaClient
  /** 缓存 TTL（缺省 SERVICE_STATE_TTL_MS = 60s） */
  ttlMs?: number
  /** 时钟注入（TTL 判定），缺省系统时间 */
  now?: () => Date
}

export interface ServiceStateResolver {
  /** 解析企业服务状态（带进程内 TTL 缓存） */
  resolve(organizationId: string): Promise<ServiceState>
  /** 主动失效：带 orgId 失效该企业缓存；不带参数全清（测试与续费/开通链路用） */
  invalidate(organizationId?: string): void
}

interface CacheEntry {
  value: ServiceState
  /** epoch ms；resolve 时 now >= expiresAt 视为过期重查 */
  expiresAt: number
}

export function createServiceStateResolver(deps: ServiceStateResolverDeps): ServiceStateResolver {
  const { prisma } = deps
  const ttlMs = deps.ttlMs ?? SERVICE_STATE_TTL_MS
  const now = deps.now ?? (() => new Date())
  const cache = new Map<string, CacheEntry>()

  /** 无缓存查库：ACTIVE 订阅 → 进行中交付 → GRACE 订阅 → NONE（短路径依次提前返回） */
  async function queryState(organizationId: string): Promise<ServiceState> {
    const nowValue = now()

    const activeSubscription = await prisma.subscription.findFirst({
      where: { organizationId, status: 'ACTIVE', endAt: { gt: nowValue } },
      select: { id: true },
    })
    if (activeSubscription) return 'ACTIVE'

    // ServiceDelivery 无 organizationId 列：经 workspace 关系 join 到企业
    // （workspaceId 可空，NULL 工作区的交付不构成任何企业的有效服务）
    const activeDelivery = await prisma.serviceDelivery.findFirst({
      where: {
        status: { in: [...ACTIVE_DELIVERY_STATUSES] },
        workspace: { organizationId },
      },
      select: { id: true },
    })
    if (activeDelivery) return 'ACTIVE'

    // GRACE 订阅存在即宽限中（迁移后 status 已是 GRACE，不看 endAt）
    const graceSubscription = await prisma.subscription.findFirst({
      where: { organizationId, status: 'GRACE' },
      select: { id: true },
    })
    if (graceSubscription) return 'GRACE'

    return 'NONE'
  }

  return {
    async resolve(organizationId) {
      const nowMs = now().getTime()
      const hit = cache.get(organizationId)
      if (hit && hit.expiresAt > nowMs) return hit.value

      const value = await queryState(organizationId)
      // 上限保护：写满后整体清空重建（裁定：简单清空，不做逐条淘汰）
      if (cache.size >= SERVICE_STATE_CACHE_MAX_ENTRIES) cache.clear()
      cache.set(organizationId, { value, expiresAt: now().getTime() + ttlMs })
      return value
    },

    invalidate(organizationId) {
      if (organizationId === undefined) cache.clear()
      else cache.delete(organizationId)
    },
  }
}
