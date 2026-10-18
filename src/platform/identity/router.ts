import { z } from 'zod'
import { PlatformRole, UserStatus } from '@prisma/client'
import {
  router,
  publicProcedure,
  authedProcedure,
  platformProcedure,
} from '../../core/trpc/init.js'
import type { Context } from '../../core/trpc/init.js'
import { getPrismaClient } from '../../core/db/client.js'
import { createSessionService } from '../../core/auth/session.js'
import { createAuditService } from '../audit/service.js'
import { loadMasterKey } from '../../core/crypto/envelope.js'
import { createIdentityService } from './service.js'
import type { IdentityService } from './service.js'
import { createLoginRateLimiter } from './rate-limiter.js'
import { createMemberService } from '../tenancy/member-service.js'
import { clearSessionCookie, serializeSessionCookie } from './cookie.js'
import { usernameSchema } from './username-schema.js'
import { createRegistrationService, registrationEnabled } from './registration-service.js'
import type { RegistrationService } from './registration-service.js'

let defaultService: IdentityService | undefined
let defaultRegistrationService: RegistrationService | undefined

/**
 * 取 identity service：优先 ctx.services.identity（测试/组装注入），
 * 否则惰性构建默认实例（真实 prisma + 会话/审计/限流服务）。
 */
function getIdentityService(ctx: Context): IdentityService {
  const injected = (ctx as { services?: { identity?: IdentityService } }).services?.identity
  if (injected) return injected
  if (!defaultService) {
    const prisma = getPrismaClient()
    defaultService = createIdentityService({
      prisma,
      sessions: createSessionService(prisma),
      audit: createAuditService(prisma),
      loginRateLimiter: createLoginRateLimiter(),
      members: createMemberService(prisma),
    })
  }
  return defaultService
}

/**
 * 取注册 service：优先 ctx.services.registration（server.ts 装配/测试注入），
 * 否则惰性构建默认实例。默认实例的 entitlement recompute 与信封主密钥都在装配处
 * 解析（无主密钥的部署本就起不来），因此惰性路径仅作兜底。
 */
function getRegistrationService(ctx: Context): RegistrationService {
  const injected = (ctx as { services?: { registration?: RegistrationService } }).services?.registration
  if (injected) return injected
  if (!defaultRegistrationService) {
    const prisma = getPrismaClient()
    defaultRegistrationService = createRegistrationService({
      prisma,
      sessions: createSessionService(prisma),
      audit: createAuditService(prisma),
      entitlements: { recompute: async () => ({}) },
      envelopeKey: loadMasterKey(),
    })
  }
  return defaultRegistrationService
}

/**
 * 认证路由（挂载于 appRouter.auth）。
 * 审计在 service 内完成，router 不重复记录。
 */
export const authRouter = router({
  login: publicProcedure
    .input(
      z.object({
        username: usernameSchema,
        password: z.string().min(1).max(128),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { token, user } = await getIdentityService(ctx).login({
        username: input.username,
        password: input.password,
        ip: ctx.requestMeta?.ip,
      })
      // 会话 token 只经 HttpOnly Cookie 下发，响应体不回传（防 XSS 读取，前端仅依赖 Cookie）
      ctx.res?.setHeader?.('Set-Cookie', serializeSessionCookie(token))
      return {
        mustChangePassword: user.mustChangePassword,
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          userType: user.userType,
          platformRole: user.platformRole,
        },
      }
    }),

  /**
   * 自助注册开关（public query）：登录页据此显隐"注册试用"入口，/register 也据此
   * 显示关闭文案。判定含双开关联动（REGISTRATION_ENABLED × BILLING_ENFORCEMENT）。
   */
  registrationEnabled: publicProcedure.query(async () => registrationEnabled()),

  /**
   * 自助注册（publicProcedure 已挂 csrfGuard）：访客注册即得 7 天试用租户。
   * 双开关任一关闭 → FORBIDDEN + 关闭文案（fail-closed，不建任何记录）。
   */
  register: publicProcedure
    .input(
      z.object({
        username: usernameSchema,
        /** 可选，仅联系方式（不做验证码验证，见规格 §2 非目标） */
        email: z.string().email().max(128).optional(),
        password: z.string().min(1).max(128),
        brandName: z.string().min(1).max(64).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await getRegistrationService(ctx).registerTrial({
        ...input,
        ip: ctx.requestMeta?.ip,
      })
      // 同 login：会话 token 只经 HttpOnly Cookie 下发，响应体不回传
      ctx.res?.setHeader?.('Set-Cookie', serializeSessionCookie(result.token))
      return {
        mustChangePassword: result.user.mustChangePassword,
        user: {
          id: result.user.id,
          username: result.user.username,
          displayName: result.user.displayName,
          userType: result.user.userType,
          platformRole: null,
        },
        trial: {
          organizationId: result.trial.organizationId,
          workspaceId: result.trial.workspaceId,
          planName: result.trial.planName,
          endAt: result.trial.endAt,
        },
      }
    }),

  me: authedProcedure.query(async ({ ctx }) => {
    return getIdentityService(ctx).me(ctx.userId)
  }),

  logout: authedProcedure
    .input(z.object({ token: z.string().optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      // 会话通道登录时 ctx.sessionToken 由 createContext 注入；input.token 仅为直连调用方兜底
      const token = ctx.sessionToken ?? input?.token ?? ''
      ctx.res?.setHeader?.('Set-Cookie', clearSessionCookie())
      return getIdentityService(ctx).logout(ctx.userId, token)
    }),

  changePassword: authedProcedure
    .input(
      z.object({
        oldPassword: z.string().min(1).max(128),
        newPassword: z.string().min(1).max(128),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { token } = await getIdentityService(ctx).changePassword(ctx.userId, input)
      // 改密成功后旧会话全部吊销，用新 token 覆写 HttpOnly Cookie；响应体不回传 token
      ctx.res?.setHeader?.('Set-Cookie', serializeSessionCookie(token))
      return { mustChangePassword: false }
    }),
})

/**
 * 员工账号管理路由（platformProcedure('user.manage')，已挂载进 appRouter.admin.user）。
 * service 层不校权，权限由 procedure 中间件管。
 */
export const adminUserRouter = router({
  list: platformProcedure('user.manage')
    .input(
      z
        .object({
          page: z.number().int().min(1).optional(),
          pageSize: z.number().int().min(1).max(100).optional(),
          /** 平台按企业查客户账号的救援通道（P1 遗留 2b）：传入则列该企业 CUSTOMER 用户 */
          organizationId: z.string().min(1).optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => getIdentityService(ctx).listUsers(input ?? {})),

  create: platformProcedure('user.manage')
    .input(
      z.object({
        username: usernameSchema,
        displayName: z.string().min(1).max(64),
        platformRole: z.nativeEnum(PlatformRole),
        password: z.string().min(1).max(128).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { user, password } = await getIdentityService(ctx).createUser({
        ...input,
        actorId: ctx.userId,
      })
      return {
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          platformRole: user.platformRole,
          status: user.status,
          mustChangePassword: user.mustChangePassword,
        },
        password,
      }
    }),

  resetPassword: platformProcedure('user.manage')
    .input(z.object({ userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const password = await getIdentityService(ctx).resetPassword(input.userId, ctx.userId)
      return { password }
    }),

  setStatus: platformProcedure('user.manage')
    .input(z.object({ userId: z.string().min(1), status: z.nativeEnum(UserStatus) }))
    .mutation(async ({ ctx, input }) => {
      const user = await getIdentityService(ctx).setStatus(input.userId, input.status, ctx.userId)
      return { id: user.id, status: user.status }
    }),
})
