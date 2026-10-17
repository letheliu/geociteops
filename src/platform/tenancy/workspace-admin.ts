import type { Prisma, PrismaClient, Workspace, WorkspaceStatus } from '@prisma/client'
import { decryptConfig, encryptConfig, isEncryptedConfig } from '../../core/crypto/envelope.js'
import type { BillingCheckpoints } from '../billing/entitlement-guard.js'
import type { ApiCredentialService } from './api-credentials.js'
import type { AuditService } from '../audit/service.js'
import type { MemberService, MemberUserView } from './member-service.js'

/**
 * 状态机非法迁移错误（乐观并发命中 0 行时抛出）：
 * name 固定为 WORKSPACE_INVALID_TRANSITION，message 含当前实际 status。
 */
export class WorkspaceTransitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WORKSPACE_INVALID_TRANSITION'
  }
}

/** 工作区不存在错误：name 固定为 WORKSPACE_NOT_FOUND */
export class WorkspaceNotFoundError extends Error {
  constructor(id: string) {
    super(`工作区不存在：${id}`)
    this.name = 'WORKSPACE_NOT_FOUND'
  }
}

/**
 * 顾问分配目标不合格错误：name 固定为 OPERATOR_NOT_ELIGIBLE。
 * 触发：用户不存在 / userType 非 PLATFORM（assign 另要求 platformRole 为 OPERATOR）。
 */
export class OperatorNotEligibleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OPERATOR_NOT_ELIGIBLE'
  }
}

/** 顾问分配记录不存在（unassign 重删/记录缺失）：name 固定为 OPERATOR_ASSIGNMENT_NOT_FOUND */
export class OperatorAssignmentNotFoundError extends Error {
  constructor(workspaceId: string, userId: string) {
    super(`顾问分配记录不存在：workspaceId=${workspaceId}, userId=${userId}`)
    this.name = 'OPERATOR_ASSIGNMENT_NOT_FOUND'
  }
}

/** prisma P2025（delete 目标记录不存在）鸭型判定：不引运行时 Prisma 命名空间，mock 与真实驱动通吃 */
function isPrismaRecordNotFound(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === 'P2025'
}

/** 顾问分配视图（listOperators 返回）：PLATFORM 成员记录 + 负责顾问标记 */
export interface OperatorAssignmentView {
  user: MemberUserView
  isPrimary: boolean
}

/** 平台配置概况（credential resolver getSummary 的返回形状） */
export interface PlatformSummary {
  competitors: string[]
  platforms: Record<string, { configured: boolean; hint: string }>
}

/**
 * admin 响应的工作区脱敏投影（显式字段白名单）。
 * 红线：admin 详情响应不得含 platformConfig 原文或密文——凭证概况只经 platformSummary
 * （{configured, hint}）下发；platformConfig/publicationConfig 一律不出 service 边界。
 */
export interface WorkspaceAdminView {
  id: string
  name: string
  domain: string | null
  llmsTxtUrl: string | null
  defaultBrandName: string
  status: WorkspaceStatus
  organizationId: string
  archivedAt: Date | null
  createdAt: Date
  updatedAt: Date
  /** list/get 带 include 时填充；create/mutation 返回 prisma 原行时为 null */
  organization: { id: string; name: string } | null
}

/** list/get 的投影变体：查询恒带 include organization，关系非空（web 前端按非空消费） */
export type WorkspaceAdminViewWithOrg = WorkspaceAdminView & {
  organization: { id: string; name: string }
}

/** prisma Workspace 行 → admin 脱敏投影（未取 organization 关系时置 null） */
function toAdminView(
  ws: Workspace & { organization?: { id: string; name: string } | null },
): WorkspaceAdminView {
  return {
    id: ws.id,
    name: ws.name,
    domain: ws.domain,
    llmsTxtUrl: ws.llmsTxtUrl,
    defaultBrandName: ws.defaultBrandName,
    status: ws.status,
    organizationId: ws.organizationId,
    archivedAt: ws.archivedAt,
    createdAt: ws.createdAt,
    updatedAt: ws.updatedAt,
    organization: ws.organization ? { id: ws.organization.id, name: ws.organization.name } : null,
  }
}

/** prisma Workspace 行（include organization）→ list/get 用的非空组织投影 */
function toAdminViewWithOrg(
  ws: Workspace & { organization: { id: string; name: string } },
): WorkspaceAdminViewWithOrg {
  return {
    ...toAdminView(ws),
    organization: { id: ws.organization.id, name: ws.organization.name },
  }
}

export interface WorkspaceListQuery {
  q?: string
  status?: WorkspaceStatus
  organizationId?: string
  page?: number
  pageSize?: number
}

export interface WorkspaceListResult {
  items: WorkspaceAdminViewWithOrg[]
  total: number
}

export interface CreateWorkspaceAdminInput {
  name: string
  defaultBrandName: string
  domain?: string
  llmsTxtUrl?: string
  /** 组织来源二选一：直接指定已有组织 */
  organizationId?: string
  /** 组织来源二选一：现场新建组织 */
  newOrganizationName?: string
}

export interface CreateWorkspaceAdminResult {
  workspace: WorkspaceAdminView
  /** 初始 Key 的一次性明文（仅此一次返回） */
  apiKey: string
}

export interface UpdateWorkspaceInput {
  name?: string
  domain?: string
  defaultBrandName?: string
  llmsTxtUrl?: string
}

/**
 * suspend 的暂停原因选项（任务 8 签名扩展）：
 * opts.suspendReason 落库到 Workspace.suspendReason 列——机器可读的恢复锚
 * （'订阅到期' 续费恢复 / '账期超期' 应收确认恢复）。手动暂停不传 → 保持 null，
 * 不进入任何自动恢复面；reason 参数（audit 展示用自由文本）与落库值解耦。
 */
export interface SuspendOptions {
  suspendReason?: string
}

export interface WorkspaceAdminDeps {
  prisma: PrismaClient
  credentials: ApiCredentialService
  audit: AuditService
  /** WorkspaceMember 统一服务（顾问分配复用这张表：access='OPERATE'，isPrimary=负责顾问） */
  members: MemberService
  /** 信封主密钥（装配处 loadMasterKey() 传入；service 不读 env，便于测试注入假 key） */
  envelopeKey: string
  /** platformConfig 概况（任务 10 credential resolver 的 getSummary），get() 详情用 */
  getSummary: (workspaceId: string) => Promise<PlatformSummary>
  /**
   * 计费检查点（任务 9，可选注入——缺省不检查便于存量测试）：
   * - create → maxWorkspaces 硬限（配额槽事务窗口内创建）；
   * - setPlatformCredentials → allowedPlatforms 集合校验。
   * enforcement 开关在 guard 内部判定，业务不感知。
   */
  billing?: BillingCheckpoints
}

export interface WorkspaceAdminService {
  list(query: WorkspaceListQuery): Promise<WorkspaceListResult>
  create(
    input: CreateWorkspaceAdminInput,
    /** 操作者（签发初始 Key 的 createdById 与审计 actorId） */
    actorId: string,
  ): Promise<CreateWorkspaceAdminResult>
  update(id: string, input: UpdateWorkspaceInput, actorId?: string): Promise<WorkspaceAdminView>
  setPlatformCredentials(
    id: string,
    platform: string,
    values: Record<string, string>,
    actorId?: string,
  ): Promise<WorkspaceAdminView>
  setCompetitors(id: string, competitors: string[], actorId?: string): Promise<WorkspaceAdminView>
  suspend(id: string, reason?: string, actorId?: string, opts?: SuspendOptions): Promise<WorkspaceAdminView>
  resume(id: string, actorId?: string): Promise<WorkspaceAdminView>
  archive(id: string, actorId?: string): Promise<WorkspaceAdminView>
  transfer(id: string, targetOrganizationId: string, actorId?: string): Promise<WorkspaceAdminView>
  enter(id: string, input: { userId: string }): Promise<{ ok: true }>
  get(id: string): Promise<{ workspace: WorkspaceAdminViewWithOrg; platformSummary: PlatformSummary }>
  /**
   * 分配平台顾问（任务 6）：userId 接受 User.id 或用户名（先按 id 精确命中，
   * 未命中按 username 解析——web 端简化为用户名输入，避免独立用户搜索端点；
   * unassignOperator 同此双通道契约）。校验目标为 PLATFORM+OPERATOR；
   * isPrimary=true 时同 ws 内旧负责顾问清位。
   */
  assignOperator(
    workspaceId: string,
    userId: string,
    opts?: { isPrimary?: boolean },
    actorId?: string,
  ): Promise<{ ok: true }>
  /**
   * 移除顾问分配：userId 与 assignOperator 同双通道契约（User.id 或用户名）。
   * 仅校验 PLATFORM（防误删客户成员记录）；记录不存在（含重删）抛
   * OPERATOR_ASSIGNMENT_NOT_FOUND。
   */
  unassignOperator(workspaceId: string, userId: string, actorId?: string): Promise<{ ok: true }>
  listOperators(workspaceId: string): Promise<OperatorAssignmentView[]>
}

/** 状态机迁移定义：from 允许的起始状态（乐观并发 where 条件） */
const TRANSITIONS: Record<'suspend' | 'resume' | 'archive', {
  from: WorkspaceStatus[]
  to: WorkspaceStatus
}> = {
  suspend: { from: ['ACTIVE'], to: 'SUSPENDED' },
  resume: { from: ['SUSPENDED'], to: 'ACTIVE' },
  archive: { from: ['ACTIVE', 'SUSPENDED'], to: 'ARCHIVED' },
}

/**
 * 读取 platformConfig 的明文视图：信封密文解密，旧明文对象原样返回，null 归一为空对象。
 * （解密逻辑复用 core/crypto/envelope.ts，与任务 10 resolver 同规则）
 */
function toPlainConfig(
  raw: unknown,
  key: string,
  workspaceId: string,
): Record<string, any> {
  if (typeof raw === 'string' && isEncryptedConfig(raw)) {
    try {
      return JSON.parse(decryptConfig(raw, key)) as Record<string, any>
    } catch (err) {
      throw new Error(
        `workspace ${workspaceId} platformConfig 解密/解析失败：${(err as Error).message}`
      )
    }
  }
  return (raw ?? {}) as Record<string, any>
}

/**
 * Workspace 统一管理服务（admin.workspace 路由后端）：
 * 列表/创建发 Key/更新/凭证写入（信封加密）/竞品/状态机（乐观并发）/转移/enter/顾问分配。
 *
 * - platformConfig 生而加密（create 落库即信封），明文凭证从不入库；
 * - 状态机一律 updateMany({ where: { id, status } }) 乐观并发，不做读-判-写；
 * - 顾问分配复用 WorkspaceMember 表（access='OPERATE'，isPrimary=负责顾问），
 *   与客户成员同表不同语义——OPERATOR 的 workspace 授权即任务 2 的 hasAssignment；
 * - 所有变更写审计（audit.record 异常不阻断业务）。
 */
export function createWorkspaceAdminService(deps: WorkspaceAdminDeps): WorkspaceAdminService {
  const { prisma, credentials, audit, members, envelopeKey, getSummary, billing } = deps

  /** 乐观并发状态迁移：命中 0 行时按当前实际 status 抛 WORKSPACE_INVALID_TRANSITION */
  async function transition(opts: {
    id: string
    from: WorkspaceStatus[]
    to: WorkspaceStatus
    setArchivedAt?: boolean
    /** suspend/resume 落库的 suspendReason：suspend 传自动暂停锚，null = 显式
     *  清旧值（手动暂停与 resume 都清——遗留 B4：resume 残留脏锚会让自动恢复面误匹配） */
    suspendReason?: string | null
    action: 'workspace.suspend' | 'workspace.resume' | 'workspace.archive'
    actorId?: string
    diff?: Prisma.InputJsonValue
  }): Promise<WorkspaceAdminView> {
    const data: {
      status: WorkspaceStatus
      archivedAt?: Date
      suspendReason?: string | null
    } = { status: opts.to }
    if (opts.setArchivedAt) data.archivedAt = new Date()
    if (opts.suspendReason !== undefined) data.suspendReason = opts.suspendReason

    const result = await prisma.workspace.updateMany({
      where: { id: opts.id, status: { in: opts.from } },
      data,
    })
    if (result.count === 0) {
      const current = await prisma.workspace.findUnique({ where: { id: opts.id } })
      if (!current) throw new WorkspaceNotFoundError(opts.id)
      throw new WorkspaceTransitionError(
        `工作区 ${opts.id} 当前状态为 ${current.status}，不允许迁移到 ${opts.to}` +
          `（允许的起始状态：${opts.from.join('/')}）`
      )
    }

    await audit.record({
      actorId: opts.actorId,
      actorType: 'USER',
      action: opts.action,
      workspaceId: opts.id,
      target: `Workspace:${opts.id}`,
      diff: opts.diff ?? { status: opts.to },
    })
    // updateMany 不返回实体：count>0 即存在，重取最新状态返回（统一走脱敏投影）
    const updated = await prisma.workspace.findUnique({ where: { id: opts.id } })
    return toAdminView(updated!)
  }

  /** 读旧配置明文 → 合并 → 信封加密落库（返回走脱敏投影） */
  async function mergeAndSealConfig(
    id: string,
    merge: (old: Record<string, any>) => Record<string, any>,
  ): Promise<WorkspaceAdminView> {
    const existing = await prisma.workspace.findUnique({ where: { id } })
    if (!existing) throw new WorkspaceNotFoundError(id)
    const old = toPlainConfig(existing.platformConfig, envelopeKey, id)
    const merged = merge(old)
    const updated = await prisma.workspace.update({
      where: { id },
      data: { platformConfig: encryptConfig(JSON.stringify(merged), envelopeKey) },
    })
    return toAdminView(updated)
  }

  return {
    async list(query) {
      const page = query.page ?? 1
      const pageSize = query.pageSize ?? 20
      const where: Prisma.WorkspaceWhereInput = {}
      if (query.q) {
        where.OR = [{ name: { contains: query.q } }, { domain: { contains: query.q } }]
      }
      if (query.status) where.status = query.status
      if (query.organizationId) where.organizationId = query.organizationId

      const [items, total] = await Promise.all([
        prisma.workspace.findMany({
          where,
          include: { organization: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.workspace.count({ where }),
      ])
      return { items: items.map((ws) => toAdminViewWithOrg(ws)), total }
    },

    async create(input, actorId) {
      const hasOrgId = input.organizationId !== undefined
      const hasNewName = input.newOrganizationName !== undefined
      if (hasOrgId === hasNewName) {
        throw new Error('organizationId 与 newOrganizationName 必须二选一（且仅提供其一）')
      }

      let organizationId: string
      if (input.organizationId !== undefined) {
        organizationId = input.organizationId
      } else {
        const org = await prisma.organization.create({
          data: { name: input.newOrganizationName! },
        })
        organizationId = org.id
      }

      // 任务 9：maxWorkspaces 硬限——配额槽事务持有 OE 行锁，workspace 创建提交
      // 先于 slot.commit（并发创建在锁上排队，commit 后的 count 可见新建行）
      const slot = billing ? await billing.guard.acquireWorkspaceQuotaSlot(organizationId) : null
      let workspace: Workspace
      try {
        workspace = await prisma.workspace.create({
          data: {
            name: input.name,
            defaultBrandName: input.defaultBrandName,
            domain: input.domain,
            llmsTxtUrl: input.llmsTxtUrl,
            organizationId,
            status: 'ACTIVE',
            // 明文 '{}' 从不落库：生而加密为信封
            platformConfig: encryptConfig('{}', envelopeKey),
          },
        })
        await slot?.commit()
      } catch (err) {
        // 创建失败回滚配额槽（成功 commit 后为幂等 no-op）
        await slot?.rollback()
        throw err
      }

      const { plaintext } = await credentials.issue(workspace.id, '初始 Key', actorId)
      await audit.record({
        actorId,
        actorType: 'USER',
        action: 'workspace.create',
        workspaceId: workspace.id,
        organizationId,
        target: `Workspace:${workspace.id}`,
        diff: { name: input.name, organizationId },
      })
      return { workspace: toAdminView(workspace), apiKey: plaintext }
    },

    async update(id, input, actorId) {
      const existing = await prisma.workspace.findUnique({ where: { id } })
      if (!existing) throw new WorkspaceNotFoundError(id)

      const data: {
        name?: string
        domain?: string
        defaultBrandName?: string
        llmsTxtUrl?: string
      } = {}
      const changed: string[] = []
      if (input.name !== undefined) {
        data.name = input.name
        changed.push('name')
      }
      if (input.domain !== undefined) {
        data.domain = input.domain
        changed.push('domain')
      }
      if (input.defaultBrandName !== undefined) {
        data.defaultBrandName = input.defaultBrandName
        changed.push('defaultBrandName')
      }
      if (input.llmsTxtUrl !== undefined) {
        data.llmsTxtUrl = input.llmsTxtUrl
        changed.push('llmsTxtUrl')
      }

      const workspace = await prisma.workspace.update({ where: { id }, data })
      await audit.record({
        actorId,
        actorType: 'USER',
        action: 'workspace.update',
        workspaceId: id,
        target: `Workspace:${id}`,
        diff: changed,
      })
      return toAdminView(workspace)
    },

    async setPlatformCredentials(id, platform, values, actorId) {
      // 任务 9：allowedPlatforms 集合校验（集合型硬语义；空集合放行在 guard 内部）
      if (billing) {
        const ws = await prisma.workspace.findUnique({
          where: { id },
          select: { organizationId: true },
        })
        if (ws) await billing.guard.checkPlatforms(ws.organizationId, [platform])
      }
      const view = await mergeAndSealConfig(id, (old) => ({ ...old, [platform]: values }))
      await audit.record({
        actorId,
        actorType: 'USER',
        action: 'workspace.set_credentials',
        workspaceId: id,
        target: platform,
        diff: { platform },
      })
      return view
    },

    async setCompetitors(id, competitors, actorId) {
      const view = await mergeAndSealConfig(id, (old) => ({ ...old, competitors }))
      await audit.record({
        actorId,
        actorType: 'USER',
        action: 'workspace.set_competitors',
        workspaceId: id,
        target: 'competitors',
        diff: { competitors },
      })
      return view
    },

    async suspend(id, reason, actorId, opts) {
      const diff: Record<string, string> = { status: TRANSITIONS.suspend.to }
      if (reason !== undefined) diff.reason = reason
      return transition({
        id,
        ...TRANSITIONS.suspend,
        action: 'workspace.suspend',
        actorId,
        diff,
        // 手动暂停（未传 opts.suspendReason）保持 null；自动化调用方
        // （订阅到期/账期超期巡检，后继任务）传机器可读恢复锚
        suspendReason: opts?.suspendReason ?? null,
      })
    },

    async resume(id, actorId) {
      // 遗留 B4：显式清 suspendReason——否则"订阅到期/账期超期"暂停后经人工
      // resume 的行残留脏锚（ACTIVE + suspendReason 仍指向自动暂停原因），
      // 后续自动恢复面（续费/应收确认按原因精确圈定）会误匹配误恢复。
      return transition({
        id,
        ...TRANSITIONS.resume,
        suspendReason: null,
        action: 'workspace.resume',
        actorId,
      })
    },

    async archive(id, actorId) {
      return transition({
        id,
        ...TRANSITIONS.archive,
        setArchivedAt: true,
        action: 'workspace.archive',
        actorId,
      })
    },

    async transfer(id, targetOrganizationId, actorId) {
      const existing = await prisma.workspace.findUnique({ where: { id } })
      if (!existing) throw new WorkspaceNotFoundError(id)
      const workspace = await prisma.workspace.update({
        where: { id },
        data: { organizationId: targetOrganizationId },
      })
      await audit.record({
        actorId,
        actorType: 'USER',
        action: 'workspace.transfer',
        workspaceId: id,
        target: `Workspace:${id}`,
        diff: { from: existing.organizationId, to: targetOrganizationId },
      })
      return toAdminView(workspace)
    },

    async enter(id, { userId }) {
      await audit.record({
        actorId: userId,
        actorType: 'USER',
        action: 'workspace.enter',
        workspaceId: id,
        target: `Workspace:${id}`,
      })
      return { ok: true }
    },

    async get(id) {
      const workspace = await prisma.workspace.findUnique({
        where: { id },
        include: { organization: { select: { id: true, name: true } } },
      })
      if (!workspace) throw new WorkspaceNotFoundError(id)
      const platformSummary = await getSummary(id)
      return { workspace: toAdminViewWithOrg(workspace), platformSummary }
    },

    async assignOperator(workspaceId, userId, opts, actorId) {
      const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
      if (!workspace) throw new WorkspaceNotFoundError(workspaceId)

      // 目标解析：先按 id 精确命中，未命中按 username（web 端用户名输入的简化通道）
      const select = { id: true, userType: true, platformRole: true } as const
      const user =
        (await prisma.user.findUnique({ where: { id: userId }, select })) ??
        (await prisma.user.findUnique({ where: { username: userId }, select }))
      if (!user || user.userType !== 'PLATFORM' || user.platformRole !== 'OPERATOR') {
        throw new OperatorNotEligibleError(
          `用户 ${userId} 不是平台顾问（需 PLATFORM 用户且角色为 OPERATOR）`,
        )
      }

      // 成员记录（access 恒 OPERATE；isPrimary 不在 upsert 语义内，需要时单独写）
      await members.upsert(workspaceId, user.id, 'OPERATE')

      const isPrimary = opts?.isPrimary === true
      if (isPrimary) {
        // 清旧 + 设新包在同一事务、先清后设：不出现双 primary；目标行的 not 过滤保证新 primary 不被误清
        await prisma.$transaction([
          prisma.workspaceMember.updateMany({
            where: { workspaceId, isPrimary: true, userId: { not: user.id } },
            data: { isPrimary: false },
          }),
          prisma.workspaceMember.update({
            where: { workspaceId_userId: { workspaceId, userId: user.id } },
            data: { isPrimary: true },
          }),
        ])
      }

      await audit.record({
        actorId,
        actorType: 'USER',
        action: 'workspace.assign_operator',
        workspaceId,
        target: `User:${user.id}`,
        diff: { userId: user.id, isPrimary },
      })
      return { ok: true }
    },

    async unassignOperator(workspaceId, userId, actorId) {
      const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
      if (!workspace) throw new WorkspaceNotFoundError(workspaceId)

      // 目标解析与 assignOperator 同构（双通道契约对称）：先按 id 精确命中，未命中按 username
      const select = { id: true, userType: true } as const
      const user =
        (await prisma.user.findUnique({ where: { id: userId }, select })) ??
        (await prisma.user.findUnique({ where: { username: userId }, select }))
      // 仅 PLATFORM 校验（不含 OPERATOR 资格）：防误删客户成员记录，与 listOperators 的语义一致
      if (!user || user.userType !== 'PLATFORM') {
        throw new OperatorNotEligibleError(
          `用户 ${userId} 不是平台用户，禁止移除其工作区成员记录`,
        )
      }

      try {
        await members.remove(workspaceId, user.id)
      } catch (err) {
        // 记录不存在（重删）→ 命名错误（router 映射 NOT_FOUND），不再裸抛 P2025 变 500
        if (isPrismaRecordNotFound(err)) {
          throw new OperatorAssignmentNotFoundError(workspaceId, user.id)
        }
        throw err
      }
      await audit.record({
        actorId,
        actorType: 'USER',
        action: 'workspace.unassign_operator',
        workspaceId,
        target: `User:${user.id}`,
        diff: { userId: user.id },
      })
      return { ok: true }
    },

    async listOperators(workspaceId) {
      const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
      if (!workspace) throw new WorkspaceNotFoundError(workspaceId)

      // 全量成员 → service 层按 userType=PLATFORM 过滤（listMembers 的 user 投影不含 userType，
      // 补一次带类型条件的 user 查询做交集；客户成员混入即被滤掉）
      const all = await members.listMembers(workspaceId)
      if (all.length === 0) return []
      const platformUsers = await prisma.user.findMany({
        where: { id: { in: all.map((m) => m.user.id) }, userType: 'PLATFORM' },
        select: { id: true, username: true, displayName: true },
      })
      const platformIds = new Set(platformUsers.map((u) => u.id))
      return all
        .filter((m) => platformIds.has(m.user.id))
        .map((m) => ({ user: m.user, isPrimary: m.isPrimary }))
    },
  }
}
