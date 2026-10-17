import fastifyCookie from '@fastify/cookie'

// @fastify/cookie 运行时导出 parse（即 fastify 实例上 parseCookie 装饰的底层实现），
// 但其自带的 types/plugin.d.ts 未声明该成员，这里做受控类型收窄。
const parseCookie = (fastifyCookie as unknown as {
  parse: (header: string) => Record<string, string>
}).parse
import type { PrismaClient, User, Workspace, WorkspaceAccess } from '@prisma/client'
import type { Context } from './init.js'
import type { SessionService } from '../auth/session.js'
import type { WorkspaceService } from '../workspace/service.js'
import type { ApiCredentialService } from '../../platform/tenancy/api-credentials.js'
import type { MemberService } from '../../platform/tenancy/member-service.js'
import { createSessionService } from '../auth/session.js'
import { createWorkspaceService } from '../workspace/service.js'
import { createApiCredentialService } from '../../platform/tenancy/api-credentials.js'
import { createMemberService } from '../../platform/tenancy/member-service.js'
import { getPrismaClient } from '../db/client.js'

/**
 * 鉴权失败原因诊断，供 protectedProcedure 给出可定位的错误信息。
 * - missing_header: 请求既无会话 Cookie 也无 x-api-key（多为前端未注入）
 * - key_not_found: 携带了 x-api-key 但未命中有效凭证（多为库被 db push 重置 / 环境切换 / key 拼错或吊销）
 */
export type AuthDiag = 'missing_header' | 'key_not_found'

/** createContext 依赖的服务集合（测试/组装注入用） */
export interface ContextDeps {
  prisma: PrismaClient
  sessions: SessionService
  workspaceService: WorkspaceService
  apiCredentials: ApiCredentialService
  members: MemberService
}

export interface CreateContextOptions {
  req: {
    headers: Record<string, string | string[] | undefined>
    /** fastify 请求对象额外可用字段（原始 Node req 无 ip/id） */
    socket?: { remoteAddress?: string | null }
    method?: string
    id?: unknown
    ip?: string
  }
  res?: unknown
}

/** Cookie 名：生产 __Host- 前缀（仅 HTTPS），本地开发可用 GEO_COOKIE_NAME 覆盖 */
const DEFAULT_COOKIE_NAME = '__Host-geo_sid'

function sessionCookieName(): string {
  return process.env.GEO_COOKIE_NAME || DEFAULT_COOKIE_NAME
}

/** 取单值 header（数组取首项），无则 undefined */
function headerValue(raw: string | string[] | undefined): string | undefined {
  if (Array.isArray(raw)) return raw[0]
  return raw
}

/** headers 小写化快照（键值均 string | undefined） */
function snapshotHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(headers)) {
    const v = headerValue(value)
    if (v !== undefined) result[key.toLowerCase()] = v
  }
  return result
}

function extractIp(
  req: CreateContextOptions['req'],
  headers: Record<string, string | undefined>,
): string {
  const forwarded = headers['x-forwarded-for']
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  // fastify req 自带 ip（已解析 proxy 头）；裸 Node req 回退 socket.remoteAddress
  if (typeof req.ip === 'string' && req.ip) return req.ip
  return req.socket?.remoteAddress ?? ''
}

/**
 * 人 + x-workspace-id 的授权分治（P1 矩阵逐字）：
 *
 * | actor                    | 行为                                                        |
 * |--------------------------|-------------------------------------------------------------|
 * | SUPER_ADMIN              | workspace = getById（找不到留空，procedure 报 UNAUTHORIZED）|
 * | OPERATOR                 | getById 且存在分配记录（members.hasAssignment）             |
 * | FINANCE / SUPPORT        | 不使用 GEO 功能，workspace 留空                              |
 * | CUSTOMER + ORG_OWNER     | getById 且 ws.organizationId === user.organizationId        |
 * | CUSTOMER + MEMBER/VIEWER | 同上且 members.resolveAccess 非 null（跨企业由其内部拒）    |
 * | CUSTOMER 无 orgRole      | workspace 留空                                              |
 *
 * resolveAccess 调用不传 orgRole（传入即覆盖库值有陈旧风险，不传保新鲜）；
 * OPERATOR 不走 resolveAccess（PLATFORM 用户恒 null），用 hasAssignment 判分配存在。
 *
 * 除 workspace 本体外还产出**请求级访问级**（ctx.workspaceAccess，§2.2 权限合成的
 * 请求时快照）：SUPER_ADMIN/ORG_OWNER 恒 MANAGE；OPERATOR 分配记录 access 恒
 * OPERATE（assignOperator 固定写 OPERATE，平台侧无降级语义）；客户 MEMBER/VIEWER
 * 为 synthesize 合成值（VIEWER 上限只读、成员降级实时生效）。protectedProcedure
 * 据此对 VIEW 拒写——授权降级/移除不缓存进会话，下一请求即生效。
 */
interface ResolvedWorkspace {
  workspace: Workspace
  access: WorkspaceAccess
}

async function resolveUserWorkspace(
  user: User,
  workspaceId: string,
  deps: ContextDeps,
): Promise<ResolvedWorkspace | undefined> {
  if (user.userType === 'PLATFORM') {
    if (user.platformRole === 'SUPER_ADMIN') {
      const workspace = await deps.workspaceService.getById(workspaceId)
      return workspace ? { workspace, access: 'MANAGE' } : undefined
    }
    if (user.platformRole === 'OPERATOR') {
      const workspace = await deps.workspaceService.getById(workspaceId)
      if (!workspace) return undefined
      return (await deps.members.hasAssignment(user.id, workspace.id))
        ? { workspace, access: 'OPERATE' }
        : undefined
    }
    // FINANCE / SUPPORT：不使用 GEO 功能，workspace 留空
    return undefined
  }

  // CUSTOMER 无 orgRole：无客户权限，workspace 留空
  if (user.orgRole !== 'ORG_OWNER' && user.orgRole !== 'ORG_MEMBER' && user.orgRole !== 'ORG_VIEWER') {
    return undefined
  }
  const workspace = await deps.workspaceService.getById(workspaceId)
  if (!workspace) return undefined
  if (workspace.organizationId !== user.organizationId) return undefined
  if (user.orgRole === 'ORG_OWNER') return { workspace, access: 'MANAGE' }
  // MEMBER/VIEWER：最终权限合成（synthesize）非 null 才放行；不传 orgRole，保库值新鲜
  const access = await deps.members.resolveAccess(user.id, workspace)
  return access !== null ? { workspace, access } : undefined
}

/**
 * 请求级上下文工厂（双通道鉴权）：
 *
 * 1. 会话 Cookie（默认 __Host-geo_sid）：sessions.resolve(token) 命中 →
 *    actor = { kind: 'user', user, session }，并缓存明文 token（ctx.sessionToken）；
 * 2. 无有效会话而有 x-api-key：apiCredentials.findByKey 命中（未吊销未过期）→
 *    actor = { kind: 'apiKey', credential }，workspace = 凭证绑定工作区（status 任意，判定交 procedure）；
 * 3. 均无 → anonymous。
 *
 * 人 + x-workspace-id 头：按 P1 授权分治矩阵解析（resolveUserWorkspace），
 * 无权/找不到均 workspace 留空，由 procedure 报 UNAUTHORIZED；解析成功时
 * ctx.workspaceAccess 携带请求级访问级（VIEW → 业务写被拒，§2.2 合成规则）。
 */
export async function createContextWithServices(
  opts: CreateContextOptions,
  deps: ContextDeps,
): Promise<Context> {
  const headers = snapshotHeaders(opts.req.headers)
  const requestMeta = {
    ip: extractIp(opts.req, headers),
    userAgent: headers['user-agent'],
    requestId: String(opts.req.id ?? ''),
    method: opts.req.method,
    headers,
  }

  const ctx: Context = {
    actor: { kind: 'anonymous' },
    res: opts.res,
    requestMeta,
  }

  // 通道 1：会话 Cookie
  const cookieHeader = headers['cookie']
  const token =
    typeof cookieHeader === 'string' ? parseCookie(cookieHeader)[sessionCookieName()] : undefined
  if (token) {
    const resolved = await deps.sessions.resolve(token)
    if (resolved) {
      ctx.actor = { kind: 'user', user: resolved.user, session: resolved.session }
      ctx.sessionToken = token
    }
  }

  // 通道 2：x-api-key（会话通道未命中才尝试）
  const apiKey = headerValue(headers['x-api-key'])
  if (ctx.actor.kind === 'anonymous') {
    if (apiKey) {
      const hit = await deps.apiCredentials.findByKey(apiKey)
      if (hit) {
        ctx.actor = { kind: 'apiKey', credential: hit.credential }
        ctx.workspace = hit.workspace
      } else {
        ctx.authDiag = 'key_not_found'
      }
    } else if (!token) {
      // 会话头与 api key 均未携带
      ctx.authDiag = 'missing_header'
    }
  }

  // 人 + x-workspace-id：P1 授权分治矩阵（resolveUserWorkspace）
  if (ctx.actor.kind === 'user') {
    const workspaceId = headerValue(headers['x-workspace-id'])
    if (workspaceId) {
      const resolved = await resolveUserWorkspace(ctx.actor.user, workspaceId, deps)
      ctx.workspace = resolved?.workspace
      ctx.workspaceAccess = resolved?.access
    }
  }

  return ctx
}

/** 全局依赖（惰性单例：createContext 由 server.ts 的 tRPC 插件按请求调用，无法逐请求注入） */
let globalDeps: ContextDeps | undefined

function getGlobalDeps(): ContextDeps {
  if (!globalDeps) {
    const prisma = getPrismaClient()
    globalDeps = {
      prisma,
      sessions: createSessionService(prisma),
      workspaceService: createWorkspaceService(prisma),
      apiCredentials: createApiCredentialService(prisma),
      members: createMemberService(prisma),
    }
  }
  return globalDeps
}

/**
 * 薄 createContext：全局装配依赖（server.ts 不改动的过渡形态；
 * services 仍由 server.ts 以 `{ ...ctx, services }` 合并传入，
 * 插件注册（@fastify/cookie 等）归任务 12）。
 */
export async function createContext(opts: CreateContextOptions): Promise<Context> {
  return createContextWithServices(opts, getGlobalDeps())
}
