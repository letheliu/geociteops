import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { WorkspaceStatus } from '@prisma/client'
import { router, platformProcedure } from '../../core/trpc/init.js'
import type { Context } from '../../core/trpc/init.js'
import { getPrismaClient } from '../../core/db/client.js'
import { loadMasterKey } from '../../core/crypto/envelope.js'
import { createAdapterRegistry } from '../../modules/citation-monitor/platform-adapters/registry.js'
import { createAuditService } from '../audit/service.js'
import { createApiCredentialService } from './api-credentials.js'
import { createCredentialResolver } from './credential-resolver.js'
import { createMemberService } from './member-service.js'
import {
  createWorkspaceAdminService,
  WorkspaceNotFoundError,
  WorkspaceTransitionError,
  OperatorNotEligibleError,
  OperatorAssignmentNotFoundError,
} from './workspace-admin.js'
import type { WorkspaceAdminService } from './workspace-admin.js'

let defaultService: WorkspaceAdminService | undefined

/**
 * 取 workspaceAdmin service：优先 ctx.services.workspaceAdmin（测试/组装注入），
 * 否则惰性构建默认实例（真实 prisma + credential resolver + 信封主密钥）。
 */
function getWorkspaceAdminService(ctx: Context): WorkspaceAdminService {
  const injected = (ctx as { services?: { workspaceAdmin?: WorkspaceAdminService } }).services
    ?.workspaceAdmin
  if (injected) return injected
  if (!defaultService) {
    const prisma = getPrismaClient()
    const resolver = createCredentialResolver({
      prisma,
      registry: createAdapterRegistry(),
      masterKey: loadMasterKey(),
    })
    defaultService = createWorkspaceAdminService({
      prisma,
      credentials: createApiCredentialService(prisma),
      audit: createAuditService(prisma),
      members: createMemberService(prisma),
      envelopeKey: loadMasterKey(),
      getSummary: (workspaceId) => resolver.getSummary(workspaceId),
    })
  }
  return defaultService
}

/**
 * service 层命名错误 → TRPCError 映射（非法状态迁移/工作区不存在/顾问目标不合格/
 * 顾问分配记录不存在）。其余错误原样上抛（INTERNAL_SERVER_ERROR 由 tRPC 兜底）。
 */
function mapServiceError(err: unknown): never {
  if (err instanceof WorkspaceTransitionError) {
    throw new TRPCError({ code: 'CONFLICT', message: err.message })
  }
  if (err instanceof WorkspaceNotFoundError) {
    throw new TRPCError({ code: 'NOT_FOUND', message: err.message })
  }
  if (err instanceof OperatorNotEligibleError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
  }
  if (err instanceof OperatorAssignmentNotFoundError) {
    throw new TRPCError({ code: 'NOT_FOUND', message: err.message })
  }
  throw err
}

/** platformProcedure 基于 authedProcedure：actor 必为 user 会话 */
function actorUserId(ctx: Context): string {
  return ctx.actor.kind === 'user' ? ctx.actor.user.id : (ctx.userId ?? '')
}

const workspaceIdSchema = z.string().min(1)

const createInput = z
  .object({
    name: z.string().min(1).max(100),
    defaultBrandName: z.string().min(1).max(100),
    domain: z.string().min(1).max(255).optional(),
    llmsTxtUrl: z.string().min(1).max(500).optional(),
    organizationId: z.string().min(1).optional(),
    newOrganizationName: z.string().min(1).max(100).optional(),
  })
  .refine((d) => (d.organizationId !== undefined) !== (d.newOrganizationName !== undefined), {
    message: 'organizationId 与 newOrganizationName 必须二选一（且仅提供其一）',
  })

const updateInput = z.object({
  workspaceId: workspaceIdSchema,
  name: z.string().min(1).max(100).optional(),
  domain: z.string().min(1).max(255).optional(),
  defaultBrandName: z.string().min(1).max(100).optional(),
  llmsTxtUrl: z.string().min(1).max(500).optional(),
})

/**
 * Workspace 统一管理路由（挂载于 appRouter.admin.workspace）：
 * - list/get/创建/更新/状态机/转移 → workspace.manage；
 * - 顾问分配 assign/unassignOperator → assignment.manage（仅 SUPER_ADMIN：
 *   P1 终审收紧——OPERATOR 若可调用即可自我分配进任意工作区取得业务数据读写）；
 *   listOperators 维持 workspace.manage（只读，无收紧必要）；
 * - setPlatformCredentials/setCompetitors → credential.write；
 * - enter → workspace.enter（记录 actor.user.id 审计）。
 *
 * 顾问分配（任务 6）：OPERATOR 的 workspace 授权 = WorkspaceMember 记录
 * （任务 2 的 hasAssignment 收紧），此组端点补上分配闭环。
 */
export const adminWorkspaceRouter = router({
  list: platformProcedure('workspace.manage')
    .input(
      z
        .object({
          q: z.string().optional(),
          status: z.nativeEnum(WorkspaceStatus).optional(),
          organizationId: z.string().optional(),
          page: z.number().int().min(1).default(1),
          pageSize: z.number().int().min(1).max(100).default(20),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => getWorkspaceAdminService(ctx).list(input ?? {})),

  get: platformProcedure('workspace.manage')
    .input(z.object({ workspaceId: workspaceIdSchema }))
    .query(async ({ ctx, input }) => {
      try {
        return await getWorkspaceAdminService(ctx).get(input.workspaceId)
      } catch (err) {
        mapServiceError(err)
      }
    }),

  create: platformProcedure('workspace.manage')
    .input(createInput)
    .mutation(async ({ ctx, input }) =>
      getWorkspaceAdminService(ctx).create(input, actorUserId(ctx)),
    ),

  update: platformProcedure('workspace.manage')
    .input(updateInput)
    .mutation(async ({ ctx, input }) => {
      const { workspaceId, ...fields } = input
      try {
        return await getWorkspaceAdminService(ctx).update(
          workspaceId,
          fields,
          actorUserId(ctx),
        )
      } catch (err) {
        mapServiceError(err)
      }
    }),

  suspend: platformProcedure('workspace.manage')
    .input(
      z.object({ workspaceId: workspaceIdSchema, reason: z.string().max(200).optional() }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await getWorkspaceAdminService(ctx).suspend(
          input.workspaceId,
          input.reason,
          actorUserId(ctx),
        )
      } catch (err) {
        mapServiceError(err)
      }
    }),

  resume: platformProcedure('workspace.manage')
    .input(z.object({ workspaceId: workspaceIdSchema }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await getWorkspaceAdminService(ctx).resume(input.workspaceId, actorUserId(ctx))
      } catch (err) {
        mapServiceError(err)
      }
    }),

  archive: platformProcedure('workspace.manage')
    .input(z.object({ workspaceId: workspaceIdSchema }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await getWorkspaceAdminService(ctx).archive(input.workspaceId, actorUserId(ctx))
      } catch (err) {
        mapServiceError(err)
      }
    }),

  transfer: platformProcedure('workspace.manage')
    .input(z.object({ workspaceId: workspaceIdSchema, targetOrganizationId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await getWorkspaceAdminService(ctx).transfer(
          input.workspaceId,
          input.targetOrganizationId,
          actorUserId(ctx),
        )
      } catch (err) {
        mapServiceError(err)
      }
    }),

  setPlatformCredentials: platformProcedure('credential.write')
    .input(
      z.object({
        workspaceId: workspaceIdSchema,
        platform: z.string().min(1),
        values: z.record(z.string()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await getWorkspaceAdminService(ctx).setPlatformCredentials(
          input.workspaceId,
          input.platform,
          input.values,
          actorUserId(ctx),
        )
      } catch (err) {
        mapServiceError(err)
      }
    }),

  setCompetitors: platformProcedure('credential.write')
    .input(
      z.object({
        workspaceId: workspaceIdSchema,
        competitors: z.array(z.string().min(1)),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await getWorkspaceAdminService(ctx).setCompetitors(
          input.workspaceId,
          input.competitors,
          actorUserId(ctx),
        )
      } catch (err) {
        mapServiceError(err)
      }
    }),

  enter: platformProcedure('workspace.enter')
    .input(z.object({ workspaceId: workspaceIdSchema }))
    .mutation(async ({ ctx, input }) =>
      getWorkspaceAdminService(ctx).enter(input.workspaceId, { userId: actorUserId(ctx) }),
    ),

  /** userId 接受 User.id 或用户名（service 先按 id 命中、未命中按 username 解析） */
  assignOperator: platformProcedure('assignment.manage')
    .input(
      z.object({
        workspaceId: workspaceIdSchema,
        userId: z.string().min(1),
        isPrimary: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await getWorkspaceAdminService(ctx).assignOperator(
          input.workspaceId,
          input.userId,
          { isPrimary: input.isPrimary },
          actorUserId(ctx),
        )
      } catch (err) {
        mapServiceError(err)
      }
    }),

  /** userId 与 assignOperator 同双通道契约（User.id 或用户名）；记录不存在（重删）→ NOT_FOUND */
  unassignOperator: platformProcedure('assignment.manage')
    .input(z.object({ workspaceId: workspaceIdSchema, userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await getWorkspaceAdminService(ctx).unassignOperator(
          input.workspaceId,
          input.userId,
          actorUserId(ctx),
        )
      } catch (err) {
        mapServiceError(err)
      }
    }),

  listOperators: platformProcedure('workspace.manage')
    .input(z.object({ workspaceId: workspaceIdSchema }))
    .query(async ({ ctx, input }) => {
      try {
        return await getWorkspaceAdminService(ctx).listOperators(input.workspaceId)
      } catch (err) {
        mapServiceError(err)
      }
    }),
})
