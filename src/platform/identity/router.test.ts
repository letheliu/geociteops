import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { User } from '@prisma/client'
import { authRouter, adminUserRouter } from './router.js'
import { clearSessionCookie, serializeSessionCookie } from './cookie.js'

const NOW = new Date('2026-10-13T08:00:00.000Z')

function makeUser(overrides: Record<string, unknown> = {}): User {
  return {
    id: 'user-1',
    username: 'alice',
    displayName: 'Alice',
    email: null,
    phone: null,
    passwordHash: 'x',
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

function makeIdentityService() {
  return {
    login: vi.fn(),
    logout: vi.fn(async () => ({ ok: true })),
    changePassword: vi.fn(),
    me: vi.fn(),
    createUser: vi.fn(),
    resetPassword: vi.fn(async () => 'TempPass12345'),
    setStatus: vi.fn(),
    listUsers: vi.fn(),
  }
}

let identity: ReturnType<typeof makeIdentityService>

function makeCtx(overrides: Record<string, unknown> = {}) {
  // 任务 9：Context 形状升级——补 actor/requestMeta mock 字段（业务断言不变）。
  // actor.user.id 跟随 userId 覆盖值（authedProcedure 会用 actor.user.id 注入 ctx.userId）。
  const userId = (overrides.userId as string) ?? 'user-1'
  return {
    services: { identity },
    actor: {
      kind: 'user',
      user: makeUser({ id: userId }),
      session: { id: 'sess-1' },
    },
    userId,
    sessionToken: 'tok-current',
    ip: '9.9.9.9',
    requestMeta: {
      ip: '9.9.9.9',
      requestId: 'req-1',
      method: 'GET',
      headers: { 'x-geo-csrf': 'test-csrf' },
    },
    res: { setHeader: vi.fn() },
    ...overrides,
  } as any
}

beforeEach(() => {
  identity = makeIdentityService()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('authRouter（createCaller）', () => {
  describe('login', () => {
    it('username 短于 3 → zod 拒绝，不触达 service', async () => {
      const caller = authRouter.createCaller(makeCtx())
      await expect(
        caller.login({ username: 'ab', password: 'whatever' }),
      ).rejects.toThrow()
      expect(identity.login).not.toHaveBeenCalled()
    })

    it('username 超过 64 → zod 拒绝', async () => {
      const caller = authRouter.createCaller(makeCtx())
      await expect(
        caller.login({ username: 'a'.repeat(65), password: 'whatever' }),
      ).rejects.toThrow()
      expect(identity.login).not.toHaveBeenCalled()
    })

    it('成功 → 透传 ctx.ip 调 service，写 __Host-geo_sid HttpOnly Cookie；响应体不含 token（终审：token 只经 Cookie 下发）', async () => {
      const ctx = makeCtx()
      const caller = authRouter.createCaller(ctx)
      identity.login.mockResolvedValue({
        token: 'tok-9',
        session: { id: 'sess-9' },
        user: makeUser({ mustChangePassword: true }),
      })

      const result = await caller.login({ username: 'alice', password: 'right-password' })

      expect(identity.login).toHaveBeenCalledWith({
        username: 'alice',
        password: 'right-password',
        ip: '9.9.9.9',
      })
      expect(ctx.res.setHeader).toHaveBeenCalledWith(
        'Set-Cookie',
        '__Host-geo_sid=tok-9; HttpOnly; Secure; SameSite=Lax; Path=/',
      )
      expect(result).not.toHaveProperty('token')
      expect(JSON.stringify(result)).not.toContain('tok-9')
      expect(result.mustChangePassword).toBe(true)
      expect(result.user).toMatchObject({ id: 'user-1', username: 'alice' })
    })

    it('service 抛 TRPCError → 原样抛给调用方', async () => {
      const caller = authRouter.createCaller(makeCtx())
      const { TRPCError } = await import('@trpc/server')
      identity.login.mockRejectedValue(
        new TRPCError({ code: 'UNAUTHORIZED', message: '用户名或密码错误' }),
      )

      await expect(
        caller.login({ username: 'alice', password: 'bad' }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: '用户名或密码错误' })
    })
  })

  describe('register / registrationEnabled（M2 §3.0 自助试用通道）', () => {
    function makeRegistrationService() {
      return {
        registerTrial: vi.fn(),
        isEnabled: vi.fn(() => true),
      }
    }

    function makeRegisterCtx(registration: ReturnType<typeof makeRegistrationService>) {
      const ctx = makeCtx()
      ctx.services.registration = registration
      return ctx
    }

    it('register 成功 → 写 HttpOnly Cookie 并返回用户与试用信息，响应体不含 token', async () => {
      const registration = makeRegistrationService()
      const ctx = makeRegisterCtx(registration)
      const caller = authRouter.createCaller(ctx)
      registration.registerTrial.mockResolvedValue({
        token: 'tok-trial',
        session: { id: 'sess-trial' },
        user: {
          id: 'user-9',
          username: 'trialuser',
          displayName: '试用用户',
          userType: 'CUSTOMER',
          organizationId: 'org-9',
          orgRole: 'ORG_OWNER',
          mustChangePassword: false,
        },
        trial: {
          organizationId: 'org-9',
          workspaceId: 'ws-9',
          subscriptionId: 'sub-9',
          planId: 'plan_trial',
          planName: '试用套餐',
          endAt: new Date('2026-10-25T06:00:00.000Z'),
        },
      })

      const result = await caller.register({
        username: 'trialuser',
        email: 'trial@example.com',
        password: 'Zx9!qwerty',
        brandName: '试用用户',
      })

      expect(registration.registerTrial).toHaveBeenCalledWith({
        username: 'trialuser',
        email: 'trial@example.com',
        password: 'Zx9!qwerty',
        brandName: '试用用户',
        ip: '9.9.9.9',
      })
      expect(ctx.res.setHeader).toHaveBeenCalledWith(
        'Set-Cookie',
        serializeSessionCookie('tok-trial'),
      )
      expect(JSON.stringify(result)).not.toContain('tok-trial')
      expect(result.mustChangePassword).toBe(false)
      expect(result.trial).toMatchObject({ organizationId: 'org-9', workspaceId: 'ws-9' })
    })

    it('register：email 可省略；username 必填（短于 3 → zod 拒绝，不触达 service）', async () => {
      const registration = makeRegistrationService()
      const caller = authRouter.createCaller(makeRegisterCtx(registration))
      await expect(caller.register({ username: 'ab', password: 'x' })).rejects.toThrow()
      expect(registration.registerTrial).not.toHaveBeenCalled()
    })

    it('register：email 格式非法 → zod 拒绝', async () => {
      const registration = makeRegistrationService()
      const caller = authRouter.createCaller(makeRegisterCtx(registration))
      await expect(
        caller.register({ username: 'trialuser', email: 'not-an-email', password: 'x' }),
      ).rejects.toThrow()
      expect(registration.registerTrial).not.toHaveBeenCalled()
    })

    it('register：缺少 csrf 头 → 写操作被守卫拒绝（publicProcedure 语义）', async () => {
      const registration = makeRegistrationService()
      const ctx = makeRegisterCtx(registration)
      ctx.requestMeta.headers = {}
      const caller = authRouter.createCaller(ctx)
      await expect(
        caller.register({ username: 'trialuser', password: 'Zx9!qwerty' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(registration.registerTrial).not.toHaveBeenCalled()
    })

    it('registrationEnabled：双开关全开 → 返回 true（public query 不需登录/csrf）', async () => {
      vi.stubEnv('REGISTRATION_ENABLED', 'on')
      vi.stubEnv('BILLING_ENFORCEMENT', 'on')
      const caller = authRouter.createCaller(makeCtx())
      await expect(caller.registrationEnabled()).resolves.toBe(true)
    })

    it('registrationEnabled：enforcement off → 返回 false（与 register 的 fail-closed 同源）', async () => {
      vi.stubEnv('REGISTRATION_ENABLED', 'on')
      vi.stubEnv('BILLING_ENFORCEMENT', 'off')
      const caller = authRouter.createCaller(makeCtx())
      await expect(caller.registrationEnabled()).resolves.toBe(false)
    })

    it('registrationEnabled：缺省（env 未设）→ 返回 false（默认关）', async () => {
      vi.stubEnv('REGISTRATION_ENABLED', '')
      vi.stubEnv('BILLING_ENFORCEMENT', '')
      const caller = authRouter.createCaller(makeCtx())
      await expect(caller.registrationEnabled()).resolves.toBe(false)
    })
  })

  describe('me', () => {
    it('把 ctx.userId 传给 service.me', async () => {
      const ctx = makeCtx({ userId: 'user-7' })
      const caller = authRouter.createCaller(ctx)
      identity.me.mockResolvedValue({
        id: 'user-7',
        username: 'alice',
        displayName: 'Alice',
        userType: 'PLATFORM',
        platformRole: 'SUPER_ADMIN',
        mustChangePassword: false,
        workspaces: { items: [], total: 0 },
      })

      const result = await caller.me()

      expect(identity.me).toHaveBeenCalledWith('user-7')
      expect(result.id).toBe('user-7')
    })
  })

  describe('changePassword', () => {
    it('透传 userId 与新旧密码；成功后用新 token 覆写 Cookie；响应体不含 token', async () => {
      const ctx = makeCtx()
      const caller = authRouter.createCaller(ctx)
      identity.changePassword.mockResolvedValue({
        token: 'tok-rotated',
        session: { id: 'sess-2' },
      })

      const result = await caller.changePassword({
        oldPassword: 'old-password',
        newPassword: 'brand-new-password',
      })

      expect(identity.changePassword).toHaveBeenCalledWith('user-1', {
        oldPassword: 'old-password',
        newPassword: 'brand-new-password',
      })
      expect(ctx.res.setHeader).toHaveBeenCalledWith(
        'Set-Cookie',
        '__Host-geo_sid=tok-rotated; HttpOnly; Secure; SameSite=Lax; Path=/',
      )
      expect(result).toEqual({ mustChangePassword: false })
      expect(result).not.toHaveProperty('token')
      expect(JSON.stringify(result)).not.toContain('tok-rotated')
    })
  })

  describe('logout', () => {
    it('用 ctx.sessionToken 调 service.logout 并清除 Cookie', async () => {
      const ctx = makeCtx()
      const caller = authRouter.createCaller(ctx)

      const result = await caller.logout()

      expect(identity.logout).toHaveBeenCalledWith('user-1', 'tok-current')
      expect(ctx.res.setHeader).toHaveBeenCalledWith('Set-Cookie', clearSessionCookie())
      expect(result).toEqual({ ok: true })
    })
  })
})

describe('adminUserRouter（createCaller）', () => {
  describe('list', () => {
    it('透传分页参数', async () => {
      const caller = adminUserRouter.createCaller(makeCtx())
      identity.listUsers.mockResolvedValue({ items: [], total: 0 })

      await caller.list({ page: 2, pageSize: 10 })

      expect(identity.listUsers).toHaveBeenCalledWith({ page: 2, pageSize: 10 })
    })

    it('无入参 → 空对象（service 走默认分页）', async () => {
      const caller = adminUserRouter.createCaller(makeCtx())
      identity.listUsers.mockResolvedValue({ items: [], total: 0 })

      await caller.list()

      expect(identity.listUsers).toHaveBeenCalledWith({})
    })
  })

  describe('create', () => {
    it('platformRole 非法值 → zod 拒绝', async () => {
      const caller = adminUserRouter.createCaller(makeCtx())

      await expect(
        caller.create({
          username: 'bob',
          displayName: 'Bob',
          platformRole: 'ROOT' as any,
        }),
      ).rejects.toThrow()
      expect(identity.createUser).not.toHaveBeenCalled()
    })

    it('透传字段并携带 actorId=ctx.userId，返回脱敏用户与一次性密码', async () => {
      const caller = adminUserRouter.createCaller(makeCtx())
      identity.createUser.mockResolvedValue({
        user: makeUser({
          id: 'user-2',
          username: 'bob',
          displayName: 'Bob',
          platformRole: 'OPERATOR',
          mustChangePassword: true,
        }),
        password: 'TempPass12345',
      })

      const result = await caller.create({
        username: 'bob',
        displayName: 'Bob',
        platformRole: 'OPERATOR',
      })

      expect(identity.createUser).toHaveBeenCalledWith({
        username: 'bob',
        displayName: 'Bob',
        platformRole: 'OPERATOR',
        actorId: 'user-1',
      })
      expect(result.password).toBe('TempPass12345')
      expect(result.user).toMatchObject({ id: 'user-2', username: 'bob', platformRole: 'OPERATOR' })
    })
  })

  describe('resetPassword', () => {
    it('透传目标 userId 与 actorId，返回一次性临时密码', async () => {
      const caller = adminUserRouter.createCaller(makeCtx())

      const result = await caller.resetPassword({ userId: 'user-2' })

      expect(identity.resetPassword).toHaveBeenCalledWith('user-2', 'user-1')
      expect(result).toEqual({ password: 'TempPass12345' })
    })
  })

  describe('setStatus', () => {
    it('status 非法值 → zod 拒绝', async () => {
      const caller = adminUserRouter.createCaller(makeCtx())

      await expect(
        caller.setStatus({ userId: 'user-2', status: 'BANNED' as any }),
      ).rejects.toThrow()
      expect(identity.setStatus).not.toHaveBeenCalled()
    })

    it('透传 userId/status 与 actorId', async () => {
      const caller = adminUserRouter.createCaller(makeCtx())
      identity.setStatus.mockResolvedValue(makeUser({ status: 'DISABLED' }))

      await caller.setStatus({ userId: 'user-2', status: 'DISABLED' })

      expect(identity.setStatus).toHaveBeenCalledWith('user-2', 'DISABLED', 'user-1')
    })
  })
})

describe('session cookie 序列化', () => {
  it('serializeSessionCookie：默认名 + HttpOnly/Secure/SameSite=Lax/Path=/', () => {
    expect(serializeSessionCookie('abc123')).toBe(
      '__Host-geo_sid=abc123; HttpOnly; Secure; SameSite=Lax; Path=/',
    )
  })

  it('GEO_COOKIE_NAME 覆盖默认名', () => {
    vi.stubEnv('GEO_COOKIE_NAME', 'geo_sid_dev')
    expect(serializeSessionCookie('t')).toBe(
      'geo_sid_dev=t; HttpOnly; Secure; SameSite=Lax; Path=/',
    )
  })

  it('clearSessionCookie：同名 + Max-Age=0', () => {
    expect(clearSessionCookie()).toBe(
      '__Host-geo_sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    )
  })
})
