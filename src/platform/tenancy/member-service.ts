import type { OrgRole, PrismaClient, UserStatus, WorkspaceAccess } from '@prisma/client'

/**
 * 权限合成（规格 §2.2 取交集/最小权限）：
 * 客户用户对某 Workspace 的最终权限 = min(企业角色上限, WorkspaceMember.access)。
 *
 * - ORG_OWNER：无需 WorkspaceMember 记录即本企业全部 Workspace 的 MANAGE；
 * - ORG_MEMBER：以 WorkspaceMember.access 为准，无记录则无权限；
 * - ORG_VIEWER：企业角色上限只读——即使被授予 OPERATE/MANAGE 也降为 VIEW，无记录则无权限；
 * - 无企业角色（null/undefined）：无客户权限。
 *
 * 纯函数：context 授权分治（任务 2）与测试直接复用，不触 prisma。
 */
export function synthesize(
  orgRole: OrgRole | null | undefined,
  memberAccess: WorkspaceAccess | null,
): WorkspaceAccess | null {
  if (orgRole === 'ORG_OWNER') return 'MANAGE'
  if (orgRole === 'ORG_MEMBER') return memberAccess
  if (orgRole === 'ORG_VIEWER') return memberAccess ? 'VIEW' : null
  return null
}

/** 成员视图的用户基础投影 */
export interface MemberUserView {
  id: string
  username: string
  displayName: string
}

/** 工作区成员视图（WorkspaceMember 无 FK relation：user 由服务手动 join） */
export interface MemberWithUserView {
  user: MemberUserView
  access: WorkspaceAccess
  isPrimary: boolean
}

/** 用户视角的成员记录投影 */
export interface MemberByUserView {
  workspaceId: string
  access: WorkspaceAccess
  isPrimary: boolean
}

/** resolveForUser 的产出：某用户对一批 workspace 的最终权限（已合成，恒非空 access） */
export interface ResolvedUserAccess {
  workspaceId: string
  access: WorkspaceAccess
}

/** 企业成员的用户投影（含企业角色与账号状态；无 workspace 级 access 概念）。
 * orgRole 按库表可空（User.orgRole?）：正常成员恒非空，null 为脏数据兜底展示。 */
export interface OrgMemberUserView extends MemberUserView {
  orgRole: OrgRole | null
  status: UserStatus
  lastLoginAt: Date | null
}

/** 企业成员视图（user 表直查） */
export interface OrgMemberView {
  user: OrgMemberUserView
}

/**
 * resolveAccess 的最小 workspace 形状：
 * id 用于 WorkspaceMember 复合主键查询，organizationId 用于跨企业校验。
 */
export interface AccessWorkspaceRef {
  id: string
  organizationId: string
}

export interface MemberService {
  /**
   * 客户用户对某 workspace 的最终权限（授权分治：PLATFORM 语义由调用方处理，
   * 本函数只管客户语义）。用户不存在 / PLATFORM 用户 / 跨企业（workspace.organizationId
   * ≠ user.organizationId）一律返回 null。
   */
  resolveAccess(
    userId: string,
    workspace: AccessWorkspaceRef,
    orgRole?: OrgRole | null,
  ): Promise<WorkspaceAccess | null>
  /**
   * OPERATOR 等平台用户的分配存在性（context 授权分治：PLATFORM 用户恒被
   * resolveAccess 拒，OPERATOR 依据 WorkspaceMember 记录判定）。无角色合成语义。
   */
  hasAssignment(userId: string, workspaceId: string): Promise<boolean>
  /**
   * resolveAccess 的批量版（me() 用，避免逐 workspace N+1）：
   * listByUser + 查 user orgRole + synthesize map。只管客户语义——
   * 非 CUSTOMER / 用户不存在 / 无 orgRole 返回空数组。
   * 跨企业过滤由调用方按 workspace.organizationId 收口（本方法不查 workspace 表）。
   */
  resolveForUser(userId: string): Promise<ResolvedUserAccess[]>
  listMembers(workspaceId: string): Promise<MemberWithUserView[]>
  listByUser(userId: string): Promise<MemberByUserView[]>
  upsert(workspaceId: string, userId: string, access: WorkspaceAccess): Promise<void>
  remove(workspaceId: string, userId: string): Promise<void>
  listOrgMembers(organizationId: string): Promise<OrgMemberView[]>
}

/**
 * WorkspaceMember 统一服务：授权合成（resolveAccess）、成员 CRUD、企业成员视图。
 * 授权实时查库不缓存——成员降权/移除后在途会话的下一个请求即生效。
 */
export function createMemberService(prisma: PrismaClient): MemberService {
  return {
    async resolveAccess(userId, workspace, orgRole) {
      // organizationId 恒需查 user（跨企业校验）；orgRole 未传入时一并从库取
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { userType: true, organizationId: true, orgRole: true },
      })
      if (!user) return null
      // 平台语义分治由调用方做：本函数只管客户
      if (user.userType !== 'CUSTOMER') return null
      // 跨企业一律拒（含 orgRole 由调用方传入的路径）
      if (user.organizationId === null || user.organizationId !== workspace.organizationId) {
        return null
      }
      const role = orgRole ?? user.orgRole ?? null
      // OWNER 无需 WorkspaceMember 记录即 MANAGE（§2.2），不查记录
      const member =
        role === 'ORG_OWNER'
          ? null
          : await prisma.workspaceMember.findUnique({
              where: { workspaceId_userId: { workspaceId: workspace.id, userId } },
            })
      return synthesize(role, member ? member.access : null)
    },

    /** 分配存在性：复合主键直查（真值即授权，无合成语义） */
    async hasAssignment(userId, workspaceId) {
      const member = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
      })
      return member !== null
    },

    /** 批量合成授权：ORG_OWNER 的全量授权不经 member 记录，调用方（me）对 OWNER 走本企业全量路径 */
    async resolveForUser(userId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { userType: true, orgRole: true },
      })
      if (!user || user.userType !== 'CUSTOMER') return []
      const orgRole = user.orgRole ?? null
      if (!orgRole) return []
      const members = await prisma.workspaceMember.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      })
      return members.flatMap((m) => {
        const access = synthesize(orgRole, m.access)
        return access ? [{ workspaceId: m.workspaceId, access }] : []
      })
    },

    /** 工作区成员列表：无 FK relation，user 手动 join；引用用户已删的孤儿记录跳过 */
    async listMembers(workspaceId) {
      const members = await prisma.workspaceMember.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'asc' },
      })
      if (members.length === 0) return []
      const users = await prisma.user.findMany({
        where: { id: { in: members.map((m) => m.userId) } },
        select: { id: true, username: true, displayName: true },
      })
      const userById = new Map(users.map((u) => [u.id, u]))
      return members.flatMap((m) => {
        const user = userById.get(m.userId)
        return user ? [{ user, access: m.access, isPrimary: m.isPrimary }] : []
      })
    },

    async listByUser(userId) {
      const members = await prisma.workspaceMember.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      })
      return members.map((m) => ({
        workspaceId: m.workspaceId,
        access: m.access,
        isPrimary: m.isPrimary,
      }))
    },

    /** 授予/调整成员权限（复合主键 upsert） */
    async upsert(workspaceId, userId, access) {
      await prisma.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId, userId } },
        create: { workspaceId, userId, access },
        update: { access },
      })
    },

    /** 移除成员授权：物理删除记录（授权实时查库，移除立即生效） */
    async remove(workspaceId, userId) {
      await prisma.workspaceMember.delete({
        where: { workspaceId_userId: { workspaceId, userId } },
      })
    },

    /** 企业成员列表：user 表 where organizationId（无 workspace 级 access） */
    async listOrgMembers(organizationId) {
      const users = await prisma.user.findMany({
        where: { organizationId },
        select: {
          id: true,
          username: true,
          displayName: true,
          orgRole: true,
          status: true,
          lastLoginAt: true,
        },
        orderBy: { createdAt: 'asc' },
      })
      return users.map((user) => ({ user }))
    },
  }
}
