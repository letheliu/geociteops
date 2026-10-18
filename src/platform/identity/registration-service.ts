import { TRPCError } from '@trpc/server'
import type { PrismaClient, Session } from '@prisma/client'
import { hashPassword, validatePasswordPolicy } from '../../core/auth/password.js'
import type { SessionService } from '../../core/auth/session.js'
import { encryptConfig } from '../../core/crypto/envelope.js'
import { billingEnforcementEnabled } from '../billing/enforcement.js'
import {
  ORDER_NO_RANDOM_LENGTH,
  formatOrderNo,
  randomBase36,
  type OrderPlanSnapshot,
} from '../commerce/order-service.js'
import type { AuditService } from '../audit/service.js'
import { createSlidingWindowLimiter } from '../../core/lib/sliding-window-limiter.js'
import type { SlidingWindowLimiter } from '../../core/lib/sliding-window-limiter.js'

// ---------------------------------------------------------------------------
// 自助注册服务（M2 §3.0 规格 §3/§4/§5）：
// - 防滥用：公开入口双限速；
// - 五件套开通（User/Organization/Workspace/Order+OrderItem/Subscription 单事务）；
// - 提交后 recompute（entitlement 机器），不嵌套事务、不走 order.activate worker。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// §4 限速与防滥用
//
// 公开入口必须双限速：
// - 每 IP 3 次 / 小时（3.6e6ms 滑窗）：挡住单 IP 脚本刷试用租户；
// - 全局 50 次 / 24h 滑窗：挡住换 IP 的分布式批量注册。
// 两个限速器都是进程内实现（与登录限流同款取舍）：多实例部署时限速会被稀释，
// 届时升级为共享存储。
// ---------------------------------------------------------------------------

/** 每 IP 窗口内允许的注册次数 */
export const REGISTRATION_IP_LIMIT = 3
/** 每 IP 滑窗长度（1 小时） */
export const REGISTRATION_IP_WINDOW_MS = 3_600_000
/** 全局窗口内允许的注册次数 */
export const REGISTRATION_GLOBAL_LIMIT = 50
/** 全局滑窗长度（24 小时） */
export const REGISTRATION_GLOBAL_WINDOW_MS = 86_400_000
/** 全局限速器的共享键（所有 IP 落在同一键上） */
const GLOBAL_KEY = '__registration_global__'

/** 限速拒绝的命中面：ip = 单 IP 超限，global = 全局总量超限 */
export type RateLimitScope = 'ip' | 'global'

export interface RegistrationRateLimiter {
  /** 放行返回 null；被拒返回命中面（供上层映射 TOO_MANY_REQUESTS 与文案） */
  check(ip: string): RateLimitScope | null
}

export interface RegistrationRateLimiterOptions {
  /** 时钟注入（毫秒），测试用假时钟推进两个窗口 */
  now?: () => number
  ipLimiter?: SlidingWindowLimiter
  globalLimiter?: SlidingWindowLimiter
}

export function createRegistrationRateLimiter(
  options: RegistrationRateLimiterOptions = {},
): RegistrationRateLimiter {
  const now = options.now ?? (() => Date.now())
  const ipLimiter =
    options.ipLimiter ??
    createSlidingWindowLimiter({
      limit: REGISTRATION_IP_LIMIT,
      windowMs: REGISTRATION_IP_WINDOW_MS,
      now,
      label: 'register-ip',
    })
  const globalLimiter =
    options.globalLimiter ??
    createSlidingWindowLimiter({
      limit: REGISTRATION_GLOBAL_LIMIT,
      windowMs: REGISTRATION_GLOBAL_WINDOW_MS,
      now,
      label: 'register-global',
    })

  return {
    check(ip: string): RateLimitScope | null {
      // 先 IP 面后全局面：命中层决定用户看到的文案，也避免被限的请求白白消耗
      // 全局配额（全局计数只应在两道都放行时前进）
      if (!ipLimiter.check(ip)) return 'ip'
      if (!globalLimiter.check(GLOBAL_KEY)) return 'global'
      return null
    },
  }
}

// ---------------------------------------------------------------------------
// §3 注册流程（双开关闸 + 五件套单事务 + 提交后 recompute）
// ---------------------------------------------------------------------------

/** TRIAL 商品目录 code（注册按此查计划，查不到即 fail-closed） */
export const TRIAL_PLAN_CODE = 'TRIAL'
/** 试用时长（天）：endAt = 注册时刻 + 7 天 */
export const TRIAL_DURATION_DAYS = 7
/** 试用宽限天数（写进订阅快照的内部键 _graceDays） */
export const TRIAL_GRACE_DAYS = 90
/** 试用工作区初始采样数 N 上限（min(N, 计划声明 monitorSampleCountMax)） */
export const TRIAL_MONITOR_SAMPLE_COUNT = 3
/** 试用租户来源标记（Organization.source） */
export const TRIAL_ORG_SOURCE = 'TRIAL'
/** 平台建户来源标记（Organization.source 缺省值） */
export const PLATFORM_ORG_SOURCE = 'PLATFORM'
const DAY_MS = 86_400_000

/** ===== 统一对外文案（调用方不得另立说法） ===== */
export const REGISTRATION_CLOSED_MESSAGE = '当前未开放自助注册，请联系平台开通'
export const REGISTRATION_PLAN_UNAVAILABLE_MESSAGE = '试用套餐暂不可用，请稍后再试'
export const REGISTRATION_RATE_LIMITED_MESSAGE = '注册尝试过于频繁，请稍后再试'
export const REGISTRATION_USERNAME_TAKEN_MESSAGE = '用户名已存在'
export const REGISTRATION_EMAIL_TAKEN_MESSAGE = '邮箱已被注册'

/**
 * 自助注册是否开启（双开关联动，fail-closed）：
 * - REGISTRATION_ENABLED 非 on/true → 关闭；
 * - BILLING_ENFORCEMENT 非 on/true → 同样关闭。
 * 联动的理由：试用的配额与 TTL 全部挂在 entitlement 机器上，而 enforcement 关闭时
 * guard 全放行——此时开注册等于放出无配额、无到期的无限租户。评审 P0-1 的硬钉子。
 */
export function registrationEnabled(env: { REGISTRATION_ENABLED?: string; BILLING_ENFORCEMENT?: string } = process.env): boolean {
  const registration = env.REGISTRATION_ENABLED
  const on = registration === 'on' || registration === 'true'
  return on && billingEnforcementEnabled(env)
}

export interface RegisterTrialInput {
  username: string
  /** 可选，仅联系方式（不做验证码验证，见规格 §2 非目标） */
  email?: string
  password: string
  /** 缺省取 username */
  brandName?: string
  /** 缺省 "{brandName} 的企业" */
  organizationName?: string
  /** 限速与审计用（requestMeta.ip） */
  ip?: string
}

export interface RegisterTrialResult {
  token: string
  session: Session
  user: {
    id: string
    username: string
    displayName: string
    userType: string
    organizationId: string
    orgRole: string
    mustChangePassword: boolean
  }
  trial: {
    organizationId: string
    workspaceId: string
    subscriptionId: string
    planId: string
    planName: string
    /** 试用到期时刻（= startAt + 7 天） */
    endAt: Date
  }
}

export interface RegistrationServiceDeps {
  prisma: PrismaClient
  sessions: SessionService
  audit: AuditService
  /** entitlement 机器的 recompute（自开事务，只能在五件套事务提交后调） */
  entitlements: { recompute(organizationId: string): Promise<unknown> }
  /** 信封主密钥（平台配置生而加密；装配处 loadMasterKey() 传入） */
  envelopeKey: string
  /** 双开关判定，缺省读 process.env（测试注入） */
  env?: { REGISTRATION_ENABLED?: string; BILLING_ENFORCEMENT?: string }
  /** 时钟注入（startAt/endAt/订单号日期段），缺省系统时间 */
  now?: () => Date
  /** 订单号随机段注入（测试固定），缺省 crypto 随机 base36 */
  randomSuffix?: () => string
  /** 注册限速器（缺省按 §4 阈值装配） */
  rateLimiter?: RegistrationRateLimiter
}

export interface RegistrationService {
  registerTrial(input: RegisterTrialInput): Promise<RegisterTrialResult>
  /** 自助注册是否开启（双开关联动判定，供 auth.registrationEnabled 用） */
  isEnabled(): boolean
}

/** TRIAL 计划不可用（缺失 / 非 SUBSCRIPTION 商品 / 无启用套餐 / 未声明工作区配额） */
export class TrialPlanUnavailableError extends Error {
  constructor(reason: string) {
    super(`${REGISTRATION_PLAN_UNAVAILABLE_MESSAGE}（${reason}）`)
    this.name = 'TRIAL_PLAN_UNAVAILABLE'
  }
}

export function createRegistrationService(deps: RegistrationServiceDeps): RegistrationService {
  const { prisma, sessions, audit, entitlements, envelopeKey } = deps
  const now = deps.now ?? (() => new Date())
  const randomSuffix = deps.randomSuffix ?? (() => randomBase36(ORDER_NO_RANDOM_LENGTH))
  const env = deps.env ?? process.env
  const rateLimiter = deps.rateLimiter ?? createRegistrationRateLimiter()

  async function registerTrial(input: RegisterTrialInput): Promise<RegisterTrialResult> {
    // ---- 前置闸（fail-closed，双开关联动）----
    if (!registrationEnabled(env)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: REGISTRATION_CLOSED_MESSAGE })
    }

    // ---- 限速（每 IP 3 次/小时 + 全局 50 次/24h）----
    const scope = rateLimiter.check(input.ip ?? 'unknown')
    if (scope !== null) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: REGISTRATION_RATE_LIMITED_MESSAGE })
    }

    // ---- 密码策略（复用 identity 口径：含用户名相似性检查）----
    const policy = validatePasswordPolicy(input.password, input.username)
    if (!policy.ok) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: policy.reason ?? '密码不符合策略' })
    }
    const passwordHash = await hashPassword(input.password)

    // 派生规则：displayName = brandName ?? username；organizationName 缺省 "{brand} 的企业"
    const brand = (input.brandName ?? input.username).trim()
    const organizationName = input.organizationName?.trim() || `${brand} 的企业`
    const registeredAt = now()

    // ---- 五件套单事务（User/Organization/Workspace/Order+OrderItem/Subscription）----
    const created = await prisma.$transaction(async (tx) => {
      // 计划查找 fail-closed：缺失 / 非 SUBSCRIPTION / 无启用套餐 / 未声明 maxWorkspaces ≥ 1
      // 一律报错且零残留——绝不建出"无配额租户"。
      const product = await tx.product.findUnique({
        where: { code: TRIAL_PLAN_CODE },
        include: { plans: { where: { active: true }, orderBy: { createdAt: 'asc' } } },
      })
      if (!product) throw new TrialPlanUnavailableError('目录缺少 TRIAL 商品')
      if (product.kind !== 'SUBSCRIPTION') {
        throw new TrialPlanUnavailableError(`TRIAL 商品类型为 ${product.kind}，应为 SUBSCRIPTION`)
      }
      const plan = product.plans[0]
      if (!plan) throw new TrialPlanUnavailableError('TRIAL 套餐缺失或已下架')

      const planEntitlements = (plan.entitlements ?? {}) as Record<string, unknown>
      const declaredMaxWorkspaces = planEntitlements.maxWorkspaces
      if (typeof declaredMaxWorkspaces !== 'number' || declaredMaxWorkspaces < 1) {
        // 新 org 的 maxWorkspaces 不走 acquireWorkspaceQuotaSlot（它自开事务+行锁，
        // 看不见本事务未提交的行），因此在事务内直接断言计划声明 ≥ 1。
        throw new TrialPlanUnavailableError('TRIAL 套餐未声明可用的 maxWorkspaces')
      }
      const declaredSampleMax = planEntitlements.monitorSampleCountMax
      const sampleCount = Math.min(
        TRIAL_MONITOR_SAMPLE_COUNT,
        typeof declaredSampleMax === 'number' ? declaredSampleMax : TRIAL_MONITOR_SAMPLE_COUNT,
      )

      // 唯一性：事务内先查（可读文案），P2002 仍由外层兜底（并发同名校验）
      const existingUsername = await tx.user.findUnique({ where: { username: input.username } })
      if (existingUsername) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: REGISTRATION_USERNAME_TAKEN_MESSAGE })
      }
      if (input.email) {
        const existingEmail = await tx.user.findUnique({ where: { email: input.email } })
        if (existingEmail) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: REGISTRATION_EMAIL_TAKEN_MESSAGE })
        }
      }

      const organization = await tx.organization.create({
        data: { name: organizationName, source: TRIAL_ORG_SOURCE },
      })
      const user = await tx.user.create({
        data: {
          username: input.username,
          displayName: brand,
          email: input.email ?? null,
          passwordHash,
          userType: 'CUSTOMER',
          orgRole: 'ORG_OWNER',
          mustChangePassword: false,
          organizationId: organization.id,
        },
      })
      const workspace = await tx.workspace.create({
        data: {
          name: brand,
          defaultBrandName: brand,
          organizationId: organization.id,
          status: 'ACTIVE',
          monitorSchedule: 'DAILY',
          monitorSampleCount: sampleCount,
          // 明文 '{}' 从不落库：与 workspace-admin 创建路径同款，生而加密为信封
          platformConfig: encryptConfig('{}', envelopeKey),
        },
      })

      // 零元试用单：paidAt=null 是"不进财务口径"的锚（对账/发票/收款视图谓词都是 paidAt<>NULL），
      // COMPLETED 表示开通已完成（不走 order.activate worker——其入口闸是 PAID→FULFILLING）
      const order = await tx.order.create({
        data: {
          orderNo: formatOrderNo(registeredAt, randomSuffix()),
          organizationId: organization.id,
          status: 'COMPLETED',
          totalCents: 0,
          discountCents: 0,
          payableCents: 0,
          refundedCents: 0,
          paymentMethod: 'TRIAL',
          paidAt: null,
          remark: '自助注册试用开通',
        },
      })
      const planSnapshot: OrderPlanSnapshot = {
        name: plan.name,
        kind: product.kind,
        priceCents: plan.priceCents,
        billingPeriod: plan.billingPeriod,
        entitlements: plan.entitlements as never,
        deliverables: plan.deliverables as never,
      }
      await tx.orderItem.create({
        data: {
          orderId: order.id,
          planId: plan.id,
          quantity: 1,
          unitPriceCents: plan.priceCents,
          planSnapshot: planSnapshot as never,
        },
      })

      // 订阅：endAt 直写 +7 天（不经 addBillingPeriod——BillingPeriod 只有 MONTH/YEAR）
      const endAt = new Date(registeredAt.getTime() + TRIAL_DURATION_DAYS * DAY_MS)
      const subscription = await tx.subscription.create({
        data: {
          organizationId: organization.id,
          planId: plan.id,
          sourceOrderId: order.id,
          startAt: registeredAt,
          endAt,
          status: 'ACTIVE',
          // 快照 = 目录 entitlements + 内部策略键（_graceDays 宽限 90 天 / 7 天试用不写到期提醒）
          entitlements: {
            ...planEntitlements,
            _graceDays: TRIAL_GRACE_DAYS,
            _suppressReminder: true,
          } as never,
        },
      })

      return { organization, user, workspace, order, subscription, plan, sampleCount }
    })

    // ---- 提交后重算配额（entitlementService.recompute 自开事务，不可嵌套）----
    await entitlements.recompute(created.organization.id)

    // ---- 会话：注册成功直接签发登录态（复用 login 的会话 + Set-Cookie 路径）----
    const { token, session } = await sessions.create(created.user.id, { ip: input.ip })

    // ---- 审计五事件（spec §7）----
    const actorId = created.user.id
    await audit.record({
      actorId,
      actorType: 'USER',
      action: 'auth.register',
      organizationId: created.organization.id,
      ip: input.ip,
    })
    await audit.record({
      actorId,
      actorType: 'USER',
      action: 'organization.create',
      organizationId: created.organization.id,
      target: `Organization:${created.organization.id}`,
      diff: { name: organizationName, source: TRIAL_ORG_SOURCE },
    })
    await audit.record({
      actorId,
      actorType: 'USER',
      action: 'workspace.create',
      organizationId: created.organization.id,
      workspaceId: created.workspace.id,
      target: `Workspace:${created.workspace.id}`,
      diff: { name: brand, monitorSampleCount: created.sampleCount },
    })
    await audit.record({
      actorId,
      actorType: 'USER',
      action: 'order.create',
      organizationId: created.organization.id,
      target: `Order:${created.order.id}`,
      diff: { orderNo: created.order.orderNo, paymentMethod: 'TRIAL', totalCents: 0 },
    })
    await audit.record({
      actorId,
      actorType: 'USER',
      action: 'subscription.create',
      organizationId: created.organization.id,
      target: `Subscription:${created.subscription.id}`,
      diff: { planId: created.plan.id, endAt: created.subscription.endAt.toISOString() },
    })

    return {
      token,
      session,
      user: {
        id: created.user.id,
        username: created.user.username,
        displayName: created.user.displayName,
        userType: created.user.userType,
        organizationId: created.organization.id,
        orgRole: created.user.orgRole ?? 'ORG_OWNER',
        mustChangePassword: created.user.mustChangePassword,
      },
      trial: {
        organizationId: created.organization.id,
        workspaceId: created.workspace.id,
        subscriptionId: created.subscription.id,
        planId: created.plan.id,
        planName: created.plan.name,
        endAt: created.subscription.endAt,
      },
    }
  }

  return {
    registerTrial,
    isEnabled: () => registrationEnabled(env),
  }
}
