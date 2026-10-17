import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import type { PrismaClient, Session, User } from '@prisma/client'
import { createSessionService } from './session.js'

const NOW = new Date('2026-10-13T08:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function makeUser(overrides: Record<string, unknown> = {}): User {
  return {
    id: 'user-1',
    username: 'alice',
    displayName: 'Alice',
    email: null,
    phone: null,
    passwordHash: 'x',
    userType: 'PLATFORM',
    platformRole: null,
    organizationId: null,
    orgRole: null,
    status: 'ACTIVE',
    mustChangePassword: true,
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as unknown as User
}

function makeSession(overrides: Record<string, unknown> = {}): Session & { user: User } {
  return {
    id: 'sess-1',
    userId: 'user-1',
    tokenHash: 'stored-hash',
    ip: null,
    userAgent: null,
    lastSeenAt: NOW,
    expiresAt: new Date(NOW.getTime() + 7 * DAY),
    revokedAt: null,
    createdAt: NOW,
    user: makeUser(),
    ...overrides,
  } as unknown as Session & { user: User }
}

interface PrismaMock {
  session: {
    create: ReturnType<typeof vi.fn>
    findUnique: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
    deleteMany: ReturnType<typeof vi.fn>
  }
}

function makePrismaMock(): PrismaMock {
  return {
    session: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  }
}

let prisma: PrismaMock
let service: ReturnType<typeof createSessionService>

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  prisma = makePrismaMock()
  service = createSessionService(prisma as unknown as PrismaClient)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('session service', () => {
  describe('create', () => {
    it('token 为 64 位 hex；库存 sha256(token)；expiresAt = now + 7d；透传 ip/userAgent', async () => {
      const created = makeSession({ id: 'sess-new' })
      prisma.session.create.mockResolvedValue(created)

      const res = await service.create('user-1', { ip: '1.2.3.4', userAgent: 'UA/1.0' })

      expect(res.token).toMatch(/^[0-9a-f]{64}$/)
      expect(res.session).toBe(created)
      expect(prisma.session.create).toHaveBeenCalledTimes(1)

      const arg = prisma.session.create.mock.calls[0][0]
      expect(arg.data.userId).toBe('user-1')
      expect(arg.data.tokenHash).toBe(sha256Hex(res.token))
      // 库存必须是哈希而非明文 token
      expect(arg.data.tokenHash).not.toBe(res.token)
      expect(arg.data.ip).toBe('1.2.3.4')
      expect(arg.data.userAgent).toBe('UA/1.0')
      expect(arg.data.lastSeenAt).toEqual(NOW)
      expect(arg.data.expiresAt).toEqual(new Date(NOW.getTime() + 7 * DAY))
      expect(arg.data.revokedAt).toBeUndefined()
    })

    it('两次签发的 token 不同（随机源）', async () => {
      prisma.session.create.mockResolvedValue(makeSession())
      const a = await service.create('user-1')
      const b = await service.create('user-1')
      expect(a.token).not.toBe(b.token)
    })
  })

  describe('resolve', () => {
    it('有效 token → { session, user }，按 sha256(token) 查询并 include user', async () => {
      const sess = makeSession() // lastSeenAt = now，不触发节流更新
      prisma.session.findUnique.mockResolvedValue(sess)

      const res = await service.resolve('token-a')

      expect(res?.session).toBe(sess)
      expect(res?.user).toBe(sess.user)
      expect(prisma.session.findUnique).toHaveBeenCalledWith({
        where: { tokenHash: sha256Hex('token-a') },
        include: { user: true },
      })
      expect(prisma.session.update).not.toHaveBeenCalled()
    })

    it('查无此 token → null', async () => {
      prisma.session.findUnique.mockResolvedValue(null)
      expect(await service.resolve('nope')).toBeNull()
      expect(prisma.session.update).not.toHaveBeenCalled()
    })

    it('expiresAt 已过 → null（不写 revokedAt）', async () => {
      prisma.session.findUnique.mockResolvedValue(
        makeSession({ expiresAt: new Date(NOW.getTime() - MINUTE) })
      )
      expect(await service.resolve('token-a')).toBeNull()
      expect(prisma.session.update).not.toHaveBeenCalled()
    })

    it('revokedAt 非空 → null', async () => {
      prisma.session.findUnique.mockResolvedValue(
        makeSession({ revokedAt: new Date(NOW.getTime() - MINUTE) })
      )
      expect(await service.resolve('token-a')).toBeNull()
      expect(prisma.session.update).not.toHaveBeenCalled()
    })

    it('user.status !== ACTIVE → null（不更新 lastSeenAt）', async () => {
      prisma.session.findUnique.mockResolvedValue(
        makeSession({ user: makeUser({ status: 'DISABLED' }) })
      )
      expect(await service.resolve('token-a')).toBeNull()
      expect(prisma.session.update).not.toHaveBeenCalled()
    })

    it('平台员工空闲超 8h → null 且写 revokedAt', async () => {
      prisma.session.findUnique.mockResolvedValue(
        makeSession({
          lastSeenAt: new Date(NOW.getTime() - 8 * HOUR - SECOND),
          user: makeUser({ userType: 'PLATFORM' }),
        })
      )
      expect(await service.resolve('token-a')).toBeNull()
      expect(prisma.session.update).toHaveBeenCalledWith({
        where: { id: 'sess-1' },
        data: { revokedAt: NOW },
      })
    })

    it('平台员工空闲 7h（默认窗口内）→ 仍有效', async () => {
      prisma.session.findUnique.mockResolvedValue(
        makeSession({
          lastSeenAt: new Date(NOW.getTime() - 7 * HOUR),
          user: makeUser({ userType: 'PLATFORM' }),
        })
      )
      const res = await service.resolve('token-a')
      expect(res?.session.id).toBe('sess-1')
    })

    it('env SESSION_IDLE_PLATFORM_HOURS 覆盖平台空闲窗口（默认窗口内也被判过期）', async () => {
      vi.stubEnv('SESSION_IDLE_PLATFORM_HOURS', '1')
      prisma.session.findUnique.mockResolvedValue(
        makeSession({
          lastSeenAt: new Date(NOW.getTime() - 2 * HOUR), // < 默认 8h，> 覆盖后的 1h
          user: makeUser({ userType: 'PLATFORM' }),
        })
      )
      expect(await service.resolve('token-a')).toBeNull()
      expect(prisma.session.update).toHaveBeenCalledWith({
        where: { id: 'sess-1' },
        data: { revokedAt: NOW },
      })
    })

    it('env 覆盖只影响平台侧：客户窗口仍为 2h', async () => {
      vi.stubEnv('SESSION_IDLE_PLATFORM_HOURS', '1')
      prisma.session.findUnique.mockResolvedValue(
        makeSession({
          lastSeenAt: new Date(NOW.getTime() - 90 * MINUTE), // 1.5h：平台 1h 窗口外，客户 2h 窗口内
          user: makeUser({ userType: 'CUSTOMER' }),
        })
      )
      const res = await service.resolve('token-a')
      expect(res?.session.id).toBe('sess-1')
    })

    it('客户空闲超 2h → null 且写 revokedAt', async () => {
      prisma.session.findUnique.mockResolvedValue(
        makeSession({
          lastSeenAt: new Date(NOW.getTime() - 2 * HOUR - SECOND),
          user: makeUser({ userType: 'CUSTOMER' }),
        })
      )
      expect(await service.resolve('token-a')).toBeNull()
      expect(prisma.session.update).toHaveBeenCalledWith({
        where: { id: 'sess-1' },
        data: { revokedAt: NOW },
      })
    })

    it('客户空闲恰 2h（边界，未超窗）→ 仍有效', async () => {
      prisma.session.findUnique.mockResolvedValue(
        makeSession({
          lastSeenAt: new Date(NOW.getTime() - 2 * HOUR),
          user: makeUser({ userType: 'CUSTOMER' }),
        })
      )
      const res = await service.resolve('token-a')
      expect(res?.session.id).toBe('sess-1')
    })

    it('节流：lastSeenAt 距今 ≤60s 不触发 update；>60s 更新 lastSeenAt', async () => {
      // 30s：不更新
      prisma.session.findUnique.mockResolvedValue(
        makeSession({ lastSeenAt: new Date(NOW.getTime() - 30 * SECOND) })
      )
      await service.resolve('token-a')
      expect(prisma.session.update).not.toHaveBeenCalled()

      // 恰 60s（阈值含端点）：仍不更新
      prisma.session.findUnique.mockResolvedValue(
        makeSession({ lastSeenAt: new Date(NOW.getTime() - 60 * SECOND) })
      )
      await service.resolve('token-a')
      expect(prisma.session.update).not.toHaveBeenCalled()

      // 61s：更新 lastSeenAt，会话仍有效
      prisma.session.findUnique.mockResolvedValue(
        makeSession({ lastSeenAt: new Date(NOW.getTime() - 61 * SECOND) })
      )
      const res = await service.resolve('token-a')
      expect(prisma.session.update).toHaveBeenCalledWith({
        where: { id: 'sess-1' },
        data: { lastSeenAt: NOW },
      })
      expect(res?.session.id).toBe('sess-1')
    })
  })

  describe('rotate', () => {
    it('有效旧 token：旧 session 置 revoked、新建 session、返回新 token', async () => {
      const old = makeSession({ id: 'sess-old', lastSeenAt: NOW })
      const fresh = makeSession({ id: 'sess-new' })
      prisma.session.findUnique.mockResolvedValue(old)
      prisma.session.update.mockResolvedValue({ ...old, revokedAt: NOW })
      prisma.session.create.mockResolvedValue(fresh)

      const res = await service.rotate('old-token', { ip: '5.6.7.8' })

      expect(res?.token).toMatch(/^[0-9a-f]{64}$/)
      expect(res?.session).toBe(fresh)
      expect(prisma.session.update).toHaveBeenCalledWith({
        where: { id: 'sess-old' },
        data: { revokedAt: NOW },
      })
      expect(prisma.session.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: 'user-1', ip: '5.6.7.8' }),
        })
      )
    })

    it('无效旧 token → null，不新建 session', async () => {
      prisma.session.findUnique.mockResolvedValue(null)
      expect(await service.rotate('bad-token')).toBeNull()
      expect(prisma.session.create).not.toHaveBeenCalled()
    })
  })

  describe('revokeAllForUser', () => {
    it('updateMany 未吊销会话 → revokedAt=now，返回受影响行数', async () => {
      prisma.session.updateMany.mockResolvedValue({ count: 3 })
      expect(await service.revokeAllForUser('user-9')).toBe(3)
      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-9', revokedAt: null },
        data: { revokedAt: NOW },
      })
    })
  })

  describe('revokeByToken', () => {
    it('updateMany 按 sha256(token)+未吊销过滤 → revokedAt=now，返回受影响行数', async () => {
      prisma.session.updateMany.mockResolvedValue({ count: 1 })
      expect(await service.revokeByToken('tok-1')).toBe(1)
      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: { tokenHash: sha256Hex('tok-1'), revokedAt: null },
        data: { revokedAt: NOW },
      })
    })

    it('交叉用例：create → revokeByToken 返回 1 → resolve 该 token 为 null → 再 revoke 返回 0', async () => {
      // 内存 Map 模拟 session 表，串起 create/resolve/revokeByToken 的真实交互
      const rows = new Map<string, Session & { user: User }>()
      prisma.session.create.mockImplementation(async ({ data }) => {
        const row = makeSession({ ...data, id: `sess-${rows.size + 1}` })
        rows.set(data.tokenHash as string, row)
        return row
      })
      prisma.session.findUnique.mockImplementation(async ({ where }) =>
        rows.get(where.tokenHash) ?? null
      )
      prisma.session.updateMany.mockImplementation(async ({ where, data }) => {
        let count = 0
        for (const [hash, row] of rows) {
          if (hash === where.tokenHash && row.revokedAt === null) {
            row.revokedAt = data.revokedAt as Date
            count += 1
          }
        }
        return { count }
      })

      const { token } = await service.create('user-1')

      // 吊销前可 resolve
      expect(await service.resolve(token)).not.toBeNull()
      // 首次吊销：命中 1 行
      expect(await service.revokeByToken(token)).toBe(1)
      // 吊销后同一 token resolve → null（revokedAt 非空）
      expect(await service.resolve(token)).toBeNull()
      // 再次吊销同一 token：无未吊销行命中 → 0（幂等不重复计数）
      expect(await service.revokeByToken(token)).toBe(0)
    })

    it('未知 token → 0 行命中，返回 0（不抛错）', async () => {
      prisma.session.updateMany.mockResolvedValue({ count: 0 })
      expect(await service.revokeByToken('never-issued')).toBe(0)
    })
  })

  describe('purge', () => {
    it('deleteMany expiresAt/revokedAt 早于 now-7d 的行，返回删除行数', async () => {
      prisma.session.deleteMany.mockResolvedValue({ count: 5 })
      expect(await service.purge()).toBe(5)
      const cutoff = new Date(NOW.getTime() - 7 * DAY)
      expect(prisma.session.deleteMany).toHaveBeenCalledWith({
        where: {
          OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
        },
      })
    })
  })
})
