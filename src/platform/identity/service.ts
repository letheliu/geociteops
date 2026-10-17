import { TRPCError } from '@trpc/server'
import type {
  OrgRole,
  PlatformRole,
  Prisma,
  PrismaClient,
  Session,
  User,
  UserStatus,
  WorkspaceAccess,
} from '@prisma/client'
import {
  generateTempPassword,
  hashPassword,
  validatePasswordPolicy,
  verifyPassword,
} from '../../core/auth/password.js'
import type { SessionService } from '../../core/auth/session.js'
import type { AuditService } from '../audit/service.js'
import type { MemberService, ResolvedUserAccess } from '../tenancy/member-service.js'
import type { LoginRateLimiter } from './rate-limiter.js'

/** ===== 统一对外文案（调用方不得另立说法） ===== */
export const AUTH_FAILED_MESSAGE = '用户名或密码错误'
export const LOCKED_MESSAGE = '账号已锁定'
export const RATE_LIMITED_MESSAGE = '登录尝试过于频繁，请稍后再试'
export const USER_NOT_FOUND_MESSAGE = '用户不存在'
export const USERNAME_TAKEN_MESSAGE = '用户名已存在'
export const OLD_PASSWORD_WRONG_MESSAGE = '旧密码错误'
export const ACCOUNT_DISABLED_MESSAGE = '账号已禁用'

/** 连续失败达到该阈值即锁定 */
const LOCK_THRESHOLD = 5
/** 锁定时长：15 分钟 */
const LOCK_DURATION_MS = 15 * 60 * 1000
/** SUPER_ADMIN me() 返回的最近 workspace 数（无"最近使用"追踪，按 createdAt 取前 20）；
 * 其余角色的数据源天然有界（OPERATOR=分配记录、CUSTOMER=本企业/成员记录），不截断 */
const ME_WORKSPACE_TAKE = 20
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

export interface LoginInput {
  username: string
  password: string
  ip?: string
}

export interface LoginResult {
  token: string
  session: Session
  user: User
}

export interface ChangePasswordInput {
  oldPassword: string
  newPassword: string
}

export interface ChangePasswordResult {
  token: string
  session: Session
}

/** me() 的 workspace 条目：access 为该用户对此 workspace 的最终权限（已合成） */
export interface MeWorkspaceRef {
  id: string
  name: string
  access: WorkspaceAccess
}

export interface MeResult {
  id: string
  username: string
  displayName: string
  userType: User['userType']
  platformRole: User['platformRole']
  mustChangePassword: boolean
  workspaces: { items: MeWorkspaceRef[]; total: number }
  /** 客户用户所属企业（user.organization include 取）；平台用户为 null */
  organization: { id: string; name: string } | null
  /** 客户用户的企业角色；无角色（平台用户/脏数据）省略 */
  orgRole?: OrgRole
}

export interface CreateUserInput {
  username: string
  displayName: string
  platformRole: PlatformRole
  /** 缺省时用 generateTempPassword 生成临时密码（mustChangePassword=true） */
  password?: string
  /** 操作者（审计 actorId）；service 层不校权，权限由 router 层管 */
  actorId?: string
}

export interface CreateUserResult {
  user: User
  /** 生效的明文密码（临时生成或调用方提供），仅供一次性展示 */
  password: string
}

/** 企业成员创建入参（org.members.create 后端；router 层 zod 物理排除 ORG_OWNER） */
export interface CreateOrgUserInput {
  organizationId: string
  /** 缺省按 §9.1 步骤 5 规则生成：邮箱前缀 / member_+orgId 前 8 位 / 冲突加序号 */
  username?: string
  email?: string
  displayName: string
  /** 不接受 ORG_OWNER（service 层同样防御抛错） */
  orgRole: Exclude<OrgRole, 'ORG_OWNER'>
  /** 缺省时用 generateTempPassword 生成临时密码（mustChangePassword=true） */
  password?: string
  /** 操作者（审计 actorId）；service 层不校权，权限由 router 层管 */
  actorId?: string
}

export interface CreateOrgUserResult {
  user: User
  /** 生效的明文密码（临时生成或调用方提供），仅供一次性展示 */
  password: string
}

export interface ListUsersQuery {
  page?: number
  pageSize?: number
  /** 平台按企业查客户账号的救援通道（P1 遗留 2b）：传入则改列该企业 CUSTOMER 用户 */
  organizationId?: string
}

export type PlatformUserListItem = Pick<
  User,
  | 'id'
  | 'username'
  | 'displayName'
  | 'platformRole'
  | 'status'
  | 'mustChangePassword'
  | 'lastLoginAt'
  | 'createdAt'
  | 'updatedAt'
>

export interface ListUsersResult {
  items: PlatformUserListItem[]
  total: number
}

export interface IdentityServiceDeps {
  prisma: PrismaClient
  sessions: SessionService
  audit: AuditService
  loginRateLimiter: LoginRateLimiter
  /** me() 的客户 MEMBER/VIEWER workspace 合成与 OPERATOR 分配数据源 */
  members: MemberService
}

export interface IdentityService {
  login(input: LoginInput): Promise<LoginResult>
  logout(userId: string, token: string): Promise<{ ok: true }>
  changePassword(userId: string, input: ChangePasswordInput): Promise<ChangePasswordResult>
  me(userId: string): Promise<MeResult>
  createUser(input: CreateUserInput): Promise<CreateUserResult>
  createOrgUser(input: CreateOrgUserInput): Promise<CreateOrgUserResult>
  /** 返回一次性明文临时密码（仅此一次，库内只存哈希） */
  resetPassword(userId: string, actorId?: string): Promise<string>
  setStatus(userId: string, status: UserStatus, actorId?: string): Promise<User>
  listUsers(query: ListUsersQuery): Promise<ListUsersResult>
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002'
}

/** 用户名长度界（与 identity 路由 zod 一致） */
const USERNAME_MIN_LENGTH = 3
const USERNAME_MAX_LENGTH = 64
/** 自动生成用户名的冲突重试上限（base、base2…base100），防御候选被恶意/脏数据占满 */
const USERNAME_GENERATION_MAX_TRIES = 100

/** 邮箱前缀清洗：取 @ 前部分，小写化并仅保留用户名安全字符（§9.1 步骤 5 邮箱前缀规则） */
function sanitizeEmailPrefix(email: string): string {
  const prefix = email.split('@')[0] ?? ''
  return prefix.toLowerCase().replace(/[^a-z0-9._-]/g, '')
}

/** 无可用邮箱前缀时的兜底基名：member_ + organizationId 前 8 位（控制者裁定，§9.1 步骤 5 的成员场景推广） */
function memberBaseName(organizationId: string): string {
  return `member_${organizationId.slice(0, 8)}`
}

/**
 * 企业成员用户名自动生成（§9.1 步骤 5）：
 * 优先联系人邮箱前缀；无邮箱（或前缀清洗后过短）时 member_+orgId 前 8 位；
 * 与存量冲突则追加序号（base2、base3…），候选耗尽抛 CONFLICT。
 */
async function generateOrgUsername(
  prisma: PrismaClient,
  input: { organizationId: string; email?: string },
): Promise<string> {
  const fallback = memberBaseName(input.organizationId)
  let base = input.email ? sanitizeEmailPrefix(input.email) : ''
  if (base.length < USERNAME_MIN_LENGTH) base = fallback
  base = base.slice(0, USERNAME_MAX_LENGTH)

  for (let seq = 1; seq <= USERNAME_GENERATION_MAX_TRIES; seq++) {
    const candidate = seq === 1 ? base : `${base}${seq}`.slice(0, USERNAME_MAX_LENGTH)
    const taken = await prisma.user.findUnique({
      where: { username: candidate },
      select: { id: true },
    })
    if (!taken) return candidate
  }
  throw new TRPCError({
    code: 'CONFLICT',
    message: '自动生成用户名失败：候选均被占用，请显式指定 username',
  })
}

/**
 * 平台身份服务：账号密码登录、改密、登出、员工账号管理。
 *
 * 错误统一抛 TRPCError；对外文案（AUTH_FAILED_MESSAGE 等）集中定义，
 * 登录失败不区分"用户不存在/密码错"，避免泄露用户名存在性。
 */
export function createIdentityService(deps: IdentityServiceDeps): IdentityService {
  const { prisma, sessions, audit, loginRateLimiter, members } = deps

  async function login(input: LoginInput): Promise<LoginResult> {
    if (!loginRateLimiter.check(input.ip ?? 'unknown')) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: RATE_LIMITED_MESSAGE })
    }

    const user = await prisma.user.findUnique({ where: { username: input.username } })
    if (!user) {
      // 用户不存在与密码错同文案，且不递增任何计数
      throw new TRPCError({ code: 'UNAUTHORIZED', message: AUTH_FAILED_MESSAGE })
    }

    if (user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now()) {
      throw new TRPCError({ code: 'FORBIDDEN', message: LOCKED_MESSAGE })
    }

    let passwordValid = false
    try {
      // 畸形 hash 会让 verify 抛错（见 core/auth/password.ts），按密码错处理
      passwordValid = await verifyPassword(user.passwordHash, input.password)
    } catch {
      passwordValid = false
    }
    if (!passwordValid) {
      const failedLoginCount = user.failedLoginCount + 1
      const data: { failedLoginCount: number; lockedUntil?: Date } = { failedLoginCount }
      if (failedLoginCount >= LOCK_THRESHOLD) {
        data.lockedUntil = new Date(Date.now() + LOCK_DURATION_MS)
      }
      await prisma.user.update({ where: { id: user.id }, data })
      throw new TRPCError({ code: 'UNAUTHORIZED', message: AUTH_FAILED_MESSAGE })
    }

    // 密码已验证通过才暴露禁用态（不向未持凭据者泄露账号状态）
    if (user.status !== 'ACTIVE') {
      throw new TRPCError({ code: 'FORBIDDEN', message: ACCOUNT_DISABLED_MESSAGE })
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    })
    const { token, session } = await sessions.create(user.id, { ip: input.ip })
    await audit.record({
      actorId: user.id,
      actorType: 'USER',
      action: 'auth.login',
      ip: input.ip,
    })
    return { token, session, user: updated }
  }

  async function logout(userId: string, token: string): Promise<{ ok: true }> {
    // 经会话层吊销当前 token（token→hash 的存储细节收敛在 session service 内）
    const revokedCount = await sessions.revokeByToken(token)
    // revokedCount=0（token 本就已失效/不存在）视为幂等登出成功，不抛错；
    // 真实计数记入审计 diff，区分"有效登出"与"幂等登出"
    await audit.record({
      actorId: userId,
      actorType: 'USER',
      action: 'auth.logout',
      diff: { revokedSessions: revokedCount },
    })
    return { ok: true }
  }

  async function changePassword(
    userId: string,
    input: ChangePasswordInput,
  ): Promise<ChangePasswordResult> {
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) {
      throw new TRPCError({ code: 'NOT_FOUND', message: USER_NOT_FOUND_MESSAGE })
    }

    let oldValid = false
    try {
      oldValid = await verifyPassword(user.passwordHash, input.oldPassword)
    } catch {
      oldValid = false
    }
    if (!oldValid) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: OLD_PASSWORD_WRONG_MESSAGE })
    }

    const policy = validatePasswordPolicy(input.newPassword, user.username)
    if (!policy.ok) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: policy.reason ?? '新密码不符合策略' })
    }

    const passwordHash = await hashPassword(input.newPassword)
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: false },
    })
    // 改密后吊销全部旧会话，签发新 token
    await sessions.revokeAllForUser(userId)
    const { token, session } = await sessions.create(userId)
    await audit.record({
      actorId: userId,
      actorType: 'USER',
      action: 'auth.change_password',
    })
    return { token, session }
  }

  /** WorkspaceMember 无 FK relation：按 id 批查 workspace 手动两段式 join（沿任务 1 模式）。
   *  保持传入顺序（分配 createdAt asc）；workspace 已删的孤儿记录与 extraWhere 不命中者跳过。 */
  async function joinWorkspaces(
    refs: ResolvedUserAccess[],
    extraWhere?: Prisma.WorkspaceWhereInput,
  ): Promise<MeWorkspaceRef[]> {
    if (refs.length === 0) return []
    const workspaces = await prisma.workspace.findMany({
      where: { id: { in: refs.map((r) => r.workspaceId) }, ...extraWhere },
      select: { id: true, name: true },
    })
    const nameById = new Map(workspaces.map((w) => [w.id, w.name]))
    return refs.flatMap((ref) => {
      const name = nameById.get(ref.workspaceId)
      return name !== undefined ? [{ id: ref.workspaceId, name, access: ref.access }] : []
    })
  }

  /** me() 的 workspace 列表分治（P1 矩阵）：
   *  - SUPER_ADMIN：全量按 createdAt 前 20（access 恒 MANAGE）+ count；
   *  - OPERATOR：分配记录 join workspace（access 原值，无截断）；
   *  - FINANCE/SUPPORT：不使用 GEO 功能，空列表；
   *  - CUSTOMER+ORG_OWNER：本企业全部（access 恒 MANAGE）+ count；
   *  - CUSTOMER+MEMBER/VIEWER：resolveForUser 批量合成 + 本企业过滤；
   *  - CUSTOMER 无 orgRole/组织：空列表。 */
  async function resolveMeWorkspaces(
    user: User & { organization: { id: string; name: string } | null },
  ): Promise<{ items: MeWorkspaceRef[]; total: number }> {
    if (user.userType === 'PLATFORM') {
      if (user.platformRole === 'SUPER_ADMIN') {
        const where: Prisma.WorkspaceWhereInput = {}
        const [rows, total] = await Promise.all([
          prisma.workspace.findMany({
            where,
            take: ME_WORKSPACE_TAKE,
            orderBy: { createdAt: 'desc' },
            select: { id: true, name: true },
          }),
          prisma.workspace.count({ where }),
        ])
        return { items: rows.map((w) => ({ ...w, access: 'MANAGE' })), total }
      }
      if (user.platformRole === 'OPERATOR') {
        // 分配记录（access 原值，平台侧无合成语义）
        const assignments = await members.listByUser(user.id)
        const items = await joinWorkspaces(
          assignments.map((a) => ({ workspaceId: a.workspaceId, access: a.access })),
        )
        return { items, total: items.length }
      }
      return { items: [], total: 0 }
    }

    // CUSTOMER：无组织/无企业角色 → 无可列 workspace
    if (user.organizationId === null || user.orgRole === null) {
      return { items: [], total: 0 }
    }
    if (user.orgRole === 'ORG_OWNER') {
      // 本企业全部 workspace（无需 member 记录），access 恒 MANAGE
      const where: Prisma.WorkspaceWhereInput = { organizationId: user.organizationId }
      const [rows, total] = await Promise.all([
        prisma.workspace.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          select: { id: true, name: true },
        }),
        prisma.workspace.count({ where }),
      ])
      return { items: rows.map((w) => ({ ...w, access: 'MANAGE' })), total }
    }
    // ORG_MEMBER / ORG_VIEWER：批量合成 + 本企业过滤（跨企业/已删 workspace 不入列）
    const resolved = await members.resolveForUser(user.id)
    const items = await joinWorkspaces(resolved, { organizationId: user.organizationId })
    return { items, total: items.length }
  }

  async function me(userId: string): Promise<MeResult> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { organization: { select: { id: true, name: true } } },
    })
    if (!user) {
      throw new TRPCError({ code: 'NOT_FOUND', message: USER_NOT_FOUND_MESSAGE })
    }

    const { items, total } = await resolveMeWorkspaces(user)
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      userType: user.userType,
      platformRole: user.platformRole,
      mustChangePassword: user.mustChangePassword,
      workspaces: { items, total },
      organization: user.organization
        ? { id: user.organization.id, name: user.organization.name }
        : null,
      orgRole: user.orgRole ?? undefined,
    }
  }

  async function createUser(input: CreateUserInput): Promise<CreateUserResult> {
    const password = input.password ?? generateTempPassword()
    if (input.password !== undefined) {
      // 显式提供的密码同样要走策略（临时密码构造上即满足策略，无需校验）
      const policy = validatePasswordPolicy(input.password, input.username)
      if (!policy.ok) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: policy.reason ?? '密码不符合策略' })
      }
    }
    const passwordHash = await hashPassword(password)

    let user: User
    try {
      user = await prisma.user.create({
        data: {
          username: input.username,
          displayName: input.displayName,
          userType: 'PLATFORM',
          platformRole: input.platformRole,
          passwordHash,
          mustChangePassword: true,
        },
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: USERNAME_TAKEN_MESSAGE })
      }
      throw error
    }

    await audit.record({
      actorId: input.actorId,
      actorType: 'USER',
      action: 'user.create',
      target: `User:${user.id}`,
      diff: { username: input.username, platformRole: input.platformRole },
    })
    return { user, password }
  }

  /** 企业成员创建（org.members.create 后端）：username 缺省自动生成，
   *  mustChangePassword=true，audit 'user.create'，明文密码仅返回一次。 */
  async function createOrgUser(input: CreateOrgUserInput): Promise<CreateOrgUserResult> {
    // 防御：ORG_OWNER 只能由平台侧（迁移/bootstrap/后台）产生，成员管理不可自造平级。
    // （类型已排除 ORG_OWNER，此处收宽比较保留运行时防御——绕过类型直调 service 也拒）
    if ((input.orgRole as OrgRole) === 'ORG_OWNER') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: '不允许创建 ORG_OWNER 账号（企业所有者由平台侧创建）',
      })
    }

    const org = await prisma.organization.findUnique({
      where: { id: input.organizationId },
      select: { id: true },
    })
    if (!org) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `企业不存在（${input.organizationId}）`,
      })
    }

    const username = input.username ?? (await generateOrgUsername(prisma, input))

    const password = input.password ?? generateTempPassword()
    if (input.password !== undefined) {
      // 显式提供的密码同样要走策略（临时密码构造上即满足策略，无需校验）
      const policy = validatePasswordPolicy(input.password, username)
      if (!policy.ok) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: policy.reason ?? '密码不符合策略' })
      }
    }
    const passwordHash = await hashPassword(password)

    let user: User
    try {
      user = await prisma.user.create({
        data: {
          username,
          displayName: input.displayName,
          email: input.email,
          userType: 'CUSTOMER',
          organizationId: input.organizationId,
          orgRole: input.orgRole,
          passwordHash,
          mustChangePassword: true,
        },
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        // P2002 按 meta.target 区分是 username 还是 email 撞唯一约束
        const target = (error as { meta?: { target?: string[] } } | null)?.meta?.target ?? []
        if (input.email !== undefined && target.includes('email')) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: '邮箱已被使用' })
        }
        throw new TRPCError({ code: 'BAD_REQUEST', message: USERNAME_TAKEN_MESSAGE })
      }
      throw error
    }

    await audit.record({
      actorId: input.actorId,
      actorType: 'USER',
      action: 'user.create',
      organizationId: input.organizationId,
      target: `User:${user.id}`,
      diff: { username, orgRole: input.orgRole },
    })
    return { user, password }
  }

  async function resetPassword(userId: string, actorId?: string): Promise<string> {
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) {
      throw new TRPCError({ code: 'NOT_FOUND', message: USER_NOT_FOUND_MESSAGE })
    }

    const tempPassword = generateTempPassword()
    const passwordHash = await hashPassword(tempPassword)
    await prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        mustChangePassword: true,
        // 重置密码同时清锁定/失败计数（管理员重置即视为解锁）
        failedLoginCount: 0,
        lockedUntil: null,
      },
    })
    await sessions.revokeAllForUser(userId)
    await audit.record({
      actorId,
      actorType: 'USER',
      action: 'user.reset_password',
      target: `User:${userId}`,
    })
    return tempPassword
  }

  async function setStatus(userId: string, status: UserStatus, actorId?: string): Promise<User> {
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) {
      throw new TRPCError({ code: 'NOT_FOUND', message: USER_NOT_FOUND_MESSAGE })
    }

    const updated = await prisma.user.update({ where: { id: userId }, data: { status } })
    if (status === 'DISABLED') {
      await sessions.revokeAllForUser(userId)
    }
    await audit.record({
      actorId,
      actorType: 'USER',
      action: 'user.set_status',
      target: `User:${userId}`,
      diff: { status },
    })
    return updated
  }

  async function listUsers(query: ListUsersQuery): Promise<ListUsersResult> {
    const page = query.page ?? 1
    const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
    // organizationId 过滤（救援通道）：按企业查 CUSTOMER 账号；缺省维持平台员工列表
    const where: Prisma.UserWhereInput = query.organizationId
      ? { userType: 'CUSTOMER', organizationId: query.organizationId }
      : { userType: 'PLATFORM' }
    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          username: true,
          displayName: true,
          platformRole: true,
          status: true,
          mustChangePassword: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.user.count({ where }),
    ])
    return { items, total }
  }

  return { login, logout, changePassword, me, createUser, createOrgUser, resetPassword, setStatus, listUsers }
}
