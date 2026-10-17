import { initTRPC, TRPCError } from '@trpc/server'
import type {
  ApiCredential,
  Organization,
  OrgRole,
  PlatformRole,
  Session,
  User,
  Workspace,
  WorkspaceAccess,
} from '@prisma/client'
import type { AuthDiag } from './context.js'
import { getPrismaClient } from '../db/client.js'
import { billingEnforcementEnabled } from '../../platform/billing/enforcement.js'
import {
  createServiceStateResolver,
  type ServiceStateResolver,
} from '../../platform/billing/service-state.js'

/** 平台权限点（P0 workspace/credential 管理路由 + P2 商业域路由复用） */
export type PlatformPermission =
  | 'workspace.manage'
  | 'workspace.enter'
  | 'credential.write'
  | 'assignment.manage'
  | 'user.manage'
  | 'audit.view'
  // P2 商业域（任务 2 扩展，§2.2）
  | 'catalog.manage'
  | 'order.view'
  | 'order.manage'
  | 'payment.confirm'
  | 'refund.manage'
  | 'invoice.manage'

/**
 * 平台角色 → 权限点常量表（P0 授权规则 + P2 §2.2 扩展）：
 * - SUPER_ADMIN 通配一切权限点；
 * - OPERATOR 具备工作区运维、审计查看与订单运维权，无员工账号/目录/资金类权限；
 * - FINANCE 资金域：订单只读 + 支付确认/退款/发票；
 * - SUPPORT 仅订单只读。
 *
 * assignment.manage（P1 终审收紧）：顾问分配/摘除仅 SUPER_ADMIN（经 '*' 通配）——
 * OPERATOR 不列此权限点，防止其自我分配进任意工作区取得业务数据读写。
 *
 * P2 §2.2 逐字：OPERATOR 追加 order.view/order.manage；FINANCE =
 * order.view/payment.confirm/refund.manage/invoice.manage；SUPPORT = order.view。
 */
export const PLATFORM_ROLE_PERMISSIONS: Record<PlatformRole, PlatformPermission[] | ['*']> = {
  SUPER_ADMIN: ['*'],
  OPERATOR: [
    'workspace.manage',
    'workspace.enter',
    'credential.write',
    'audit.view',
    'order.view',
    'order.manage',
  ],
  FINANCE: ['order.view', 'payment.confirm', 'refund.manage', 'invoice.manage'],
  SUPPORT: ['order.view'],
}

/** 企业侧权限点（org 命名空间路由使用；P2 任务 4 起订单域端点复用） */
export type OrgPermission =
  | 'org.manage'
  | 'workspace.manage'
  | 'credential.write'
  // P2 商业域（任务 4，Ruling 14）
  | 'order.create'
  | 'order.view'

/**
 * 企业角色 → 权限点常量表（P1 授权规则 + P2 任务 4 扩展）：
 * - ORG_OWNER 通配一切权限点（企业管理员）；
 * - ORG_MEMBER 可查看本企业订单（order.view，Ruling 14）——下单（order.create）
 *   仍为 OWNER 专属；业务数据访问走 WorkspaceMember 合成授权。
 * - ORG_VIEWER P2 依旧无订单可见性（空表，恒拒）。
 */
export const ORG_ROLE_PERMISSIONS: Record<OrgRole, OrgPermission[] | ['*']> = {
  ORG_OWNER: ['*'],
  ORG_MEMBER: ['order.view'],
  ORG_VIEWER: [],
}

/** 请求级元信息：由 createContext 从原始请求提取（headers 为小写化快照） */
export interface RequestMeta {
  ip: string
  userAgent?: string
  requestId: string
  /** 原始 HTTP 方法（GET/POST…）；csrf 回退判定用（GET 视为 query） */
  method?: string
  headers: Record<string, string | undefined>
}

/** 请求主体：双通道解析结果（会话 Cookie / x-api-key / 匿名） */
export type Actor =
  | { kind: 'user'; user: User; session: Session }
  | { kind: 'apiKey'; credential: ApiCredential }
  | { kind: 'anonymous' }

export interface Context {
  actor: Actor
  organization?: Organization
  workspace?: Workspace
  /**
   * 授权分治解析出的请求级访问级（§2.2 权限合成快照）：VIEW → 业务写被拒
   * （ORG_VIEWER 恒只读；成员被降级为 VIEW 后在途会话下一请求即生效）。
   * apiKey 通道无此概念（工作区凭证即全权），undefined 不设限。
   */
  workspaceAccess?: WorkspaceAccess
  services?: any
  res?: any
  requestMeta: RequestMeta
  /** 会话通道命中的明文 token（logout/改密覆写 Cookie 用） */
  sessionToken?: string
  /** authedProcedure 注入：当前用户 id（handler 内不再自行解析 actor） */
  userId?: string
  /** 鉴权失败诊断（protectedProcedure 可定位文案用） */
  authDiag?: AuthDiag
}

const t = initTRPC.context<Context>().create()

export const router = t.router

/** csrf 守卫：写操作要求 x-geo-csrf 请求头（query 放行） */
const csrfGuard = t.middleware(async ({ ctx, type, next }) => {
  // tRPC v10 middleware 原生提供 opts.type（'query' | 'mutation' | 'subscription'），
  // 已用运行时探针验证（见任务 9 报告）；回退方案为 ctx.requestMeta.method（GET 视为 query）。
  if (type === 'mutation' && !ctx.requestMeta?.headers?.['x-geo-csrf']) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: '缺少 x-geo-csrf 请求头：写操作被 CSRF 守卫拒绝（浏览器端请随 mutation 携带该头）',
    })
  }
  return next()
})

/** 公开过程：不做身份判定，仅挂 csrf 守卫（写操作仍需 csrf 头，如 auth.login） */
export const publicProcedure = t.procedure.use(csrfGuard)

/** requireUser：要求已登录会话；mustChangePassword 用户仅放行 auth.* */
const requireUser = t.middleware(async ({ ctx, path, next }) => {
  if (!ctx.actor || ctx.actor.kind !== 'user') {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: '未登录或会话已失效' })
  }
  if (ctx.actor.user.mustChangePassword && !path.startsWith('auth.')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: '首次登录（或密码被重置）须先完成修改密码（auth.changePassword）才能访问其他接口',
    })
  }
  return next({ ctx: { ...ctx, userId: ctx.actor.user.id } })
})

/** 已登录过程：actor 必须为用户会话；ctx.userId 由中间件注入 */
export const authedProcedure = publicProcedure.use(requireUser)

/**
 * 平台管理过程：基于 authedProcedure，要求平台员工具备指定权限点（任一缺失即拒）。
 * 无 platformRole（如客户用户）直接 FORBIDDEN。
 */
export function platformProcedure(...perms: PlatformPermission[]) {
  return authedProcedure.use(async ({ ctx, next }) => {
    const actor = ctx.actor
    if (!actor || actor.kind !== 'user') {
      // 防御性兜底：authedProcedure 已保证 user 会话
      throw new TRPCError({ code: 'UNAUTHORIZED', message: '未登录或会话已失效' })
    }
    const role = actor.user.platformRole
    if (!role) {
      throw new TRPCError({ code: 'FORBIDDEN', message: '当前账号无平台角色，禁止访问平台管理接口' })
    }
    const granted: readonly string[] = PLATFORM_ROLE_PERMISSIONS[role]
    const allowed = granted.includes('*') || perms.every((p) => granted.includes(p))
    if (!allowed) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `平台角色 ${role} 不具备所需权限点（${perms.join(', ')}）`,
      })
    }
    return next()
  })
}

/**
 * 企业控制台过程：基于 authedProcedure，要求客户用户（userType==='CUSTOMER'）
 * 且具备企业角色，并按 ORG_ROLE_PERMISSIONS 判定权限点（任一缺失即拒）。
 * 语义与 platformProcedure 完全同构：'*' 通配 + perms.every 全含才放行。
 * 非客户账号（PLATFORM）或无 orgRole → FORBIDDEN。
 */
export function orgProcedure(...perms: OrgPermission[]) {
  return authedProcedure.use(async ({ ctx, next }) => {
    const actor = ctx.actor
    if (!actor || actor.kind !== 'user') {
      // 防御性兜底：authedProcedure 已保证 user 会话
      throw new TRPCError({ code: 'UNAUTHORIZED', message: '未登录或会话已失效' })
    }
    const user = actor.user
    if (user.userType !== 'CUSTOMER' || !user.orgRole) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: '当前账号不是企业成员（需客户账号且具备企业角色），禁止访问企业控制台接口',
      })
    }
    const granted: readonly string[] = ORG_ROLE_PERMISSIONS[user.orgRole]
    const allowed = granted.includes('*') || perms.every((p) => granted.includes(p))
    if (!allowed) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `企业角色 ${user.orgRole} 不具备所需权限点（${perms.join(', ')}）`,
      })
    }
    return next()
  })
}

/** 服务状态 resolver：ctx.services.serviceState 优先（server.ts/测试注入），无则模块级惰性默认（照 workspace-router 的服务获取模式） */
let defaultServiceStateResolver: ServiceStateResolver | undefined

function getServiceStateResolver(ctx: Context): ServiceStateResolver | undefined {
  const injected = ctx.services?.serviceState as ServiceStateResolver | undefined
  if (injected) return injected
  defaultServiceStateResolver ??= createServiceStateResolver({ prisma: getPrismaClient() })
  return defaultServiceStateResolver
}

/**
 * 受保护过程：要求 workspace 已解析，并按 P0 读写矩阵判定。
 * （名字不变——现有业务路由 import 零改动。）
 *
 * 会话通道前置约束：mustChangePassword 的 user 一律 FORBIDDEN（文案同 requireUser，
 * 须先走 auth.changePassword）；apiKey 通道不受影响。
 *
 * P0 矩阵（BILLING_ENFORCEMENT 默认 off：计费侧服务状态恒 ACTIVE，
 * 判定唯一依据为 workspace.status）：
 *
 * | workspace.status | query | mutation               |
 * |------------------|-------|------------------------|
 * | ACTIVE           | ✓     | ✓                      |
 * | SUSPENDED        | ✓     | FORBIDDEN（只读开放）  |
 * | ARCHIVED         | ✓     | FORBIDDEN（只读开放）  |
 * | （未解析到）     | UNAUTHORIZED                |
 *
 * P1 追加（授权分治，§2.2 权限合成）：ctx.workspaceAccess === 'VIEW' 时
 * mutation 同样 FORBIDDEN（ORG_VIEWER 只读 / 成员降级 VIEW 实时生效）；
 * apiKey 通道无 workspaceAccess（凭证即全权），行为与 P0 一致。
 *
 * P2 任务 10 追加（§3.3 服务状态列，BILLING_ENFORCEMENT=on 时生效）：
 * 按 workspace.organizationId 解析企业服务状态（进程内 60s TTL 缓存）：
 *
 * | 服务状态 | query | mutation                              |
 * |----------|-------|---------------------------------------|
 * | ACTIVE   | ✓     | （回落下方 P0/P1 矩阵）               |
 * | GRACE    | ✓     | FORBIDDEN（宽限期只读，请续费）       |
 * | NONE     | FORBIDDEN（无有效服务，仅 ws=ACTIVE）| FORBIDDEN（同左）|
 *
 * 判定先于 workspace.status 逻辑（服务状态对 query 也生效）。NONE 全拒仅限
 * workspace=ACTIVE（§3.3"ACTIVE+NONE"行）；SUSPENDED/ARCHIVED × 任意服务状态
 * → 历史数据只读开放（§5.2"可登录查看历史数据"，query ✓ / mutation 由下方
 * workspace.status 既有检查拒）。apiKey 通道同矩阵（§3.4：SDK 宽限读可写拒）。
 * enforcement off 时整列跳过——P0/P1 行为零变化。
 */
const requireWorkspace = t.middleware(async ({ ctx, type, next }) => {
  // user 会话通道：持临时密码（mustChangePassword）的用户必须先完成修改密码才能进业务路由
  // （requireUser 只护住 authedProcedure 家族；此处补齐 protectedProcedure 的洞——
  // 业务路由无 auth.* 前缀，无例外。apiKey 通道无 user 概念，不受影响。）
  if (ctx.actor?.kind === 'user' && ctx.actor.user.mustChangePassword) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: '首次登录（或密码被重置）须先完成修改密码（auth.changePassword）才能访问其他接口',
    })
  }

  const workspace = ctx.workspace
  if (!workspace) {
    // 根据 authDiag 给出可定位的错误信息，便于区分前端问题与数据/环境问题
    const message =
      ctx.authDiag === 'missing_header'
        ? '未携带认证凭证（缺少会话 Cookie 与 x-api-key 请求头），无法解析工作区'
        : ctx.authDiag === 'key_not_found'
          ? 'API Key 在当前数据库中不存在（可能被 prisma db push 重置、环境已切换，或 Key 已吊销/拼写错误）'
          : '无法解析工作区：SDK 请求需携带 x-api-key，控制台请求需在平台账号下携带 x-workspace-id'
    throw new TRPCError({ code: 'UNAUTHORIZED', message })
  }

  // P2 任务 10（§3.3 服务状态列）：BILLING_ENFORCEMENT 开启时按企业解析服务状态。
  // 置于 workspace.status 判定之前——服务状态对 query 也生效，且 mutation 的
  // 拒绝文案以服务状态优先（宽限期比工作区挂起更可定位）。
  // 终审裁定：NONE 全拒仅限 workspace=ACTIVE（§3.3"ACTIVE+NONE"行）；
  // SUSPENDED/ARCHIVED × NONE → 历史数据只读开放（§5.2"任意服务状态 query ✓"
  // 比 ACTIVE 行更具体），mutation 仍由下方 workspace.status 既有检查拒。
  // enforcement off 或 resolver 缺失（防御分支，惰性默认总在）→ 完全跳过零行为变化。
  if (billingEnforcementEnabled()) {
    const serviceStateResolver = getServiceStateResolver(ctx)
    if (serviceStateResolver) {
      const serviceState = await serviceStateResolver.resolve(workspace.organizationId)
      if (serviceState === 'NONE' && workspace.status === 'ACTIVE') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message:
            '无有效服务：该企业不存在有效订阅（ACTIVE 且未到期）或进行中的服务交付，' +
            '也不处于订阅宽限期，读写均被拒绝；请续费或联系商务开通服务',
        })
      }
      if (type === 'mutation' && serviceState === 'GRACE') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: '宽限期只读，请续费：订阅已到期处于宽限期，查询可用，写操作被拒绝',
        })
      }
    }
  }

  if (type === 'mutation' && workspace.status !== 'ACTIVE') {
    const label = workspace.status === 'SUSPENDED' ? '已暂停（SUSPENDED）' : '已归档（ARCHIVED）'
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `工作区${label}，只读开放：查询可用，写操作被拒绝`,
    })
  }

  // P1 授权分治：请求级访问级为 VIEW 只读（ORG_VIEWER / 被降级成员）——
  // 授权实时查库解析（不缓存进会话），降权后在途会话的下一个写请求即被拒
  if (type === 'mutation' && ctx.workspaceAccess === 'VIEW') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: '当前账号对该工作区为只读权限（VIEW）：查询可用，写操作被拒绝',
    })
  }
  // 类型收窄：向下游注入非可选 workspace（现有业务路由零改动的前提）
  return next({ ctx: { ...ctx, workspace } })
})

export const protectedProcedure = publicProcedure.use(requireWorkspace)
