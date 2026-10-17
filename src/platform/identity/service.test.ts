import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PrismaClient, User } from '@prisma/client'

vi.mock('../../core/auth/password.js', () => ({
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
  validatePasswordPolicy: vi.fn(),
  generateTempPassword: vi.fn(),
}))

import {
  hashPassword,
  verifyPassword,
  validatePasswordPolicy,
  generateTempPassword,
} from '../../core/auth/password.js'
import { createIdentityService } from './service.js'
import { createLoginRateLimiter } from './rate-limiter.js'

const NOW = new Date('2026-10-13T08:00:00.000Z')
const MINUTE = 60 * 1000

/** 统一对外文案（任务约束：不得在此之外另立说法） */
const AUTH_FAILED_MESSAGE = '用户名或密码错误'
const LOCKED_MESSAGE = '账号已锁定'
const RATE_LIMITED_MESSAGE = '登录尝试过于频繁，请稍后再试'

function makeUser(overrides: Record<string, unknown> = {}): User {
  return {
    id: 'user-1',
    username: 'alice',
    displayName: 'Alice',
    email: null,
    phone: null,
    passwordHash: 'stored-hash',
    userType: 'PLATFORM',
    platformRole: 'SUPER_ADMIN',
    organizationId: null,
    orgRole: null,
    status: 'ACTIVE',
    mustChangePassword: false,
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as unknown as User
}

function makePrisma() {
  return {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    organization: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    workspace: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    session: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  } as unknown as PrismaClient & {
    user: Record<string, ReturnType<typeof vi.fn>>
    organization: Record<string, ReturnType<typeof vi.fn>>
    workspace: Record<string, ReturnType<typeof vi.fn>>
    session: Record<string, ReturnType<typeof vi.fn>>
  }
}

function makeSessions() {
  return {
    create: vi.fn(async () => ({ token: 'tok-1', session: { id: 'sess-1' } })),
    resolve: vi.fn(),
    rotate: vi.fn(),
    revokeAllForUser: vi.fn(async () => 1),
    revokeByToken: vi.fn(async () => 1),
    purge: vi.fn(),
  }
}

function makeAudit() {
  return {
    record: vi.fn(async () => {}),
    list: vi.fn(),
  }
}

function makeRateLimiter() {
  return {
    check: vi.fn(() => true),
  }
}

function makeMembers() {
  return {
    resolveAccess: vi.fn(async () => null),
    hasAssignment: vi.fn(async () => false),
    listByUser: vi.fn(async () => []),
    resolveForUser: vi.fn(async () => [] as Array<{ workspaceId: string; access: 'MANAGE' | 'OPERATE' | 'VIEW' }>),
    listMembers: vi.fn(),
    upsert: vi.fn(),
    remove: vi.fn(),
    listOrgMembers: vi.fn(),
  }
}

let prisma: ReturnType<typeof makePrisma>
let sessions: ReturnType<typeof makeSessions>
let audit: ReturnType<typeof makeAudit>
let loginRateLimiter: ReturnType<typeof makeRateLimiter>
let members: ReturnType<typeof makeMembers>

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.clearAllMocks()

  prisma = makePrisma()
  sessions = makeSessions()
  audit = makeAudit()
  loginRateLimiter = makeRateLimiter()
  members = makeMembers()

  vi.mocked(hashPassword).mockImplementation(async (plain: string) => `hashed:${plain}`)
  vi.mocked(verifyPassword).mockResolvedValue(false)
  vi.mocked(validatePasswordPolicy).mockReturnValue({ ok: true })
  vi.mocked(generateTempPassword).mockReturnValue('TempPass12345')
})

afterEach(() => {
  vi.useRealTimers()
})

function buildService() {
  return createIdentityService({ prisma, sessions, audit, loginRateLimiter, members })
}

describe('identity service', () => {
  describe('login', () => {
    it('用户不存在 → 统一文案"用户名或密码错误"，不递增计数、不建会话、不写审计', async () => {
      prisma.user.findUnique.mockResolvedValue(null)
      const svc = buildService()

      await expect(
        svc.login({ username: 'nobody', password: 'whatever', ip: '1.2.3.4' }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: AUTH_FAILED_MESSAGE })

      expect(prisma.user.update).not.toHaveBeenCalled()
      expect(sessions.create).not.toHaveBeenCalled()
      expect(audit.record).not.toHaveBeenCalled()
    })

    it('存在用户密码错 → failedLoginCount +1（未达 5 不锁定）', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ failedLoginCount: 2 }))
      const svc = buildService()

      await expect(
        svc.login({ username: 'alice', password: 'wrong-password', ip: '1.2.3.4' }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: AUTH_FAILED_MESSAGE })

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { failedLoginCount: 3 },
      })
      expect(sessions.create).not.toHaveBeenCalled()
    })

    it('密码错且计数达 5 → 写 lockedUntil = now + 15min', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ failedLoginCount: 4 }))
      const svc = buildService()

      await expect(
        svc.login({ username: 'alice', password: 'wrong-password', ip: '1.2.3.4' }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: AUTH_FAILED_MESSAGE })

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: {
          failedLoginCount: 5,
          lockedUntil: new Date(NOW.getTime() + 15 * MINUTE),
        },
      })
    })

    it('lockedUntil 未到 → 抛"账号已锁定"，不验密码、不递增计数', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser({ lockedUntil: new Date(NOW.getTime() + 5 * MINUTE) }),
      )
      const svc = buildService()

      await expect(
        svc.login({ username: 'alice', password: 'right-password', ip: '1.2.3.4' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', message: LOCKED_MESSAGE })

      expect(verifyPassword).not.toHaveBeenCalled()
      expect(prisma.user.update).not.toHaveBeenCalled()
    })

    it('成功 → 清零计数与锁定、写 lastLoginAt、建会话（透传 ip）、审计 auth.login', async () => {
      const user = makeUser({ failedLoginCount: 2, mustChangePassword: true })
      const updated = makeUser({ failedLoginCount: 0, mustChangePassword: true })
      prisma.user.findUnique.mockResolvedValue(user)
      prisma.user.update.mockResolvedValue(updated)
      vi.mocked(verifyPassword).mockResolvedValue(true)
      const svc = buildService()

      const result = await svc.login({
        username: 'alice',
        password: 'right-password',
        ip: '1.2.3.4',
      })

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: NOW },
      })
      expect(sessions.create).toHaveBeenCalledWith('user-1', { ip: '1.2.3.4' })
      expect(audit.record).toHaveBeenCalledWith({
        actorId: 'user-1',
        actorType: 'USER',
        action: 'auth.login',
        ip: '1.2.3.4',
      })
      expect(result).toEqual({ token: 'tok-1', session: { id: 'sess-1' }, user: updated })
    })

    it('verifyPassword 抛错（畸形 hash）→ 按密码错处理并递增计数', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ failedLoginCount: 0 }))
      vi.mocked(verifyPassword).mockRejectedValue(new Error('invalid hash encoding'))
      const svc = buildService()

      await expect(
        svc.login({ username: 'alice', password: 'any-password', ip: '1.2.3.4' }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: AUTH_FAILED_MESSAGE })

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { failedLoginCount: 1 },
      })
    })

    it('IP 限流超限 → 抛限流错误，不再查库', async () => {
      loginRateLimiter.check.mockReturnValue(false)
      const svc = buildService()

      await expect(
        svc.login({ username: 'alice', password: 'right-password', ip: '1.2.3.4' }),
      ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS', message: RATE_LIMITED_MESSAGE })

      expect(loginRateLimiter.check).toHaveBeenCalledWith('1.2.3.4')
      expect(prisma.user.findUnique).not.toHaveBeenCalled()
    })

    it('账号已禁用且密码正确 → 抛"账号已禁用"，不建会话', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ status: 'DISABLED' }))
      vi.mocked(verifyPassword).mockResolvedValue(true)
      const svc = buildService()

      await expect(
        svc.login({ username: 'alice', password: 'right-password', ip: '1.2.3.4' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', message: '账号已禁用' })

      expect(sessions.create).not.toHaveBeenCalled()
    })
  })

  describe('changePassword', () => {
    it('用户不存在 → NOT_FOUND', async () => {
      prisma.user.findUnique.mockResolvedValue(null)
      const svc = buildService()

      await expect(
        svc.changePassword('user-404', { oldPassword: 'a', newPassword: 'b' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', message: '用户不存在' })
    })

    it('旧密码错 → 抛"旧密码错误"，不写库', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser())
      vi.mocked(verifyPassword).mockResolvedValue(false)
      const svc = buildService()

      await expect(
        svc.changePassword('user-1', { oldPassword: 'wrong-old', newPassword: 'new-password-1' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: '旧密码错误' })

      expect(prisma.user.update).not.toHaveBeenCalled()
      expect(hashPassword).not.toHaveBeenCalled()
    })

    it('新密码不过策略 → 抛策略原因，不哈希不写库', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser())
      vi.mocked(verifyPassword).mockResolvedValue(true)
      vi.mocked(validatePasswordPolicy).mockReturnValue({ ok: false, reason: '密码长度不足，至少 10 位' })
      const svc = buildService()

      await expect(
        svc.changePassword('user-1', { oldPassword: 'right-old', newPassword: 'short' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: '密码长度不足，至少 10 位' })

      expect(hashPassword).not.toHaveBeenCalled()
      expect(prisma.user.update).not.toHaveBeenCalled()
    })

    it('成功 → 更新哈希与 mustChangePassword=false、吊销全部会话、发新 token、审计', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ mustChangePassword: true }))
      vi.mocked(verifyPassword).mockResolvedValue(true)
      sessions.create.mockResolvedValue({ token: 'tok-2', session: { id: 'sess-2' } })
      const svc = buildService()

      const result = await svc.changePassword('user-1', {
        oldPassword: 'right-old',
        newPassword: 'brand-new-password',
      })

      expect(hashPassword).toHaveBeenCalledWith('brand-new-password')
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { passwordHash: 'hashed:brand-new-password', mustChangePassword: false },
      })
      expect(sessions.revokeAllForUser).toHaveBeenCalledWith('user-1')
      expect(sessions.create).toHaveBeenCalledWith('user-1')
      expect(audit.record).toHaveBeenCalledWith({
        actorId: 'user-1',
        actorType: 'USER',
        action: 'auth.change_password',
      })
      expect(result).toEqual({ token: 'tok-2', session: { id: 'sess-2' } })
    })
  })

  describe('me', () => {
    it('SUPER_ADMIN → 最近 20 个 workspace（createdAt desc，access 恒 MANAGE）+ count；organization null', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser())
      prisma.workspace.findMany.mockResolvedValue([{ id: 'ws-1', name: 'W1' }])
      prisma.workspace.count.mockResolvedValue(42)
      const svc = buildService()

      const result = await svc.me('user-1')

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        include: { organization: { select: { id: true, name: true } } },
      })
      expect(prisma.workspace.findMany).toHaveBeenCalledWith({
        where: {},
        take: 20,
        orderBy: { createdAt: 'desc' },
        select: { id: true, name: true },
      })
      expect(prisma.workspace.count).toHaveBeenCalledWith({ where: {} })
      expect(members.listByUser).not.toHaveBeenCalled()
      expect(members.resolveForUser).not.toHaveBeenCalled()
      expect(result).toEqual({
        id: 'user-1',
        username: 'alice',
        displayName: 'Alice',
        userType: 'PLATFORM',
        platformRole: 'SUPER_ADMIN',
        mustChangePassword: false,
        workspaces: { items: [{ id: 'ws-1', name: 'W1', access: 'MANAGE' }], total: 42 },
        organization: null,
      })
    })

    it('OPERATOR → listByUser join workspace（access 原值，保持分配顺序，孤儿跳过），total=条数', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ platformRole: 'OPERATOR' }))
      members.listByUser.mockResolvedValue([
        { workspaceId: 'ws-1', access: 'OPERATE', isPrimary: false },
        { workspaceId: 'ws-2', access: 'VIEW', isPrimary: false },
        { workspaceId: 'ws-gone', access: 'MANAGE', isPrimary: false },
      ])
      // ws-gone 的 workspace 已物理删除（WorkspaceMember 无 FK，孤儿记录）
      prisma.workspace.findMany.mockResolvedValue([
        { id: 'ws-2', name: 'W2' },
        { id: 'ws-1', name: 'W1' },
      ])
      const svc = buildService()

      const result = await svc.me('user-1')

      expect(members.listByUser).toHaveBeenCalledWith('user-1')
      expect(prisma.workspace.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['ws-1', 'ws-2', 'ws-gone'] } },
        select: { id: true, name: true },
      })
      expect(result.workspaces).toEqual({
        items: [
          { id: 'ws-1', name: 'W1', access: 'OPERATE' },
          { id: 'ws-2', name: 'W2', access: 'VIEW' },
        ],
        total: 2,
      })
      expect(result.organization).toBeNull()
    })

    it('OPERATOR 无分配 → items 空，不查 workspace', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ platformRole: 'OPERATOR' }))
      const svc = buildService()

      const result = await svc.me('user-1')

      expect(prisma.workspace.findMany).not.toHaveBeenCalled()
      expect(prisma.workspace.count).not.toHaveBeenCalled()
      expect(result.workspaces).toEqual({ items: [], total: 0 })
    })

    it('FINANCE / SUPPORT → items 空（矩阵：不使用 GEO 功能）', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ platformRole: 'FINANCE' }))
      const svc = buildService()
      const finance = await svc.me('user-1')
      expect(finance.workspaces).toEqual({ items: [], total: 0 })
      expect(prisma.workspace.findMany).not.toHaveBeenCalled()

      prisma.user.findUnique.mockResolvedValue(makeUser({ platformRole: 'SUPPORT' }))
      const support = await svc.me('user-1')
      expect(support.workspaces).toEqual({ items: [], total: 0 })
    })

    it('CUSTOMER + ORG_OWNER → 本企业全部 workspace（access 恒 MANAGE）+ count；organization/orgRole 注入', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser({
          userType: 'CUSTOMER',
          platformRole: null,
          organizationId: 'org-1',
          orgRole: 'ORG_OWNER',
          organization: { id: 'org-1', name: '企业A' },
        }),
      )
      prisma.workspace.findMany.mockResolvedValue([{ id: 'ws-1', name: 'W1' }])
      prisma.workspace.count.mockResolvedValue(1)
      const svc = buildService()

      const result = await svc.me('user-1')

      expect(prisma.workspace.findMany).toHaveBeenCalledWith({
        where: { organizationId: 'org-1' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, name: true },
      })
      expect(prisma.workspace.count).toHaveBeenCalledWith({ where: { organizationId: 'org-1' } })
      expect(members.resolveForUser).not.toHaveBeenCalled()
      expect(result.workspaces).toEqual({
        items: [{ id: 'ws-1', name: 'W1', access: 'MANAGE' }],
        total: 1,
      })
      expect(result.organization).toEqual({ id: 'org-1', name: '企业A' })
      expect(result.orgRole).toBe('ORG_OWNER')
    })

    it('CUSTOMER + ORG_MEMBER → resolveForUser 合成 + 本企业过滤：items 不含企业 B 的 workspace', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser({
          userType: 'CUSTOMER',
          platformRole: null,
          organizationId: 'org-1',
          orgRole: 'ORG_MEMBER',
          organization: { id: 'org-1', name: '企业A' },
        }),
      )
      // ws-9 属企业 B（历史/脏 member 记录）：organizationId 过滤后不入列
      members.resolveForUser.mockResolvedValue([
        { workspaceId: 'ws-1', access: 'OPERATE' },
        { workspaceId: 'ws-9', access: 'MANAGE' },
      ])
      prisma.workspace.findMany.mockResolvedValue([{ id: 'ws-1', name: 'W1' }])
      const svc = buildService()

      const result = await svc.me('user-1')

      expect(members.resolveForUser).toHaveBeenCalledWith('user-1')
      expect(prisma.workspace.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['ws-1', 'ws-9'] }, organizationId: 'org-1' },
        select: { id: true, name: true },
      })
      expect(result.workspaces.items).toEqual([{ id: 'ws-1', name: 'W1', access: 'OPERATE' }])
      expect(result.workspaces.total).toBe(1)
    })

    it('CUSTOMER + ORG_VIEWER → items 的 access 为合成降级值（VIEW）', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser({
          userType: 'CUSTOMER',
          platformRole: null,
          organizationId: 'org-1',
          orgRole: 'ORG_VIEWER',
          organization: { id: 'org-1', name: '企业A' },
        }),
      )
      // resolveForUser 已按 synthesize 降为 VIEW（合成发生在 member-service）
      members.resolveForUser.mockResolvedValue([{ workspaceId: 'ws-1', access: 'VIEW' }])
      prisma.workspace.findMany.mockResolvedValue([{ id: 'ws-1', name: 'W1' }])
      const svc = buildService()

      const result = await svc.me('user-1')

      expect(result.workspaces.items).toEqual([{ id: 'ws-1', name: 'W1', access: 'VIEW' }])
      expect(result.orgRole).toBe('ORG_VIEWER')
    })

    it('CUSTOMER 无 orgRole（或无组织）→ items 空，不查 workspace/member', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser({ userType: 'CUSTOMER', platformRole: null, organizationId: 'org-1', orgRole: null }),
      )
      const svc = buildService()

      const result = await svc.me('user-1')

      expect(prisma.workspace.findMany).not.toHaveBeenCalled()
      expect(members.resolveForUser).not.toHaveBeenCalled()
      expect(result.workspaces).toEqual({ items: [], total: 0 })
      expect(result.orgRole).toBeUndefined()
    })

    it('用户不存在 → NOT_FOUND', async () => {
      prisma.user.findUnique.mockResolvedValue(null)
      const svc = buildService()

      await expect(svc.me('user-404')).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: '用户不存在',
      })
    })
  })

  describe('createUser', () => {
    it('缺省密码 → generateTempPassword；mustChangePassword=true；审计 user.create；返回明文', async () => {
      const created = makeUser({ id: 'user-2', username: 'bob', mustChangePassword: true })
      prisma.user.create.mockResolvedValue(created)
      const svc = buildService()

      const result = await svc.createUser({
        username: 'bob',
        displayName: 'Bob',
        platformRole: 'OPERATOR',
        actorId: 'user-1',
      })

      expect(generateTempPassword).toHaveBeenCalledTimes(1)
      expect(hashPassword).toHaveBeenCalledWith('TempPass12345')
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          username: 'bob',
          displayName: 'Bob',
          userType: 'PLATFORM',
          platformRole: 'OPERATOR',
          passwordHash: 'hashed:TempPass12345',
          mustChangePassword: true,
        },
      })
      expect(audit.record).toHaveBeenCalledWith({
        actorId: 'user-1',
        actorType: 'USER',
        action: 'user.create',
        target: 'User:user-2',
        diff: { username: 'bob', platformRole: 'OPERATOR' },
      })
      expect(result).toEqual({ user: created, password: 'TempPass12345' })
    })

    it('username 重复（P2002）→ 抛"用户名已存在"', async () => {
      const conflict = new Error('Unique constraint failed') as Error & { code: string }
      conflict.code = 'P2002'
      prisma.user.create.mockRejectedValue(conflict)
      const svc = buildService()

      await expect(
        svc.createUser({
          username: 'alice',
          displayName: 'Alice 2',
          platformRole: 'OPERATOR',
          password: 'explicit-password',
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: '用户名已存在' })

      expect(audit.record).not.toHaveBeenCalled()
    })

    it('显式密码不过策略 → 抛策略原因，不建用户', async () => {
      vi.mocked(validatePasswordPolicy).mockReturnValue({ ok: false, reason: '密码不能包含用户名' })
      const svc = buildService()

      await expect(
        svc.createUser({
          username: 'alice',
          displayName: 'Alice 2',
          platformRole: 'OPERATOR',
          password: 'short',
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: '密码不能包含用户名' })

      expect(prisma.user.create).not.toHaveBeenCalled()
    })
  })

  describe('createOrgUser', () => {
    /** 企业存在性前置校验的统一桩 */
    function stubOrgExists() {
      prisma.organization.findUnique.mockResolvedValue({ id: 'org-1' })
    }

    it('username 缺省 + 有邮箱 → 取邮箱前缀（小写化、@ 后丢弃）；mustChangePassword=true；审计 user.create；返回明文一次', async () => {
      stubOrgExists()
      // 候选 zhang.san 不冲突
      prisma.user.findUnique.mockResolvedValue(null)
      const created = makeUser({
        id: 'user-9',
        username: 'zhang.san',
        userType: 'CUSTOMER',
        organizationId: 'org-1',
        orgRole: 'ORG_MEMBER',
      })
      prisma.user.create.mockResolvedValue(created)
      const svc = buildService()

      const result = await svc.createOrgUser({
        organizationId: 'org-1',
        email: 'Zhang.San@Acme.com',
        displayName: '张三',
        orgRole: 'ORG_MEMBER',
        actorId: 'user-1',
      })

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { username: 'zhang.san' },
        select: { id: true },
      })
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          username: 'zhang.san',
          displayName: '张三',
          email: 'Zhang.San@Acme.com',
          userType: 'CUSTOMER',
          organizationId: 'org-1',
          orgRole: 'ORG_MEMBER',
          passwordHash: 'hashed:TempPass12345',
          mustChangePassword: true,
        },
      })
      expect(audit.record).toHaveBeenCalledWith({
        actorId: 'user-1',
        actorType: 'USER',
        action: 'user.create',
        organizationId: 'org-1',
        target: 'User:user-9',
        diff: { username: 'zhang.san', orgRole: 'ORG_MEMBER' },
      })
      expect(result).toEqual({ user: created, password: 'TempPass12345' })
    })

    it('无邮箱 → member_ + organizationId 前 8 位', async () => {
      stubOrgExists()
      prisma.user.findUnique.mockResolvedValue(null)
      prisma.user.create.mockResolvedValue(
        makeUser({ id: 'user-9', username: 'member_cktr5h8m', userType: 'CUSTOMER', organizationId: 'org-1', orgRole: 'ORG_VIEWER' }),
      )
      const svc = buildService()

      await svc.createOrgUser({
        organizationId: 'cktr5h8mw0000abcd',
        displayName: '李四',
        orgRole: 'ORG_VIEWER',
      })

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { username: 'member_cktr5h8m' },
        select: { id: true },
      })
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          username: 'member_cktr5h8m',
          displayName: '李四',
          email: undefined,
          userType: 'CUSTOMER',
          organizationId: 'cktr5h8mw0000abcd',
          orgRole: 'ORG_VIEWER',
          passwordHash: 'hashed:TempPass12345',
          mustChangePassword: true,
        },
      })
    })

    it('邮箱前缀清洗后过短（如中文前缀）→ 回退 member_ 前缀', async () => {
      stubOrgExists()
      prisma.user.findUnique.mockResolvedValue(null)
      prisma.user.create.mockResolvedValue(makeUser({ id: 'user-9', userType: 'CUSTOMER', organizationId: 'org-1' }))
      const svc = buildService()

      await svc.createOrgUser({
        organizationId: 'org-1234567890',
        email: '张三@acme.com',
        displayName: '张三',
        orgRole: 'ORG_MEMBER',
      })

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { username: 'member_org-1234' },
        select: { id: true },
      })
    })

    it('候选冲突 → 追加序号（base 撞、base2 放行）', async () => {
      stubOrgExists()
      // 第一次查（zhang）命中存量；第二次查（zhang2）空闲
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: 'existing' })
        .mockResolvedValueOnce(null)
      prisma.user.create.mockResolvedValue(
        makeUser({ id: 'user-9', username: 'zhang2', userType: 'CUSTOMER', organizationId: 'org-1', orgRole: 'ORG_MEMBER' }),
      )
      const svc = buildService()

      const result = await svc.createOrgUser({
        organizationId: 'org-1',
        email: 'zhang@acme.com',
        displayName: '张三',
        orgRole: 'ORG_MEMBER',
      })

      expect(prisma.user.findUnique).toHaveBeenCalledTimes(2)
      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ username: 'zhang2' }),
        }),
      )
      expect(result.user.username).toBe('zhang2')
    })

    it('显式 username → 不做生成查询，原样使用', async () => {
      stubOrgExists()
      prisma.user.create.mockResolvedValue(
        makeUser({ id: 'user-9', username: 'custom-name', userType: 'CUSTOMER', organizationId: 'org-1', orgRole: 'ORG_MEMBER' }),
      )
      const svc = buildService()

      await svc.createOrgUser({
        organizationId: 'org-1',
        username: 'custom-name',
        displayName: '王五',
        orgRole: 'ORG_MEMBER',
      })

      expect(prisma.user.findUnique).not.toHaveBeenCalled()
      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ username: 'custom-name' }),
        }),
      )
    })

    it('orgRole=ORG_OWNER → service 层防御抛错（BAD_REQUEST），不查库不建号不审计', async () => {
      const svc = buildService()

      await expect(
        svc.createOrgUser({
          organizationId: 'org-1',
          displayName: '越权者',
          orgRole: 'ORG_OWNER' as any,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })

      expect(prisma.organization.findUnique).not.toHaveBeenCalled()
      expect(prisma.user.create).not.toHaveBeenCalled()
      expect(audit.record).not.toHaveBeenCalled()
    })

    it('企业不存在 → NOT_FOUND', async () => {
      prisma.organization.findUnique.mockResolvedValue(null)
      const svc = buildService()

      await expect(
        svc.createOrgUser({
          organizationId: 'org-404',
          displayName: '张三',
          orgRole: 'ORG_MEMBER',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('username 撞唯一约束（显式传入）→ 抛"用户名已存在"', async () => {
      stubOrgExists()
      const conflict = new Error('Unique constraint failed') as Error & { code: string }
      conflict.code = 'P2002'
      prisma.user.create.mockRejectedValue(conflict)
      const svc = buildService()

      await expect(
        svc.createOrgUser({
          organizationId: 'org-1',
          username: 'taken-name',
          displayName: '张三',
          orgRole: 'ORG_MEMBER',
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: '用户名已存在' })

      expect(audit.record).not.toHaveBeenCalled()
    })

    it('email 撞唯一约束 → 抛"邮箱已被使用"（按 meta.target 区分）', async () => {
      stubOrgExists()
      const conflict = new Error('Unique constraint failed') as Error & {
        code: string
        meta: { target: string[] }
      }
      conflict.code = 'P2002'
      conflict.meta = { target: ['email'] }
      prisma.user.create.mockRejectedValue(conflict)
      const svc = buildService()

      await expect(
        svc.createOrgUser({
          organizationId: 'org-1',
          email: 'taken@acme.com',
          displayName: '张三',
          orgRole: 'ORG_MEMBER',
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: '邮箱已被使用' })
    })

    it('显式密码不过策略 → 抛策略原因，不建用户', async () => {
      stubOrgExists()
      vi.mocked(validatePasswordPolicy).mockReturnValue({ ok: false, reason: '密码长度不足，至少 10 位' })
      const svc = buildService()

      await expect(
        svc.createOrgUser({
          organizationId: 'org-1',
          username: 'new-member',
          displayName: '张三',
          orgRole: 'ORG_MEMBER',
          password: 'short',
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: '密码长度不足，至少 10 位' })

      expect(prisma.user.create).not.toHaveBeenCalled()
    })
  })

  describe('resetPassword', () => {
    it('生成临时密码、mustChangePassword=true、清锁定、吊销全部会话、审计、返回明文仅此一次', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser({ failedLoginCount: 5, lockedUntil: new Date(NOW.getTime() + 10 * MINUTE) }),
      )
      const svc = buildService()

      const password = await svc.resetPassword('user-1', 'user-admin')

      expect(password).toBe('TempPass12345')
      expect(hashPassword).toHaveBeenCalledWith('TempPass12345')
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: {
          passwordHash: 'hashed:TempPass12345',
          mustChangePassword: true,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      })
      expect(sessions.revokeAllForUser).toHaveBeenCalledWith('user-1')
      expect(audit.record).toHaveBeenCalledWith({
        actorId: 'user-admin',
        actorType: 'USER',
        action: 'user.reset_password',
        target: 'User:user-1',
      })
    })

    it('用户不存在 → NOT_FOUND', async () => {
      prisma.user.findUnique.mockResolvedValue(null)
      const svc = buildService()

      await expect(svc.resetPassword('user-404')).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: '用户不存在',
      })
    })
  })

  describe('setStatus', () => {
    it('DISABLED → 更新状态并吊销全部会话、审计 user.set_status', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser())
      prisma.user.update.mockResolvedValue(makeUser({ status: 'DISABLED' }))
      const svc = buildService()

      const user = await svc.setStatus('user-1', 'DISABLED', 'user-admin')

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { status: 'DISABLED' },
      })
      expect(sessions.revokeAllForUser).toHaveBeenCalledWith('user-1')
      expect(audit.record).toHaveBeenCalledWith({
        actorId: 'user-admin',
        actorType: 'USER',
        action: 'user.set_status',
        target: 'User:user-1',
        diff: { status: 'DISABLED' },
      })
      expect(user.status).toBe('DISABLED')
    })

    it('ACTIVE → 不吊销会话', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ status: 'DISABLED' }))
      prisma.user.update.mockResolvedValue(makeUser({ status: 'ACTIVE' }))
      const svc = buildService()

      await svc.setStatus('user-1', 'ACTIVE')

      expect(sessions.revokeAllForUser).not.toHaveBeenCalled()
    })

    it('用户不存在 → NOT_FOUND', async () => {
      prisma.user.findUnique.mockResolvedValue(null)
      const svc = buildService()

      await expect(svc.setStatus('user-404', 'DISABLED')).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: '用户不存在',
      })
    })
  })

  describe('logout', () => {
    it('经 sessions.revokeByToken 吊销当前会话（不直写 prisma.session）并审计 auth.logout', async () => {
      sessions.revokeByToken.mockResolvedValueOnce(1)
      const svc = buildService()

      const result = await svc.logout('user-1', 'tok-1')

      expect(sessions.revokeByToken).toHaveBeenCalledWith('tok-1')
      expect(prisma.session.updateMany).not.toHaveBeenCalled()
      expect(audit.record).toHaveBeenCalledWith({
        actorId: 'user-1',
        actorType: 'USER',
        action: 'auth.logout',
        diff: { revokedSessions: 1 },
      })
      expect(result).toEqual({ ok: true })
    })

    it('revokeByToken 返回 0（token 已失效/不存在）→ 幂等登出成功，审计记录真实计数', async () => {
      sessions.revokeByToken.mockResolvedValueOnce(0)
      const svc = buildService()

      const result = await svc.logout('user-1', 'tok-gone')

      expect(result).toEqual({ ok: true })
      expect(audit.record).toHaveBeenCalledWith({
        actorId: 'user-1',
        actorType: 'USER',
        action: 'auth.logout',
        diff: { revokedSessions: 0 },
      })
    })
  })

  describe('listUsers', () => {
    it('默认 page=1 / pageSize=20，只列 PLATFORM 用户', async () => {
      const item = makeUser({ id: 'user-2', username: 'bob' })
      prisma.user.findMany.mockResolvedValue([item])
      prisma.user.count.mockResolvedValue(1)
      const svc = buildService()

      const result = await svc.listUsers({})

      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { userType: 'PLATFORM' },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 20,
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
      })
      expect(prisma.user.count).toHaveBeenCalledWith({ where: { userType: 'PLATFORM' } })
      expect(result).toEqual({ items: [item], total: 1 })
    })

    it('分页 page=2 / pageSize=10 → skip 10', async () => {
      prisma.user.findMany.mockResolvedValue([])
      prisma.user.count.mockResolvedValue(15)
      const svc = buildService()

      await svc.listUsers({ page: 2, pageSize: 10 })

      const arg = prisma.user.findMany.mock.calls[0][0]
      expect(arg.skip).toBe(10)
      expect(arg.take).toBe(10)
    })
  })
})

describe('login rate limiter', () => {
  it('窗口内超限返回 false，被拒尝试不占用窗口', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const limiter = createLoginRateLimiter({ limit: 2, windowMs: MINUTE })

    expect(limiter.check('1.1.1.1')).toBe(true)
    expect(limiter.check('1.1.1.1')).toBe(true)
    expect(limiter.check('1.1.1.1')).toBe(false)

    vi.advanceTimersByTime(30_000)
    expect(limiter.check('1.1.1.1')).toBe(false) // 被拒尝试不延长窗口

    vi.useRealTimers()
  })

  it('滑动窗口：超过 windowMs 后旧尝试过期，重新放行', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const limiter = createLoginRateLimiter({ limit: 2, windowMs: MINUTE })

    expect(limiter.check('1.1.1.1')).toBe(true)
    expect(limiter.check('1.1.1.1')).toBe(true)
    expect(limiter.check('1.1.1.1')).toBe(false)

    vi.advanceTimersByTime(MINUTE + 1)
    expect(limiter.check('1.1.1.1')).toBe(true)

    vi.useRealTimers()
  })

  it('不同 IP 互不影响', async () => {
    const limiter = createLoginRateLimiter({ limit: 1, windowMs: MINUTE })

    expect(limiter.check('1.1.1.1')).toBe(true)
    expect(limiter.check('1.1.1.1')).toBe(false)
    expect(limiter.check('2.2.2.2')).toBe(true)
  })

  it('默认参数：10 次/分钟', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const limiter = createLoginRateLimiter()

    for (let i = 0; i < 10; i++) {
      expect(limiter.check('1.1.1.1')).toBe(true)
    }
    expect(limiter.check('1.1.1.1')).toBe(false)

    vi.useRealTimers()
  })
})
