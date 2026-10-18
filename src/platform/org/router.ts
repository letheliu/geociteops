import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { UserStatus, WorkspaceAccess, WorkspaceStatus } from '@prisma/client'
import { router, orgProcedure } from '../../core/trpc/init.js'
import type { Context } from '../../core/trpc/init.js'
import { getPrismaClient } from '../../core/db/client.js'
import { loadMasterKey } from '../../core/crypto/envelope.js'
import { createAdapterRegistry } from '../../modules/citation-monitor/platform-adapters/registry.js'
import { createAuditService } from '../audit/service.js'
import { createIdentityService } from '../identity/service.js'
import { createLoginRateLimiter } from '../identity/rate-limiter.js'
import { createSessionService } from '../../core/auth/session.js'
import { createMemberService } from '../tenancy/member-service.js'
import {
  createApiCredentialService,
  ApiCredentialNotRevokableError,
} from '../tenancy/api-credentials.js'
import { createCredentialResolver } from '../tenancy/credential-resolver.js'
import {
  createWorkspaceAdminService,
  WorkspaceNotFoundError,
  WorkspaceConfigError,
  WorkspaceTransitionError,
} from '../tenancy/workspace-admin.js'
import { createOrgService } from './service.js'
import type { OrgService } from './service.js'

/** 成员管理可授予的企业角色（zod 物理排除 ORG_OWNER——控制者裁定：OWNER 由平台侧创建） */
const orgMemberRoleSchema = z.enum(['ORG_MEMBER', 'ORG_VIEWER'])

let defaultService: OrgService | undefined

/**
 * 取 org service：优先 ctx.services.org（测试/组装注入），
 * 否则惰性构建默认实例（真实 prisma + identity/member/audit/workspaceAdmin 服务）。
 * workspaceAdmin 与 admin.workspace 路由同构装配（credential resolver + 信封主密钥），
 * 保证两侧投影/加密/审计完全同源。
 */
function getOrgService(ctx: Context): OrgService {
  const injected = (ctx as { services?: { org?: OrgService } }).services?.org
  if (injected) return injected
  if (!defaultService) {
    const prisma = getPrismaClient()
    const audit = createAuditService(prisma)
    const masterKey = loadMasterKey()
    const credentials = createApiCredentialService(prisma)
    const resolver = createCredentialResolver({
      prisma,
      registry: createAdapterRegistry(),
      masterKey,
    })
    defaultService = createOrgService({
      prisma,
      identity: createIdentityService({
        prisma,
        sessions: createSessionService(prisma),
        audit,
        loginRateLimiter: createLoginRateLimiter(),
        members: createMemberService(prisma),
      }),
      members: createMemberService(prisma),
      audit,
      credentials,
      workspaceAdmin: createWorkspaceAdminService({
        prisma,
        credentials,
        audit,
        members: createMemberService(prisma),
        envelopeKey: masterKey,
        getSummary: (workspaceId) => resolver.getSummary(workspaceId),
      }),
    })
  }
  return defaultService
}

/** 当前客户的企业 id：orgProcedure 已保证 CUSTOMER + orgRole；
 *  organizationId 为空的脏数据在此兜底拦截（FORBIDDEN）。 */
function actorOrgId(ctx: Context): string {
  if (ctx.actor.kind === 'user') {
    const orgId = ctx.actor.user.organizationId
    if (orgId) return orgId
  }
  throw new TRPCError({ code: 'FORBIDDEN', message: '当前账号未挂靠企业，禁止访问企业控制台接口' })
}

/** 操作者 id（orgProcedure 已保证 user 会话；与 admin.workspace 路由的 actorUserId 同构） */
function actorUserId(ctx: Context): string {
  return ctx.actor.kind === 'user' ? ctx.actor.user.id : (ctx.userId ?? '')
}

/** service 层命名错误 → TRPCError 映射（与 admin.workspace 路由同构）。 */
function mapServiceError(err: unknown): never {
  if (err instanceof WorkspaceTransitionError) {
    throw new TRPCError({ code: 'CONFLICT', message: err.message })
  }
  if (err instanceof WorkspaceNotFoundError) {
    throw new TRPCError({ code: 'NOT_FOUND', message: err.message })
  }
  if (err instanceof WorkspaceConfigError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
  }
  // org 流程中 credential 存在性已前置校验，此错误实际语义为"已吊销再吊销"（状态冲突）
  if (err instanceof ApiCredentialNotRevokableError) {
    throw new TRPCError({ code: 'CONFLICT', message: err.message })
  }
  throw err
}

const workspaceIdSchema = z.string().min(1)

/**
 * org 侧创建入参：与 admin.workspace.create 同形状，但 strict 且**去掉组织二选一字段**
 * （organizationId/newOrganizationName 均物理拒绝——企业边界恒由 actor 派生）。
 */
const createWorkspaceInput = z
  .object({
    name: z.string().min(1).max(100),
    defaultBrandName: z.string().min(1).max(100),
    domain: z.string().min(1).max(255).optional(),
    llmsTxtUrl: z.string().min(1).max(500).optional(),
  })
  .strict()

/** 与 admin.workspace.update 同形状（前端 Settings 分叉只换前缀） */
const updateWorkspaceInput = z.object({
  workspaceId: workspaceIdSchema,
  name: z.string().min(1).max(100).optional(),
  domain: z.string().min(1).max(255).optional(),
  defaultBrandName: z.string().min(1).max(100).optional(),
  llmsTxtUrl: z.string().min(1).max(500).optional(),
  // 监测配置（M2 §3.1）：N 的区间在 zod 层就拒，越界给 BAD_REQUEST 而不是 500
  monitorSampleCount: z.number().int().min(1).max(10).optional(),
  monitorSchedule: z.enum(['DAILY', 'WEEKLY', 'OFF']).optional(),
})

/**
 * 企业控制台路由（挂载于 appRouter.org，orgProcedure 授权分治）：
 * - info.get / workspaces.list / workspaces.get / workspaces.getPlatformSummary /
 *   credentials.list：任意企业成员（orgProcedure()，无权限点；越权由 service 层拦截）；
 * - info.update 与 members.*：org.manage（ORG_OWNER 通配，MEMBER/VIEWER 空表恒拒）；
 * - workspaces.create/update/setCompetitors/setPlatformCredentials：workspace.manage；
 * - credentials.issue/revoke：credential.write。
 */
export const orgRouter = router({
  info: router({
    get: orgProcedure().query(async ({ ctx }) => getOrgService(ctx).infoGet(actorOrgId(ctx))),

    update: orgProcedure('org.manage')
      .input(
        z.object({
          name: z.string().min(1).max(100).optional(),
          creditCode: z.string().min(1).max(64).optional(),
          industry: z.string().min(1).max(64).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        getOrgService(ctx).infoUpdate(actorOrgId(ctx), input, ctx.userId),
      ),
  }),

  members: router({
    list: orgProcedure('org.manage').query(async ({ ctx }) =>
      getOrgService(ctx).membersList(actorOrgId(ctx)),
    ),

    create: orgProcedure('org.manage')
      .input(
        z.object({
          username: z.string().min(3).max(64).optional(),
          email: z.string().email().max(255).optional(),
          displayName: z.string().min(1).max(64),
          orgRole: orgMemberRoleSchema,
          password: z.string().min(1).max(128).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        getOrgService(ctx).membersCreate(actorOrgId(ctx), input, ctx.userId),
      ),

    setAccess: orgProcedure('org.manage')
      .input(
        z.object({
          userId: z.string().min(1),
          workspaceId: z.string().min(1),
          access: z.nativeEnum(WorkspaceAccess),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        getOrgService(ctx).membersSetAccess(actorOrgId(ctx), input, ctx.userId),
      ),

    setStatus: orgProcedure('org.manage')
      .input(z.object({ userId: z.string().min(1), status: z.nativeEnum(UserStatus) }))
      .mutation(async ({ ctx, input }) =>
        getOrgService(ctx).membersSetStatus(
          actorOrgId(ctx),
          input.userId,
          input.status,
          ctx.userId,
        ),
      ),

    resetPassword: orgProcedure('org.manage')
      .input(z.object({ userId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const password = await getOrgService(ctx).membersResetPassword(
          actorOrgId(ctx),
          input.userId,
          ctx.userId,
        )
        return { password }
      }),
  }),

  /**
   * 工作区管理（P0 workspace-admin 的 org 范围包装，前端与 admin.workspace 同名端点、
   * 同输入输出形状——Settings 分叉只换前缀）：
   * - list/get/getPlatformSummary：任意企业成员可见（orgProcedure()，越权由 service 层拦截）；
   * - create/update/setCompetitors/setPlatformCredentials：workspace.manage（ORG_OWNER 通配）。
   */
  workspaces: router({
    list: orgProcedure()
      .input(
        z
          .object({
            q: z.string().optional(),
            status: z.nativeEnum(WorkspaceStatus).optional(),
            page: z.number().int().min(1).default(1),
            pageSize: z.number().int().min(1).max(100).default(20),
          })
          .optional(),
      )
      .query(async ({ ctx, input }) => getOrgService(ctx).listWorkspaces(actorOrgId(ctx), input)),

    get: orgProcedure()
      .input(z.object({ workspaceId: workspaceIdSchema }))
      .query(async ({ ctx, input }) => {
        try {
          return await getOrgService(ctx).getWorkspace(actorOrgId(ctx), input.workspaceId)
        } catch (err) {
          mapServiceError(err)
        }
      }),

    getPlatformSummary: orgProcedure()
      .input(z.object({ workspaceId: workspaceIdSchema }))
      .query(async ({ ctx, input }) => {
        try {
          return await getOrgService(ctx).getPlatformSummary(actorOrgId(ctx), input.workspaceId)
        } catch (err) {
          mapServiceError(err)
        }
      }),

    create: orgProcedure('workspace.manage')
      .input(createWorkspaceInput)
      .mutation(async ({ ctx, input }) =>
        getOrgService(ctx).createWorkspace(actorOrgId(ctx), input, actorUserId(ctx)),
      ),

    update: orgProcedure('workspace.manage')
      .input(updateWorkspaceInput)
      .mutation(async ({ ctx, input }) => {
        const { workspaceId, ...fields } = input
        try {
          return await getOrgService(ctx).updateWorkspace(
            actorOrgId(ctx),
            workspaceId,
            fields,
            ctx.userId,
          )
        } catch (err) {
          mapServiceError(err)
        }
      }),

    setCompetitors: orgProcedure('workspace.manage')
      .input(
        z.object({
          workspaceId: workspaceIdSchema,
          competitors: z.array(z.string().min(1)),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          return await getOrgService(ctx).setCompetitors(
            actorOrgId(ctx),
            input.workspaceId,
            input.competitors,
            ctx.userId,
          )
        } catch (err) {
          mapServiceError(err)
        }
      }),

    setPlatformCredentials: orgProcedure('workspace.manage')
      .input(
        z.object({
          workspaceId: workspaceIdSchema,
          platform: z.string().min(1),
          values: z.record(z.string()),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          return await getOrgService(ctx).setPlatformCredentials(
            actorOrgId(ctx),
            input.workspaceId,
            input.platform,
            input.values,
            ctx.userId,
          )
        } catch (err) {
          mapServiceError(err)
        }
      }),
  }),

  /**
   * API 凭证管理（P0 api-credentials 的 org 范围包装；workspace 越权由 service 层拦截）：
   * - list：任意企业成员可见（orgProcedure()）；
   * - issue/revoke：credential.write（ORG_OWNER 通配，MEMBER/VIEWER 空表恒拒）；
   *   issue 返回脱敏 credential + 一次性明文 key；revoke 前 service 先校验
   *   credential 所属 workspace 属本企业（越权不触达吊销动作）。
   */
  credentials: router({
    list: orgProcedure()
      .input(z.object({ workspaceId: workspaceIdSchema }))
      .query(async ({ ctx, input }) =>
        getOrgService(ctx).listCredentials(actorOrgId(ctx), input.workspaceId),
      ),

    issue: orgProcedure('credential.write')
      .input(z.object({ workspaceId: workspaceIdSchema, name: z.string().min(1).max(100) }))
      .mutation(async ({ ctx, input }) =>
        getOrgService(ctx).issueCredential(
          actorOrgId(ctx),
          input.workspaceId,
          input.name,
          actorUserId(ctx),
        ),
      ),

    revoke: orgProcedure('credential.write')
      .input(z.object({ credentialId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await getOrgService(ctx).revokeCredential(
            actorOrgId(ctx),
            input.credentialId,
            actorUserId(ctx),
          )
        } catch (err) {
          mapServiceError(err)
        }
      }),
  }),
})
