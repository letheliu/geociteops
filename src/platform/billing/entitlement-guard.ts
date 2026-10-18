import { TRPCError } from '@trpc/server'
import type { Prisma, PrismaClient } from '@prisma/client'
import { Prisma as PrismaNamespace } from '@prisma/client'
import type { AuditService } from '../audit/service.js'
import {
  normalizeEntitlements,
  shanghaiMonthWindow,
  zeroEntitlements,
  type MergedEntitlements,
} from './entitlement-merge.js'
import { billingEnforcementEnabled } from './enforcement.js'
import type { UsageMeter } from './usage-meter.js'

// ---------------------------------------------------------------------------
// EntitlementGuard（规格 §6.4 检查点，企业级池化按 organizationId）：
// - hardCheck/acquireWorkspaceQuotaSlot：maxWorkspaces 硬限（事务内 FOR UPDATE
//   锁 OE 行 + count 非 ARCHIVED workspace + 比较）；
// - softCheck：调用量类软限（先检查后计量、不拦截，超额 audit 'quota.soft_exceeded'）；
// - checkPlatforms：集合型硬语义（allowedPlatforms 空数组 = 全平台放行——迁移宽限）；
// - checkSamplesPerRun：samplesPerRun 上限校验。
// enforcement 判定收敛在 guard 内部（off 即全放行），业务代码不感知开关。
// ---------------------------------------------------------------------------

/** 软限检查 key（MergedEntitlements 的容量字段子集）→ 对应计量的 usage kind */
const SOFT_CHECK_USAGE_KIND: Record<SoftCheckKey, string> = {
  maxQueries: 'QUERY_ADDED',
  diagnosticRunsPerMonth: 'DIAGNOSTIC_RUN',
  maxPages: 'PAGE_CREATED',
  optimizationsPerMonth: 'OPTIMIZATION_CREATED',
}

/** 硬限容量字段（当前仅 maxWorkspaces 走事务检查点） */
export type HardCheckField = 'maxWorkspaces'

export type SoftCheckKey =
  | 'maxQueries'
  | 'diagnosticRunsPerMonth'
  | 'maxPages'
  | 'optimizationsPerMonth'

/** 优化门禁拒绝文案（M2 §3.3 规格 §4：调用方不得另立说法） */
export const OPTIMIZATIONS_DENIED_MESSAGE = '当前套餐不含内容优化，请联系开通'

/**
 * 优化门禁纯函数判定（规格 §4，单一来源）：
 * 仅当**内部标记 `_optimizationsDisabled === true` 且合并后配额 `optimizationsPerMonth === 0`**
 * 才拒绝。`merged.optimizationsPerMonth > 0` 恒放行——转化客户同时持有旧 TRIAL 与
 * 付费订阅时，内部键"首个声明者胜出"的顺序不确定性由此兜底消解。
 * 未声明 marker 的正式租户（即使 OE 全 0）也放行：回归既有计量语义。
 */
export function isOptimizationsAllowed(limits: MergedEntitlements): boolean {
  return !(limits._optimizationsDisabled === true && limits.optimizationsPerMonth === 0)
}

/** 优化门禁拒绝（抛错语义，独立于配额超限以便前端/审计区分） */
export class OptimizationsNotAllowedError extends Error {
  readonly organizationId: string
  constructor(organizationId: string) {
    super(`${OPTIMIZATIONS_DENIED_MESSAGE}（企业 ${organizationId}）`)
    this.name = 'OPTIMIZATIONS_NOT_ALLOWED'
    this.organizationId = organizationId
  }
}

/** 容量硬限超额（硬语义：抛错拒绝动作） */
export class QuotaExceededError extends Error {
  readonly field: string
  readonly limit: number
  readonly current: number
  readonly organizationId: string
  constructor(opts: {
    field: string
    limit: number
    current: number
    organizationId: string
  }) {
    super(
      `配额超限：企业 ${opts.organizationId} 的 ${opts.field} 上限 ${opts.limit}，` +
        `当前 ${opts.current}（QUOTA_EXCEEDED）`,
    )
    this.name = 'QUOTA_EXCEEDED'
    this.field = opts.field
    this.limit = opts.limit
    this.current = opts.current
    this.organizationId = opts.organizationId
  }
}

/** 平台不在 allowedPlatforms 集合内（集合型硬语义） */
export class PlatformNotAllowedError extends Error {
  readonly platforms: string[]
  readonly allowed: string[]
  readonly organizationId: string
  constructor(opts: { platforms: string[]; allowed: string[]; organizationId: string }) {
    super(
      `平台未开通：企业 ${opts.organizationId} 允许的平台为 [${opts.allowed.join(', ')}]，` +
        `违规平台：${opts.platforms.join(', ')}（PLATFORM_NOT_ALLOWED）`,
    )
    this.name = 'PLATFORM_NOT_ALLOWED'
    this.platforms = opts.platforms
    this.allowed = opts.allowed
    this.organizationId = opts.organizationId
  }
}

/** 槽主动回滚的内部哨兵（rollback 路径以此强制事务回滚，对外吞掉） */
class QuotaSlotAbortedError extends Error {
  constructor() {
    super('quota slot aborted')
  }
}

/** 配额槽事务句柄：业务方在锁持有窗口内完成创建后 commit（失败 rollback） */
export interface QuotaSlot {
  commit(): Promise<void>
  rollback(): Promise<void>
}

/** enforcement 关闭时的空槽：commit/rollback 均 no-op（Ruling 1：全放行零查询） */
const NOOP_QUOTA_SLOT: QuotaSlot = {
  async commit() {},
  async rollback() {},
}

/** 槽持有窗口上限：业务创建链路（workspace create + 初始 Key 签发）的兜底时长 */
const QUOTA_SLOT_TIMEOUT_MS = 15_000

export interface EntitlementGuard {
  /**
   * maxWorkspaces 硬限检查（事务内三步：upsert 锁锚行 → FOR UPDATE → count 比较）。
   * 通过不抛错；超额抛 QuotaExceededError。创建动作需与检查同窗串行时用
   * acquireWorkspaceQuotaSlot（检查持锁窗口覆盖创建提交）。
   */
  hardCheck(organizationId: string, field: HardCheckField): Promise<void>
  /**
   * workspace 配额槽（裁定采用的事务句柄形态）：事务内完成 upsert 锁锚 + FOR UPDATE
   * 锁 OE 行 + count 非 ARCHIVED workspace + 比较，检查通过后**保持事务打开**返回；
   * 业务方在锁持有窗口内创建 workspace（创建提交先于 commit），随后：
   * - commit()：释放锁并提交检查事务——并发 hardCheck/acquire 在锁上排队，
   *   commit 后的 count 能看到本窗口内新建的行（硬限不超卖）；
   * - rollback()：回滚检查事务（创建前失败路径）。
   * enforcement off → 空槽（零查询零事务）。
   */
  acquireWorkspaceQuotaSlot(organizationId: string): Promise<QuotaSlot>
  /**
   * 调用量类软限（不拦截）：getLimits + 当月 UsageRecord Σquantity →
   * { allowed, current, limit }；allowed=false 时 audit 'quota.soft_exceeded'
   * （actorType=SYSTEM）。enforcement off → 直接 allowed 不做用量查询（裁定）。
   */
  softCheck(
    organizationId: string,
    key: SoftCheckKey,
    requested?: number,
  ): Promise<{ allowed: boolean; current: number; limit: number }>
  /**
   * 平台集合硬语义校验：limits.allowedPlatforms 为空数组 → 全平台放行（迁移宽限，
   * Ruling 10 补丁）；非空则 platforms 每个都须在集合内，否则抛
   * PlatformNotAllowedError（含违规平台名）。enforcement off → 放行。
   */
  checkPlatforms(organizationId: string, platforms: string[]): Promise<void>
  /** samplesPerRun 上限校验：samples > limits.samplesPerRun 抛 QuotaExceededError */
  checkSamplesPerRun(organizationId: string, samples: number): Promise<void>
  /**
   * monitorSampleCountMax 上限校验（M2 §3.0）：N 是单次运行参数而非月度累计，
   * 因此走硬检查（抛错拒绝动作）而非 softCheck（只审计不拦）。
   * 键缺失 = 不限（正式租户未声明该键时全量放行）。enforcement off → 放行。
   */
  checkMonitorSampleCountMax(organizationId: string, requested: number): Promise<void>
  /**
   * 优化门禁 org 级判定（M2 §3.3 规格 §4）：与 assertOptimizationsAllowed 共用同一实现
   * （纯函数 isOptimizationsAllowed + enforcement 判定），供 weakPoints/loopBoard 响应携带
   * `optimizationsAllowed` 布尔——前端禁用态与后端硬拒绝同源，杜绝前后端判定漂移。
   * enforcement off → 放行（此时门禁 no-op，依赖 §3.0 双开关部署约束）。
   */
  isOptimizationsAllowed(organizationId: string): Promise<boolean>
  /**
   * 优化门禁硬检查（M2 §3.3 规格 §4）：拒绝时抛 OptimizationsNotAllowedError 并记一条
   * `optimizations.denied` 审计（便于排查绕过尝试）。enforcement off → 放行。
   */
  assertOptimizationsAllowed(organizationId: string): Promise<void>
}

export interface EntitlementGuardDeps {
  prisma: PrismaClient
  meter: UsageMeter
  audit: AuditService
  /** enforcement 开关（缺省 billingEnforcementEnabled，测试注入） */
  enforcement?: () => boolean
  /** 时钟注入（月度窗口/锁锚行窗口），缺省系统时间 */
  now?: () => Date
}

/** FOR UPDATE 行锁查询的返回行形状（含 limits 供检查读取，免二次查询） */
interface LockedEntitlementRow {
  organizationId: string
  limits: Prisma.JsonValue
}

export function createEntitlementGuard(deps: EntitlementGuardDeps): EntitlementGuard {
  const { prisma, meter, audit } = deps
  const enforcement = deps.enforcement ?? billingEnforcementEnabled
  const now = deps.now ?? (() => new Date())

  /** 读路径 limits：无 OE 行 → 全 0（同 entitlement-service.getLimits 兜底） */
  async function readLimits(organizationId: string): Promise<MergedEntitlements> {
    const row = await prisma.organizationEntitlement.findUnique({ where: { organizationId } })
    if (!row) return zeroEntitlements()
    return normalizeEntitlements(row.limits)
  }

  /** 事务内 maxWorkspaces 三步检查：upsert 锁锚行 → FOR UPDATE → count 比较 */
  async function assertWorkspaceQuotaInTx(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<void> {
    const window = shanghaiMonthWindow(now())
    // 无 OE 行的企业先建全 0 锚行（upsert ON CONFLICT 对已存在行同样持锁），
    // 保证 FOR UPDATE 有行可锁——并发首建在此排队
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
    const locked = await tx.$queryRaw<LockedEntitlementRow[]>`
      SELECT "organizationId", "limits"
      FROM "OrganizationEntitlement"
      WHERE "organizationId" = ${organizationId}
      FOR UPDATE`
    const limits = normalizeEntitlements(locked[0]?.limits)
    const current = await tx.workspace.count({
      where: { organizationId, status: { not: 'ARCHIVED' } },
    })
    if (current >= limits.maxWorkspaces) {
      throw new QuotaExceededError({
        field: 'maxWorkspaces',
        limit: limits.maxWorkspaces,
        current,
        organizationId,
      })
    }
  }

  return {
    async hardCheck(organizationId, field) {
      if (!enforcement()) return
      if (field !== 'maxWorkspaces') {
        throw new Error(`hardCheck 不支持字段：${field}`)
      }
      await prisma.$transaction(async (tx) => {
        await assertWorkspaceQuotaInTx(tx, organizationId)
      })
    },

    async acquireWorkspaceQuotaSlot(organizationId) {
      if (!enforcement()) return NOOP_QUOTA_SLOT

      // 延迟释放闸门：检查通过后事务保持打开（持 OE 行锁），等业务 commit/rollback
      let decision: 'commit' | 'rollback' = 'rollback'
      let released = false
      let releaseGate!: () => void
      const gate = new Promise<void>((resolve) => {
        releaseGate = () => {
          if (!released) {
            released = true
            resolve()
          }
        }
      })

      // 检查阶段完成/失败信号（失败时解除 acquire 的等待并上抛）
      let signalCheckDone!: () => void
      const checkDone = new Promise<void>((resolve) => {
        signalCheckDone = () => resolve()
      })
      let earlyFailure: unknown = null

      const txPromise = prisma.$transaction(
        async (tx) => {
          await assertWorkspaceQuotaInTx(tx, organizationId)
          signalCheckDone()
          await gate
          if (decision !== 'commit') throw new QuotaSlotAbortedError()
        },
        // 审查 M-2：串行化论证（FOR UPDATE 行锁 + commit 后 count 可见新建行）依赖
        // READ COMMITTED——显式钉住，不留给部署层/驱动默认值
        {
          timeout: QUOTA_SLOT_TIMEOUT_MS,
          isolationLevel: PrismaNamespace.TransactionIsolationLevel.ReadCommitted,
        },
      )
      // 任何 rejection（检查抛错/超时）都解除等待；rejection 由 commit/rollback 的
      // await 或下方 earlyFailure 上抛消费，不产生 unhandled rejection
      txPromise.catch((err: unknown) => {
        earlyFailure = err
        signalCheckDone()
      })

      await checkDone
      if (earlyFailure !== null) throw earlyFailure

      return {
        async commit() {
          decision = 'commit'
          releaseGate()
          // 事务提交（检查通过后无写入，实为释放锁）；异常（如超时已回滚）上抛
          await txPromise
        },
        async rollback() {
          decision = 'rollback'
          releaseGate()
          try {
            await txPromise
          } catch (err) {
            // 主动回滚的预期哨兵吞掉；其余（超时等）异常如实上抛
            if (!(err instanceof QuotaSlotAbortedError)) throw err
          }
        },
      }
    },

    async softCheck(organizationId, key, requested = 1) {
      if (!enforcement()) return { allowed: true, current: 0, limit: 0 }
      const limits = await readLimits(organizationId)
      const limit = limits[key]
      const current = await meter.getMonthlyUsage(organizationId, SOFT_CHECK_USAGE_KIND[key], now())
      const allowed = current + requested <= limit
      if (!allowed) {
        await audit.record({
          actorType: 'SYSTEM',
          action: 'quota.soft_exceeded',
          organizationId,
          diff: { kind: key, current, limit, organizationId },
        })
      }
      return { allowed, current, limit }
    },

    async checkPlatforms(organizationId, platforms) {
      if (!enforcement()) return
      const limits = await readLimits(organizationId)
      if (limits.allowedPlatforms.length === 0) return
      const allowed = new Set(limits.allowedPlatforms)
      const violating = [...new Set(platforms)].filter((p) => !allowed.has(p))
      if (violating.length > 0) {
        throw new PlatformNotAllowedError({
          platforms: violating,
          allowed: limits.allowedPlatforms,
          organizationId,
        })
      }
    },

    async checkSamplesPerRun(organizationId, samples) {
      if (!enforcement()) return
      const limits = await readLimits(organizationId)
      if (samples > limits.samplesPerRun) {
        throw new QuotaExceededError({
          field: 'samplesPerRun',
          limit: limits.samplesPerRun,
          current: samples,
          organizationId,
        })
      }
    },

    async checkMonitorSampleCountMax(organizationId, requested) {
      if (!enforcement()) return
      const limits = await readLimits(organizationId)
      const limit = limits.monitorSampleCountMax
      if (limit === undefined) return
      if (requested > limit) {
        throw new QuotaExceededError({
          field: 'monitorSampleCountMax',
          limit,
          current: requested,
          organizationId,
        })
      }
    },

    // M2 §3.3 优化门禁：判定（isOptimizationsAllowed）与硬检查（assertOptimizationsAllowed）
    // 共用同一纯函数实现，二者不会漂移。
    async isOptimizationsAllowed(organizationId) {
      if (!enforcement()) return true
      return isOptimizationsAllowed(await readLimits(organizationId))
    },

    async assertOptimizationsAllowed(organizationId) {
      if (!enforcement()) return
      if (isOptimizationsAllowed(await readLimits(organizationId))) return
      await audit.record({
        actorType: 'SYSTEM',
        action: 'optimizations.denied',
        organizationId,
        diff: { organizationId },
      })
      throw new OptimizationsNotAllowedError(organizationId)
    },
  }
}

// ---------------------------------------------------------------------------
// 业务检查点装配辅助：guard+meter 打包注入业务服务 deps（工厂参数注入，
// 不依赖 ctx.services 全局），workspace → organization 解析供检查点取企业边界。
// ---------------------------------------------------------------------------

export interface BillingCheckpoints {
  guard: EntitlementGuard
  meter: UsageMeter
}

/**
 * 解析 workspace 所属 organizationId（检查点按企业池化配额）。
 * workspace 不存在 → null（调用方跳过检查点，存在性由业务主链路校验）。
 */
export async function resolveWorkspaceOrganization(
  prisma: Pick<PrismaClient, 'workspace'>,
  workspaceId: string,
): Promise<string | null> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { organizationId: true },
  })
  return workspace?.organizationId ?? null
}

/** 门禁入口所需的最小 ctx 形状（tRPC Context 的结构化子集，便于测试注入） */
export interface OptimizationsGateContext {
  workspace?: { organizationId?: string | null } | null
  services?: { billing?: BillingCheckpoints } | null
}

/**
 * 优化门禁的入口前置断言（规格 §4 六入口统一调用点）：
 * - ctx.services.billing 缺失（无计费装配/测试上下文）→ no-op 放行，与
 *   enforcement off 同一语义——门禁只在计费机器在场时才有意义；
 * - ctx.workspace.organizationId 缺失 → no-op 放行（workspace 归属由 middleware 保证）。
 * 必须在任何 LLM 调用与写库之前调用。
 */
export async function assertWorkspaceOptimizationsAllowed(ctx: OptimizationsGateContext): Promise<void> {
  const guard = ctx.services?.billing?.guard
  const organizationId = ctx.workspace?.organizationId
  if (!guard || !organizationId) return
  try {
    await guard.assertOptimizationsAllowed(organizationId)
  } catch (err) {
    if (err instanceof OptimizationsNotAllowedError) {
      // 入口层统一映射为 FORBIDDEN + 规格钉死的文案（不泄漏企业 id 等内部信息）
      throw new TRPCError({ code: 'FORBIDDEN', message: OPTIMIZATIONS_DENIED_MESSAGE })
    }
    throw err
  }
}

/** 优化门禁的 org 级布尔（weakPoints/loopBoard 响应携带，与 assert 同源） */
export async function workspaceOptimizationsAllowed(ctx: OptimizationsGateContext): Promise<boolean> {
  const guard = ctx.services?.billing?.guard
  const organizationId = ctx.workspace?.organizationId
  if (!guard || !organizationId) return true
  return guard.isOptimizationsAllowed(organizationId)
}
