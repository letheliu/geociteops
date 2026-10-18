import type { Prisma, PrismaClient } from '@prisma/client'
import { createAuditService } from '../audit/service.js'
import type { AuditService } from '../audit/service.js'
import type { EntitlementService } from './entitlement-service.js'
import { ACTIVE_DELIVERY_STATUSES, subscriptionGraceDays } from './service-state.js'

// ---------------------------------------------------------------------------
// 订阅到期检查（任务 11，规格 §6.4）：subscription.expire-check 每日 cron 驱动
// runExpireCheck 四段——
//   ① 提醒：ACTIVE 且 endAt ∈ (now, now+15d] → 每日一条 audit
//      'subscription.expire_reminder'（P2 无 notify 域，留痕即提醒；简化裁定
//      不查当日重复——15 天窗口最多 15 条/订阅，量级可接受）；
//   ② 到期：ACTIVE 且 endAt ≤ now → GRACE（逐条乐观迁移 updateMany where
//      id+status，扫描后已续费的并发竞态自然丢行跳过，不写 audit）；
//   ③ 宽限满：GRACE 且 endAt + 宽限天数 ≤ now → EXPIRED。聚合判定（审查
//      修复 Important-1）：迁移后若 org 仍有其他有效服务——其他 ACTIVE/GRACE
//      订阅（ADDON 独立建行独立到期是任务 8 标准交付物，不续 add-on 不该
//      暂停整个付费企业）或进行中 ServiceDelivery——则只过期本行不暂停
//      workspace（audit diff.skippedReason='org_still_active'）；无其他有效
//      服务才暂停 org 全部 ACTIVE workspace → SUSPENDED（suspendReason=
//      '订阅到期'）+ audit 'subscription.expired'（diff.workspaceSuspended）。
//      两条路径末尾均重算配额（entitlements 可选注入，审查修复 Minor-3）。
//      暂停走 prisma.workspace.updateMany 直写（照 order-activate.ts 续费
//      恢复的对偶模式，不 import workspace-admin 服务避免装配耦合）；
//   ④ 孤儿恢复：因"订阅到期"暂停的 workspace，其 org 已重新有有效服务 →
//      恢复 ACTIVE/suspendReason=null + audit 'subscription.orphan_restore'
//      （真自愈：兜住 ③ 迁移后、暂停前续费提交的竞窗坏态与聚合判定修复
//      上线前的历史误伤）。
// ② 完成后 ③ 才扫描：长逾期（cron 停摆/迁移失败遗留）的 ACTIVE 行可在单
// run 内 ACTIVE→GRACE→EXPIRED 一次清理到位。
//
// 续费恢复（EXPIRED/GRACE→ACTIVE + 恢复'订阅到期'暂停）在 order-activate.ts
// 的 activateSubscription 复用分支——SUBSCRIPTION_EXPIRED_SUSPEND_REASON 在
// 本文件定义并单一来源（写入与恢复匹配共用一个字面量，防两处漂移后恢复失联）。
// ---------------------------------------------------------------------------

/** 一天毫秒数（宽限窗口换算） */
export const DAY_MS = 86_400_000

/** 到期提醒窗口（天）：endAt 距 now ≤ 15 的 ACTIVE 订阅每日留痕一条 */
export const EXPIRE_REMINDER_WINDOW_DAYS = 15

/**
 * 扫描批量上限（防单次扫全表，余量次日继续）——沿用 billing-crons.ts
 * CRON_BATCH_LIMIT 模式；本文件属 platform 层不反向 import workers 层，故独立常量。
 */
export const EXPIRE_CHECK_BATCH_LIMIT = 500

/**
 * 到期暂停原因：宽限届满时写入 workspace.suspendReason；order-activate.ts
 * 续费恢复按此精确匹配（re-export 保持既有导入路径）。
 */
export const SUBSCRIPTION_EXPIRED_SUSPEND_REASON = '订阅到期'

// 宽限天数读取单一来源：service-state.ts（任务 10）已导出 env 读取函数，
// 此处 re-export 供 cron 装配/测试消费，避免两处字面量漂移
export { subscriptionGraceDays }

// ---------------------------------------------------------------------------
// 订阅快照的策略内部键（M2 §3.0 试用租户）：
//   _graceDays        —— 该订阅的宽限天数（试用 90 天；正式套餐不写 → 回落全局）
//   _suppressReminder —— 抑制 ① 段到期提醒（7 天试用从第一天就进 15 天窗口是纯噪音）
// 快照是开通时刻固化的，写死在快照里而不是全局 env——不同租户的 TTL 策略互不影响。
// ---------------------------------------------------------------------------

/** 宽限天数内部键（Subscription.entitlements） */
export const GRACE_DAYS_ENTITLEMENT_KEY = '_graceDays'
/** 到期提醒抑制内部键（Subscription.entitlements） */
export const SUPPRESS_REMINDER_ENTITLEMENT_KEY = '_suppressReminder'

/** 只读取下划线内部键的最小订阅形状（runExpireCheck 的扫描行天然满足） */
interface EntitlementSnapshotRow {
  entitlements?: unknown
}

/** 快照里的下划线键取值（非对象/缺键 → undefined） */
function readInternalKey(row: EntitlementSnapshotRow, key: string): unknown {
  const raw = row.entitlements
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return (raw as Record<string, unknown>)[key]
}

/**
 * 该订阅实际生效的宽限天数：快照 _graceDays 优先，其次回落全局（ctx/env）。
 * 脏值（非有限数字、负数、字符串）按回落处理并 warn——宁可沿用保守的全局值，
 * 也不让一个坏键把订阅永久钉在 GRACE（等于永不过期的只读僵尸订阅）。
 */
export function resolveSubscriptionGraceDays(
  row: EntitlementSnapshotRow,
  fallbackDays: number,
): number {
  const raw = readInternalKey(row, GRACE_DAYS_ENTITLEMENT_KEY)
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw
  if (raw !== undefined) {
    console.warn(
      `[subscription.expire-check] 快照 ${GRACE_DAYS_ENTITLEMENT_KEY} 非法（${String(raw)}），回落全局宽限 ${fallbackDays} 天`,
    )
  }
  return fallbackDays
}

/** 该订阅是否抑制到期提醒（仅显式 truthy 抑制） */
export function suppressExpireReminder(row: EntitlementSnapshotRow): boolean {
  return Boolean(readInternalKey(row, SUPPRESS_REMINDER_ENTITLEMENT_KEY))
}

export interface ExpireCheckContext {
  prisma: PrismaClient
  /** 审计；缺省用 prisma 自建 */
  audit?: AuditService
  /** 时钟注入，缺省系统时间 */
  now?: () => Date
  /** 宽限天数注入（测试用）；缺省 env SUBSCRIPTION_GRACE_DAYS（再缺省 7） */
  graceDays?: number
  /** 配额重算（③ 过期后调用，与任务 12 退款路径对称）；缺省跳过 */
  entitlements?: Pick<EntitlementService, 'recompute'>
}

export interface ExpireCheckResult {
  /**
   * ① 写出的到期提醒条数。语义澄清（遗留 E6）：计"尝试提醒数"而非"成功数"——
   * audit.record 内部吞错永不抛（见 audit/service.ts），故尝试数与成功数实际相等，
   * 字段名沿用 reminded 不再拆分。
   */
  reminded: number
  /** ② ACTIVE→GRACE 迁移数 */
  enteredGrace: number
  /** ② 乐观迁移命中 0（扫描后已续费等并发竞态）跳过数 */
  graceSkipped: number
  /** ③ GRACE→EXPIRED 迁移数（含跳过暂停的聚合判定路径） */
  expired: number
  /** ③ 乐观迁移命中 0 跳过数 */
  expiredSkipped: number
  /** ③ 因 org 仍有其他有效服务而只过期不暂停的行数（聚合判定） */
  expiredOrgStillActive: number
  /** ④ 孤儿恢复的 workspace 数 */
  orphanRestored: number
}

/**
 * org 是否仍有有效服务（聚合判定查询，遗留 B7 单一来源导出）：
 * 其他 ACTIVE(endAt>now)/GRACE 订阅（excludeSubscriptionId 可排除正被处理的
 * 本行——虽然届时已 EXPIRED 不构成匹配，仍显式排除防依赖迁移时序），或进行中
 * 一次性交付（查询形状复用 service-state 的有效服务语义：交付期同样构成有效
 * 服务，ServiceDelivery 无 organizationId 列经 workspace 关系）。
 * runExpireCheck ③④ 段与 refund-service 全额退款路径共用；db 可传 prisma
 * 全客户端或事务 tx（退款审批锁内同视图读）。
 */
export async function orgStillServiced(
  db: Pick<Prisma.TransactionClient, 'subscription' | 'serviceDelivery'>,
  organizationId: string,
  nowValue: Date,
  excludeSubscriptionId?: string,
): Promise<boolean> {
  const activeSub = await db.subscription.findFirst({
    where: {
      organizationId,
      ...(excludeSubscriptionId !== undefined ? { id: { not: excludeSubscriptionId } } : {}),
      OR: [{ status: 'ACTIVE', endAt: { gt: nowValue } }, { status: 'GRACE' }],
    },
    select: { id: true },
  })
  if (activeSub) return true
  const activeDelivery = await db.serviceDelivery.findFirst({
    where: {
      status: { in: [...ACTIVE_DELIVERY_STATUSES] },
      workspace: { organizationId },
    },
    select: { id: true },
  })
  return Boolean(activeDelivery)
}

/**
 * 订阅到期检查（每日 cron 主体；workers/billing-crons.ts 的
 * subscription.expire-check handler 是本函数的薄壳）。
 * 各段独立推进，且批内逐单隔离（遗留 B5）：单条毒数据（迁移/暂停/恢复写失败）
 * 只 console 告警计数、不中断整批，循环尾汇总日志含失败数；段级扫描（findMany）
 * 错误仍上抛交由 pg-boss 下次调度重试（各段逐条乐观迁移天然可重入）。
 */
export async function runExpireCheck(ctx: ExpireCheckContext): Promise<ExpireCheckResult> {
  const { prisma } = ctx
  const audit = ctx.audit ?? createAuditService(prisma)
  const nowValue = (ctx.now ?? (() => new Date()))()
  const graceDays = ctx.graceDays ?? subscriptionGraceDays()

  // -----------------------------------------------------------------------
  // ① 提醒：ACTIVE 且 endAt ∈ (now, now + 15d]。已到期（endAt ≤ now）的走 ②，
  // 不重复提醒；GRACE/EXPIRED 状态不在提醒范围（续费提醒由销售/客户自查场景覆盖）
  // -----------------------------------------------------------------------
  const remindBefore = new Date(nowValue.getTime() + EXPIRE_REMINDER_WINDOW_DAYS * DAY_MS)
  const upcoming = await prisma.subscription.findMany({
    where: { status: 'ACTIVE', endAt: { gt: nowValue, lte: remindBefore } },
    orderBy: { endAt: 'asc' },
    take: EXPIRE_CHECK_BATCH_LIMIT,
  })
  let remindedCount = 0
  for (const sub of upcoming) {
    // 快照写了 _suppressReminder 的订阅（7 天试用）跳过提醒——提醒窗口对它没有意义
    if (suppressExpireReminder(sub)) continue
    remindedCount += 1
    await audit.record({
      actorType: 'SYSTEM',
      action: 'subscription.expire_reminder',
      organizationId: sub.organizationId,
      target: `Subscription:${sub.id}`,
      diff: {
        subscriptionId: sub.id,
        planId: sub.planId,
        endAt: sub.endAt instanceof Date ? sub.endAt.toISOString() : null,
        daysLeft: Math.ceil((sub.endAt.getTime() - nowValue.getTime()) / DAY_MS),
      },
    })
  }

  // -----------------------------------------------------------------------
  // ② 到期：ACTIVE 且 endAt ≤ now → GRACE。findMany 拿 id 列表再逐条
  // updateMany where id+ACTIVE（乐观）——批量 updateMany 会丢 audit 逐条性，
  // 乐观迁移则让"扫描后已续费"的并发竞态自然丢行跳过
  // -----------------------------------------------------------------------
  const due = await prisma.subscription.findMany({
    where: { status: 'ACTIVE', endAt: { lte: nowValue } },
    orderBy: { endAt: 'asc' },
    take: EXPIRE_CHECK_BATCH_LIMIT,
  })
  let enteredGrace = 0
  let graceSkipped = 0
  let graceFailed = 0
  for (const sub of due) {
    try {
      const moved = await prisma.subscription.updateMany({
        where: { id: sub.id, status: 'ACTIVE' },
        data: { status: 'GRACE' },
      })
      if (moved.count === 0) {
        // 扫描后已被续费/迁移的并发竞态：跳过且不写 audit
        graceSkipped += 1
        continue
      }
      enteredGrace += 1
      await audit.record({
        actorType: 'SYSTEM',
        action: 'subscription.grace',
        organizationId: sub.organizationId,
        target: `Subscription:${sub.id}`,
        diff: {
          subscriptionId: sub.id,
          planId: sub.planId,
          endAt: sub.endAt instanceof Date ? sub.endAt.toISOString() : null,
          note: '订阅到期，进入宽限期',
        },
      })
    } catch (err) {
      // 遗留 B5：单条毒数据不阻塞批内其余——告警计数后继续，循环尾汇总
      graceFailed += 1
      console.error(
        `[subscription.expire-check] 入宽限单条失败（跳过继续）：subscriptionId=${sub.id}`,
        err,
      )
    }
  }
  if (graceFailed > 0) {
    console.warn(
      `[subscription.expire-check] 入宽限批完成：扫描 ${due.length} 行，失败 ${graceFailed} 行（已跳过）`,
    )
  }

  // -----------------------------------------------------------------------
  // ③ 宽限满：GRACE 且 endAt + 宽限 ≤ now → EXPIRED（聚合判定后决定是否
  // 暂停 workspace）。已在 ② 完成后扫描，长逾期行可单 run 直达 EXPIRED；
  // 恢复由 order-activate 续费分支按 suspendReason 精确匹配（手动/其他
  // 原因暂停的不受牵连）。两条路径末尾均重算配额（订阅行状态已变）。
  // -----------------------------------------------------------------------
  const graceDeadline = new Date(nowValue.getTime() - graceDays * DAY_MS)
  const overdue = await prisma.subscription.findMany({
    // 扫描下界用全局宽限（快照可声明更宽的宽限，见下），逐行再按各自快照判定
    where: { status: 'GRACE', endAt: { lte: graceDeadline } },
    orderBy: { endAt: 'asc' },
    take: EXPIRE_CHECK_BATCH_LIMIT,
  })
  let expired = 0
  let expiredSkipped = 0
  let expiredOrgStillActive = 0
  let expireFailed = 0
  for (const sub of overdue) {
    try {
      // 逐行宽限：快照 _graceDays 优先于全局（试用 90 天 → endAt+90 才过期）；
      // 扫描下界只保证不会漏行，这里才是真正的时间判定
      const subGraceDays = resolveSubscriptionGraceDays(sub, graceDays)
      const subDeadline = sub.endAt.getTime() + subGraceDays * DAY_MS
      if (subDeadline > nowValue.getTime()) continue

      const moved = await prisma.subscription.updateMany({
        where: { id: sub.id, status: 'GRACE' },
        data: { status: 'EXPIRED' },
      })
      if (moved.count === 0) {
        // 扫描后已被续费（GRACE→ACTIVE）的并发竞态：订阅不动、不暂停、不写 audit
        expiredSkipped += 1
        continue
      }

      // 聚合判定（Important-1）：org 仍有其他有效服务 → 只过期本行，不暂停
      // workspace——"企业受影响 Workspace"的"受影响"= 聚合后无有效服务才成立
      const orgActive = await orgStillServiced(prisma, sub.organizationId, nowValue, sub.id)
      let workspaceSuspended = 0
      let skippedReason: 'org_still_active' | undefined
      if (orgActive) {
        skippedReason = 'org_still_active'
        expiredOrgStillActive += 1
      } else {
        const suspended = await prisma.workspace.updateMany({
          where: { organizationId: sub.organizationId, status: 'ACTIVE' },
          data: { status: 'SUSPENDED', suspendReason: SUBSCRIPTION_EXPIRED_SUSPEND_REASON },
        })
        workspaceSuspended = suspended.count
      }

      await audit.record({
        actorType: 'SYSTEM',
        action: 'subscription.expired',
        organizationId: sub.organizationId,
        target: `Subscription:${sub.id}`,
        diff: {
          subscriptionId: sub.id,
          planId: sub.planId,
          endAt: sub.endAt instanceof Date ? sub.endAt.toISOString() : null,
          graceDays,
          workspaceSuspended,
          ...(skippedReason !== undefined ? { skippedReason } : {}),
        },
      })
      // Minor-3：过期（无论暂停与否）后重算配额；entitlements 未注入则跳过
      await ctx.entitlements?.recompute(sub.organizationId)
      expired += 1
    } catch (err) {
      // 遗留 B5：单条毒数据不阻塞批内其余——告警计数后继续，循环尾汇总
      expireFailed += 1
      console.error(
        `[subscription.expire-check] 宽限满过期单条失败（跳过继续）：subscriptionId=${sub.id}`,
        err,
      )
    }
  }
  if (expireFailed > 0) {
    console.warn(
      `[subscription.expire-check] 宽限满过期批完成：扫描 ${overdue.length} 行，失败 ${expireFailed} 行（已跳过）`,
    )
  }

  // -----------------------------------------------------------------------
  // ④ 孤儿恢复（Minor-1 修复）：因"订阅到期"暂停的 workspace，其 org 已重新
  // 有有效服务 → 恢复（竞窗坏态自愈 + 聚合判定修复上线前的历史误伤兜底）。
  // 按 org 去重探测，恢复时再按 suspendReason 精确圈定（手动/其他原因不动）。
  // 遗留 E3：orderBy createdAt asc——take=500 截断下先处理最老行，不可恢复行
  // 不占前 500 位时待恢复行能进来（缓解饿死；余量次日继续）。
  // -----------------------------------------------------------------------
  const orphaned = await prisma.workspace.findMany({
    where: { status: 'SUSPENDED', suspendReason: SUBSCRIPTION_EXPIRED_SUSPEND_REASON },
    orderBy: { createdAt: 'asc' },
    take: EXPIRE_CHECK_BATCH_LIMIT,
  })
  let orphanRestored = 0
  let orphanFailed = 0
  const orphanOrgs = [...new Set(orphaned.map((workspace) => workspace.organizationId))]
  for (const orgId of orphanOrgs) {
    try {
      if (!(await orgStillServiced(prisma, orgId, nowValue))) continue
      const restored = await prisma.workspace.updateMany({
        where: {
          organizationId: orgId,
          status: 'SUSPENDED',
          suspendReason: SUBSCRIPTION_EXPIRED_SUSPEND_REASON,
        },
        data: { status: 'ACTIVE', suspendReason: null },
      })
      if (restored.count === 0) continue
      orphanRestored += restored.count
      await audit.record({
        actorType: 'SYSTEM',
        action: 'subscription.orphan_restore',
        organizationId: orgId,
        target: `Organization:${orgId}`,
        diff: { organizationId: orgId, workspacesRestored: restored.count },
      })
    } catch (err) {
      // 遗留 B5：单 org 恢复失败不阻塞其余 org——告警计数后继续，循环尾汇总
      orphanFailed += 1
      console.error(
        `[subscription.expire-check] 孤儿恢复单条失败（跳过继续）：organizationId=${orgId}`,
        err,
      )
    }
  }
  if (orphanFailed > 0) {
    console.warn(
      `[subscription.expire-check] 孤儿恢复批完成：探测 ${orphanOrgs.length} org，失败 ${orphanFailed}（已跳过）`,
    )
  }

  return {
    reminded: remindedCount,
    enteredGrace,
    graceSkipped,
    expired,
    expiredSkipped,
    expiredOrgStillActive,
    orphanRestored,
  }
}
