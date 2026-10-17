import { TRPCError } from '@trpc/server'
import type {
  ApiCredential,
  Organization,
  PrismaClient,
  UserStatus,
  WorkspaceAccess,
  WorkspaceStatus,
} from '@prisma/client'
import type { AuditService } from '../audit/service.js'
import type { IdentityService } from '../identity/service.js'
import type { MemberService, OrgMemberView } from '../tenancy/member-service.js'
import type {
  ApiCredentialService,
  ApiCredentialSummary,
} from '../tenancy/api-credentials.js'
import type {
  CreateWorkspaceAdminResult,
  PlatformSummary,
  UpdateWorkspaceInput,
  WorkspaceAdminService,
  WorkspaceAdminView,
  WorkspaceAdminViewWithOrg,
  WorkspaceListResult,
} from '../tenancy/workspace-admin.js'

/** 用户不存在统一文案（与 identity service 对齐） */
const USER_NOT_FOUND_MESSAGE = '用户不存在'

/**
 * ORG_OWNER 目标保护文案（P1 终审收紧）：企业内 OWNER 互相禁用/重置密码
 * = 单 OWNER 企业自锁 / 多 OWNER 企业内账号接管，此类操作仅平台侧可执行。
 */
const ORG_OWNER_PROTECTED_MESSAGE =
  '企业管理员账号的禁用与密码重置请联系平台，企业内不可操作'

/** org.info.* 的企业投影（客户控制台只读字段） */
export interface OrgInfoView {
  id: string
  name: string
  creditCode: string | null
  industry: string | null
  status: Organization['status']
}

export interface OrgInfoUpdateInput {
  name?: string
  creditCode?: string
  industry?: string
}

/** org.members.create 入参（orgRole 由 router 层 zod 物理排除 ORG_OWNER） */
export interface OrgMembersCreateInput {
  username?: string
  email?: string
  displayName: string
  orgRole: 'ORG_MEMBER' | 'ORG_VIEWER'
  password?: string
}

/** org.members.create 返回的用户投影（明文密码仅此一次） */
export interface OrgMemberCreatedView {
  user: {
    id: string
    username: string
    displayName: string
    email: string | null
    orgRole: 'ORG_MEMBER' | 'ORG_VIEWER'
    status: UserStatus
    mustChangePassword: boolean
  }
  password: string
}

export interface OrgSetAccessInput {
  userId: string
  workspaceId: string
  access: WorkspaceAccess
}

/**
 * org.workspaces.create 入参（客户侧无组织概念：organizationId 由 actor 派生强制=本企业，
 * 物理不接受 newOrganizationName/organizationId——router zod 与 service 透传构造双重排除）。
 */
export interface OrgCreateWorkspaceInput {
  name: string
  defaultBrandName: string
  domain?: string
  llmsTxtUrl?: string
}

/** org.workspaces.list 入参（同 admin list 的筛选/分页，但去掉 organizationId——恒=本企业） */
export interface OrgWorkspaceListQuery {
  q?: string
  status?: WorkspaceStatus
  page?: number
  pageSize?: number
}

/** org.credentials.issue 返回：脱敏 credential + 一次性明文 key（keyHash 不出 service 边界） */
export interface OrgIssuedCredential {
  credential: ApiCredentialSummary
  plaintext: string
}

export interface OrgServiceDeps {
  prisma: PrismaClient
  identity: IdentityService
  members: MemberService
  audit: AuditService
  /** P0 API 凭证服务：本服务只做企业边界包装，全部逻辑透传（零复制） */
  credentials: ApiCredentialService
  /** P0 工作区管理服务：本服务只做企业边界包装，全部逻辑透传（零复制） */
  workspaceAdmin: WorkspaceAdminService
}

export interface OrgService {
  infoGet(organizationId: string): Promise<OrgInfoView>
  infoUpdate(
    organizationId: string,
    input: OrgInfoUpdateInput,
    actorId?: string,
  ): Promise<OrgInfoView>
  membersList(organizationId: string): Promise<OrgMemberView[]>
  membersCreate(
    organizationId: string,
    input: OrgMembersCreateInput,
    actorId?: string,
  ): Promise<OrgMemberCreatedView>
  membersSetAccess(
    organizationId: string,
    input: OrgSetAccessInput,
    actorId?: string,
  ): Promise<{ ok: true }>
  membersSetStatus(
    organizationId: string,
    userId: string,
    status: UserStatus,
    actorId?: string,
  ): Promise<{ id: string; status: UserStatus }>
  membersResetPassword(organizationId: string, userId: string, actorId?: string): Promise<string>
  listWorkspaces(organizationId: string, query?: OrgWorkspaceListQuery): Promise<WorkspaceListResult>
  getWorkspace(
    organizationId: string,
    workspaceId: string,
  ): Promise<{ workspace: WorkspaceAdminViewWithOrg; platformSummary: PlatformSummary }>
  createWorkspace(
    organizationId: string,
    input: OrgCreateWorkspaceInput,
    /** 必填：workspaceAdmin.create 需以真实操作者签发初始 Key 与审计 */
    actorId: string,
  ): Promise<CreateWorkspaceAdminResult>
  updateWorkspace(
    organizationId: string,
    workspaceId: string,
    patch: UpdateWorkspaceInput,
    actorId?: string,
  ): Promise<WorkspaceAdminView>
  setCompetitors(
    organizationId: string,
    workspaceId: string,
    competitors: string[],
    actorId?: string,
  ): Promise<WorkspaceAdminView>
  setPlatformCredentials(
    organizationId: string,
    workspaceId: string,
    platform: string,
    values: Record<string, string>,
    actorId?: string,
  ): Promise<WorkspaceAdminView>
  getPlatformSummary(organizationId: string, workspaceId: string): Promise<PlatformSummary>
  /** 按工作区列出 API 凭证（脱敏视图；workspace 须属本企业） */
  listCredentials(organizationId: string, workspaceId: string): Promise<ApiCredentialSummary[]>
  /** 签发新凭证（workspace 须属本企业；createdById=操作者；明文仅返回一次） */
  issueCredential(
    organizationId: string,
    workspaceId: string,
    name: string,
    actorId: string,
  ): Promise<OrgIssuedCredential>
  /** 吊销凭证（credential 所属 workspace 须属本企业，越权在吊销动作前拦截） */
  revokeCredential(
    organizationId: string,
    credentialId: string,
    /** 必填：吊销与审计需以真实操作者记录（router 层 actorUserId 注入） */
    actorId: string,
  ): Promise<{ ok: true }>
}

const ORG_INFO_SELECT = {
  id: true,
  name: true,
  creditCode: true,
  industry: true,
  status: true,
} as const

/** prisma ApiCredential 行 → 脱敏投影（issue 返回值裁剪，keyHash 不出边界） */
function toCredentialSummary(credential: ApiCredential): ApiCredentialSummary {
  return {
    id: credential.id,
    name: credential.name,
    keyPrefix: credential.keyPrefix,
    lastUsedAt: credential.lastUsedAt,
    scopes: credential.scopes,
    revokedAt: credential.revokedAt,
  }
}

/**
 * 企业控制台服务（org.* 命名空间的 router 一比一后端）。
 * 所有方法以 organizationId 为边界：越权目标（跨企业 workspace/user）一律拒，
 * 不向客户泄露他企业数据。create/resetPassword/setStatus 透传 identity service
 * （审计与 DISABLED 吊销会话联动由 identity 侧完成，沿 P0 语义）。
 */
export function createOrgService(deps: OrgServiceDeps): OrgService {
  const { prisma, identity, members, audit, credentials, workspaceAdmin } = deps

  async function requireOrgUser(organizationId: string, userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, organizationId: true, orgRole: true },
    })
    if (!user) {
      throw new TRPCError({ code: 'NOT_FOUND', message: USER_NOT_FOUND_MESSAGE })
    }
    if (user.organizationId !== organizationId) {
      throw new TRPCError({ code: 'FORBIDDEN', message: '用户不属于本企业，禁止操作' })
    }
    return user
  }

  /**
   * 禁用/重置密码的目标校验：属本企业（requireOrgUser）且非 ORG_OWNER。
   * ORG_OWNER（含自己）一律 FORBIDDEN——防单 OWNER 企业自锁与 OWNER 间账号接管；
   * 平台侧（identity 直连/迁移）不受此约束。setAccess 不走此校验（分配工作区
   * 访问级非破坏性动作，OWNER 合成授权本就为 MANAGE）。
   */
  async function requireNonOwnerTarget(organizationId: string, userId: string) {
    const user = await requireOrgUser(organizationId, userId)
    if (user.orgRole === 'ORG_OWNER') {
      throw new TRPCError({ code: 'FORBIDDEN', message: ORG_OWNER_PROTECTED_MESSAGE })
    }
    return user
  }

  /** 工作区属本企业校验：不存在 NOT_FOUND、跨企业 FORBIDDEN（任务 3 的属本企业模式） */
  async function requireOrgWorkspace(organizationId: string, workspaceId: string) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, organizationId: true },
    })
    if (!workspace) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `工作区不存在（${workspaceId}）` })
    }
    if (workspace.organizationId !== organizationId) {
      throw new TRPCError({ code: 'FORBIDDEN', message: '工作区不属于本企业，禁止操作' })
    }
    return workspace
  }

  async function infoGet(organizationId: string): Promise<OrgInfoView> {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: ORG_INFO_SELECT,
    })
    if (!org) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `企业不存在（${organizationId}）` })
    }
    return org
  }

  async function infoUpdate(
    organizationId: string,
    input: OrgInfoUpdateInput,
    actorId?: string,
  ): Promise<OrgInfoView> {
    // 先校验存在（update where 未命中会抛 P2025，语义不如 NOT_FOUND 直观）
    await infoGet(organizationId)
    const org = await prisma.organization.update({
      where: { id: organizationId },
      data: input,
      select: ORG_INFO_SELECT,
    })
    await audit.record({
      actorId,
      actorType: 'USER',
      action: 'org.update',
      organizationId,
      target: `Organization:${organizationId}`,
      diff: { name: input.name, creditCode: input.creditCode, industry: input.industry },
    })
    return org
  }

  async function membersList(organizationId: string): Promise<OrgMemberView[]> {
    return members.listOrgMembers(organizationId)
  }

  async function membersCreate(
    organizationId: string,
    input: OrgMembersCreateInput,
    actorId?: string,
  ): Promise<OrgMemberCreatedView> {
    const { user, password } = await identity.createOrgUser({
      organizationId,
      username: input.username,
      email: input.email,
      displayName: input.displayName,
      orgRole: input.orgRole,
      password: input.password,
      actorId,
    })
    return {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        orgRole: user.orgRole as 'ORG_MEMBER' | 'ORG_VIEWER',
        status: user.status,
        mustChangePassword: user.mustChangePassword,
      },
      password,
    }
  }

  async function membersSetAccess(
    organizationId: string,
    input: OrgSetAccessInput,
    actorId?: string,
  ): Promise<{ ok: true }> {
    // 双越权校验：workspace 与 user 都必须属本企业
    await requireOrgWorkspace(organizationId, input.workspaceId)
    await requireOrgUser(organizationId, input.userId)

    await members.upsert(input.workspaceId, input.userId, input.access)
    await audit.record({
      actorId,
      actorType: 'USER',
      action: 'member.set_access',
      organizationId,
      workspaceId: input.workspaceId,
      target: `User:${input.userId}`,
      diff: { workspaceId: input.workspaceId, access: input.access },
    })
    return { ok: true }
  }

  async function membersSetStatus(
    organizationId: string,
    userId: string,
    status: UserStatus,
    actorId?: string,
  ): Promise<{ id: string; status: UserStatus }> {
    await requireNonOwnerTarget(organizationId, userId)
    // 透传 identity：DISABLED 时 revokeAllForUser + audit 'user.set_status'（沿 P0 语义）
    const user = await identity.setStatus(userId, status, actorId)
    return { id: user.id, status: user.status }
  }

  async function membersResetPassword(
    organizationId: string,
    userId: string,
    actorId?: string,
  ): Promise<string> {
    await requireNonOwnerTarget(organizationId, userId)
    // 透传 identity：重置 + 吊销全部会话 + audit 'user.reset_password'，明文仅返回一次
    return identity.resetPassword(userId, actorId)
  }

  // ---- workspaces：P0 workspace-admin 的"org 范围包装"薄层 ----
  // 全部逻辑（投影/加密合并/状态机/初始 Key/审计动作名）由 workspaceAdmin 承载，
  // 这里只做企业边界：organizationId 恒由 router 从 actor 派生传入，绝不取自 input。

  async function listWorkspaces(
    organizationId: string,
    query?: OrgWorkspaceListQuery,
  ): Promise<WorkspaceListResult> {
    // organizationId 显式置后：即便 query 混入也无法覆盖本企业边界
    return workspaceAdmin.list({ ...query, organizationId })
  }

  async function getWorkspace(
    organizationId: string,
    workspaceId: string,
  ): Promise<{ workspace: WorkspaceAdminViewWithOrg; platformSummary: PlatformSummary }> {
    await requireOrgWorkspace(organizationId, workspaceId)
    return workspaceAdmin.get(workspaceId)
  }

  async function createWorkspace(
    organizationId: string,
    input: OrgCreateWorkspaceInput,
    actorId: string,
  ): Promise<CreateWorkspaceAdminResult> {
    // 逐字段构造透传（非 spread）：organizationId 强制=本企业，物理不存在 newOrganizationName 路径；
    // 初始 Key 签发 + audit 'workspace.create' 由 workspaceAdmin.create 完成（沿 P0）
    return workspaceAdmin.create(
      {
        name: input.name,
        defaultBrandName: input.defaultBrandName,
        domain: input.domain,
        llmsTxtUrl: input.llmsTxtUrl,
        organizationId,
      },
      actorId,
    )
  }

  async function updateWorkspace(
    organizationId: string,
    workspaceId: string,
    patch: UpdateWorkspaceInput,
    actorId?: string,
  ): Promise<WorkspaceAdminView> {
    await requireOrgWorkspace(organizationId, workspaceId)
    return workspaceAdmin.update(workspaceId, patch, actorId)
  }

  async function setCompetitors(
    organizationId: string,
    workspaceId: string,
    competitors: string[],
    actorId?: string,
  ): Promise<WorkspaceAdminView> {
    await requireOrgWorkspace(organizationId, workspaceId)
    return workspaceAdmin.setCompetitors(workspaceId, competitors, actorId)
  }

  async function setPlatformCredentials(
    organizationId: string,
    workspaceId: string,
    platform: string,
    values: Record<string, string>,
    actorId?: string,
  ): Promise<WorkspaceAdminView> {
    await requireOrgWorkspace(organizationId, workspaceId)
    return workspaceAdmin.setPlatformCredentials(workspaceId, platform, values, actorId)
  }

  async function getPlatformSummary(
    organizationId: string,
    workspaceId: string,
  ): Promise<PlatformSummary> {
    await requireOrgWorkspace(organizationId, workspaceId)
    // 与 workspace-admin.get 同源：复用其注入的 getSummary（credentials 概况投影）
    const { platformSummary } = await workspaceAdmin.get(workspaceId)
    return platformSummary
  }

  // ---- credentials：P0 api-credentials 的"org 范围包装"薄层 ----
  // 边界同 workspaces：先 requireOrgWorkspace 判定属本企业，再透传 credentials 服务；
  // 签发/吊销的审计在 org 层完成（api-credentials service 无 audit 依赖，沿 P0 装配现状）。

  async function listCredentials(
    organizationId: string,
    workspaceId: string,
  ): Promise<ApiCredentialSummary[]> {
    await requireOrgWorkspace(organizationId, workspaceId)
    return credentials.list(workspaceId)
  }

  async function issueCredential(
    organizationId: string,
    workspaceId: string,
    name: string,
    actorId: string,
  ): Promise<OrgIssuedCredential> {
    await requireOrgWorkspace(organizationId, workspaceId)
    const { credential, plaintext } = await credentials.issue(workspaceId, name, actorId)
    // P1 遗留 2a：签发补审计（形状照同文件 revoke——organizationId/workspaceId 齐全）
    await audit.record({
      actorId,
      actorType: 'USER',
      action: 'credential.issue',
      organizationId,
      workspaceId,
      target: `ApiCredential:${credential.id}`,
    })
    // 红线：keyHash 不出 service 边界（同 workspace-admin 的 platformConfig 约束）
    return { credential: toCredentialSummary(credential), plaintext }
  }

  async function revokeCredential(
    organizationId: string,
    credentialId: string,
    actorId: string,
  ): Promise<{ ok: true }> {
    // 先解析 credential 所属 workspace 并判定属本企业，越权绝不触达 revoke
    const credential = await prisma.apiCredential.findUnique({
      where: { id: credentialId },
      select: { id: true, workspaceId: true },
    })
    if (!credential) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `凭证不存在（${credentialId}）` })
    }
    const workspace = await requireOrgWorkspace(organizationId, credential.workspaceId)

    await credentials.revoke(credentialId, actorId)
    await audit.record({
      actorId,
      actorType: 'USER',
      action: 'credential.revoke',
      organizationId,
      workspaceId: workspace.id,
      target: `ApiCredential:${credentialId}`,
    })
    return { ok: true }
  }

  return {
    infoGet,
    infoUpdate,
    membersList,
    membersCreate,
    membersSetAccess,
    membersSetStatus,
    membersResetPassword,
    listWorkspaces,
    getWorkspace,
    createWorkspace,
    updateWorkspace,
    setCompetitors,
    setPlatformCredentials,
    getPlatformSummary,
    listCredentials,
    issueCredential,
    revokeCredential,
  }
}
