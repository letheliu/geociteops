import { createHash, randomBytes } from 'node:crypto'
import type { PrismaClient, Session, User } from '@prisma/client'

/** token 随机字节数：32 字节 hex（256-bit） */
const TOKEN_BYTES = 32

/** 会话绝对有效期：7 天（expiresAt = createdAt + 7d） */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 客户用户空闲过期窗口：2 小时 */
const CUSTOMER_IDLE_HOURS = 2

/** 平台员工空闲过期窗口默认值：8 小时（env SESSION_IDLE_PLATFORM_HOURS 可覆盖） */
const DEFAULT_PLATFORM_IDLE_HOURS = 8

/** lastSeenAt 更新节流阈值：距上次可见 ≤60s 不触发 update */
const LAST_SEEN_THROTTLE_MS = 60 * 1000

/** 吊销/过期行保留期：purge 只清理早于该时长的行 */
const PURGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export interface SessionContext {
  ip?: string
  userAgent?: string
}

/** 带 user 的会话（resolve 的返回形态） */
export type SessionWithUser = Session & { user: User }

export interface SessionService {
  create(userId: string, context?: SessionContext): Promise<{ token: string; session: Session }>
  resolve(token: string): Promise<{ session: SessionWithUser; user: User } | null>
  rotate(
    oldToken: string,
    context?: SessionContext
  ): Promise<{ token: string; session: Session } | null>
  revokeAllForUser(userId: string): Promise<number>
  /** 按明文 token 吊销单个会话（内部负责 hash），返回实际吊销行数（0 = 无未吊销会话命中） */
  revokeByToken(token: string): Promise<number>
  purge(): Promise<number>
}

function sha256Hex(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * 平台员工空闲窗口（小时）：读 env SESSION_IDLE_PLATFORM_HOURS，
 * 每次调用时读取（非模块加载时），非法/缺失值回落默认 8。
 */
function platformIdleHours(): number {
  const raw = process.env.SESSION_IDLE_PLATFORM_HOURS
  if (!raw) return DEFAULT_PLATFORM_IDLE_HOURS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PLATFORM_IDLE_HOURS
}

function idleWindowMs(user: Pick<User, 'userType'>): number {
  const hours = user.userType === 'PLATFORM' ? platformIdleHours() : CUSTOMER_IDLE_HOURS
  return hours * 60 * 60 * 1000
}

/**
 * 服务端会话服务（工厂注入 prisma，风格同 createWorkspaceService）。
 *
 * - token 为 32 字节随机数的 hex，库内只存 sha256(token)；
 * - 绝对过期 7 天（expiresAt）；空闲过期按 user.userType 分窗口：
 *   客户 2h / 平台员工 8h（env SESSION_IDLE_PLATFORM_HOURS 可覆盖平台侧）；
 * - resolve 判空闲超窗时同步落 revokedAt，供审计与 purge 清理；
 * - lastSeenAt 更新按 60s 节流，避免高频写库。
 */
export function createSessionService(prisma: PrismaClient): SessionService {
  async function create(
    userId: string,
    context: SessionContext = {}
  ): Promise<{ token: string; session: Session }> {
    const token = randomBytes(TOKEN_BYTES).toString('hex')
    const now = new Date()
    const session = await prisma.session.create({
      data: {
        userId,
        tokenHash: sha256Hex(token),
        ip: context.ip,
        userAgent: context.userAgent,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      },
    })
    return { token, session }
  }

  async function resolve(token: string): Promise<{ session: SessionWithUser; user: User } | null> {
    const session = await prisma.session.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { user: true },
    })
    if (!session) return null

    const now = Date.now()
    if (session.revokedAt !== null) return null
    if (session.expiresAt.getTime() <= now) return null
    if (session.user.status !== 'ACTIVE') return null

    const idleMs = now - session.lastSeenAt.getTime()
    if (idleMs > idleWindowMs(session.user)) {
      // 空闲超窗：视为过期，写 revokedAt（幂等安全：上行已排除 revokedAt 非空）
      await prisma.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date(now) },
      })
      return null
    }

    if (idleMs > LAST_SEEN_THROTTLE_MS) {
      const lastSeenAt = new Date(now)
      await prisma.session.update({
        where: { id: session.id },
        data: { lastSeenAt },
      })
      return { session: { ...session, lastSeenAt }, user: session.user }
    }
    return { session, user: session.user }
  }

  async function rotate(
    oldToken: string,
    context?: SessionContext
  ): Promise<{ token: string; session: Session } | null> {
    const resolved = await resolve(oldToken)
    if (!resolved) return null
    await prisma.session.update({
      where: { id: resolved.session.id },
      data: { revokedAt: new Date() },
    })
    return create(resolved.session.userId, context)
  }

  async function revokeAllForUser(userId: string): Promise<number> {
    const result = await prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    return result.count
  }

  async function revokeByToken(token: string): Promise<number> {
    // token→hash 的存储细节收敛在本服务内（调用方不感知 tokenHash）；
    // where 带 revokedAt: null：幂等重入不重复计数，返回真实吊销行数
    const result = await prisma.session.updateMany({
      where: { tokenHash: sha256Hex(token), revokedAt: null },
      data: { revokedAt: new Date() },
    })
    return result.count
  }

  async function purge(): Promise<number> {
    const cutoff = new Date(Date.now() - PURGE_RETENTION_MS)
    const result = await prisma.session.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
      },
    })
    return result.count
  }

  return { create, resolve, rotate, revokeAllForUser, revokeByToken, purge }
}
