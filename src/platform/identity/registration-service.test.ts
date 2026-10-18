import { describe, expect, it } from 'vitest'
import { decryptConfig, isEncryptedConfig } from '../../core/crypto/envelope.js'
import {
  REGISTRATION_CLOSED_MESSAGE,
  REGISTRATION_EMAIL_TAKEN_MESSAGE,
  REGISTRATION_GLOBAL_LIMIT,
  REGISTRATION_IP_LIMIT,
  REGISTRATION_IP_WINDOW_MS,
  REGISTRATION_GLOBAL_WINDOW_MS,
  REGISTRATION_RATE_LIMITED_MESSAGE,
  REGISTRATION_USERNAME_TAKEN_MESSAGE,
  createRegistrationRateLimiter,
  createRegistrationService,
  registrationEnabled,
  type RegistrationRateLimiter,
} from './registration-service.js'

// ---------------------------------------------------------------------------
// 注册限速（规格 §4）：每 IP 3 次/小时 + 全局 50 次/24h 双滑窗。
// 阈值常量一并钉住——它们是防滥用的产品决策值，改动应走评审而非随手调。
// ---------------------------------------------------------------------------

function fakeClock(start = 0) {
  let current = start
  return {
    now: () => current,
    advance(ms: number) {
      current += ms
    },
  }
}

describe('注册限速阈值常量', () => {
  it('每 IP 3 次 / 3.6e6ms；全局 50 次 / 24h', () => {
    expect(REGISTRATION_IP_LIMIT).toBe(3)
    expect(REGISTRATION_IP_WINDOW_MS).toBe(3_600_000)
    expect(REGISTRATION_GLOBAL_LIMIT).toBe(50)
    expect(REGISTRATION_GLOBAL_WINDOW_MS).toBe(86_400_000)
  })
})

describe('createRegistrationRateLimiter（每 IP 滑窗）', () => {
  it('同一 IP 前三次放行，第 4 次拒绝并标记 ip 面', () => {
    const clock = fakeClock()
    const limiter = createRegistrationRateLimiter({ now: clock.now })
    expect(limiter.check('1.1.1.1')).toBeNull()
    expect(limiter.check('1.1.1.1')).toBeNull()
    expect(limiter.check('1.1.1.1')).toBeNull()
    expect(limiter.check('1.1.1.1')).toBe('ip')
  })

  it('不同 IP 各自独立（同一时刻互不消耗额度）', () => {
    const limiter = createRegistrationRateLimiter({ now: fakeClock().now })
    expect(limiter.check('1.1.1.1')).toBeNull()
    expect(limiter.check('1.1.1.1')).toBeNull()
    expect(limiter.check('1.1.1.1')).toBeNull()
    expect(limiter.check('2.2.2.2')).toBeNull()
  })

  it('窗口滑走（> 1 小时）后同一 IP 恢复', () => {
    const clock = fakeClock(0)
    const limiter = createRegistrationRateLimiter({ now: clock.now })
    for (let i = 0; i < 3; i++) expect(limiter.check('1.1.1.1')).toBeNull()
    expect(limiter.check('1.1.1.1')).toBe('ip')
    clock.advance(REGISTRATION_IP_WINDOW_MS + 1)
    expect(limiter.check('1.1.1.1')).toBeNull()
  })
})

describe('createRegistrationRateLimiter（全局滑窗）', () => {
  it('换 IP 刷满 50 次后第 51 次拒绝，标记 global 面', () => {
    const limiter = createRegistrationRateLimiter({ now: fakeClock().now })
    for (let i = 0; i < REGISTRATION_GLOBAL_LIMIT; i++) {
      expect(limiter.check(`10.0.0.${i}`)).toBeNull()
    }
    // 第 51 次来自一个"全新"IP（未触 IP 面），命中的只能是全局窗口
    expect(limiter.check('203.0.113.1')).toBe('global')
  })

  it('全局窗口滑走（> 24h）后恢复', () => {
    const clock = fakeClock(0)
    const limiter = createRegistrationRateLimiter({ now: clock.now })
    for (let i = 0; i < REGISTRATION_GLOBAL_LIMIT; i++) limiter.check(`10.0.0.${i}`)
    expect(limiter.check('203.0.113.1')).toBe('global')
    clock.advance(REGISTRATION_GLOBAL_WINDOW_MS + 1)
    expect(limiter.check('203.0.113.1')).toBeNull()
  })

  it('被 IP 面拒绝的请求不消耗全局额度（先查 IP 后查全局）', () => {
    const limiter = createRegistrationRateLimiter({ now: fakeClock().now })
    for (let i = 0; i < 3; i++) limiter.check('1.1.1.1')
    // 该 IP 之后全部撞 IP 面
    for (let i = 0; i < 10; i++) expect(limiter.check('1.1.1.1')).toBe('ip')
    // 全局只应记了 3 次，其余 IP 仍可正常放行
    for (let i = 0; i < REGISTRATION_GLOBAL_LIMIT - 3; i++) {
      expect(limiter.check(`172.16.0.${i}`)).toBeNull()
    }
    expect(limiter.check('203.0.113.1')).toBe('global')
  })
})

// ---------------------------------------------------------------------------
// §3 注册流程：五件套单事务 + 提交后 recompute + 双开关闸
//
// 深度口径照 tests/billing-flow.test.ts：真实 registration service 叠有状态内存
// mock prisma（$transaction 带快照回滚，唯一约束抛 P2002），断言穿透到落库数据形状。
// ---------------------------------------------------------------------------

const MASTER_KEY = 'a'.repeat(64)
const REG_NOW = new Date('2026-10-18T06:00:00.000Z')
const DAY_MS = 86_400_000
/** 合法密码（大小写 + 数字 + 长度，且不与 username 相似） */
const GOOD_PASSWORD = 'Zx9!qwerty'

function makeDb(opts: {
  /** 覆盖目录内容；缺省为可用的 TRIAL 目录 */
  product?: Record<string, any> | null
} = {}) {
  const defaultProduct = {
    id: 'prod_trial',
    code: 'TRIAL',
    name: '试用计划',
    kind: 'SUBSCRIPTION',
    active: true,
    plans: [
      {
        id: 'plan_trial',
        productId: 'prod_trial',
        name: '试用套餐',
        priceCents: 0,
        billingPeriod: null,
        entitlements: {
          maxWorkspaces: 1,
          maxQueries: 10,
          allowedPlatforms: [],
          monitorSampleCountMax: 3,
        },
        deliverables: [],
        active: true,
      },
    ],
  }
  const state = {
    product: opts.product === undefined ? defaultProduct : opts.product,
    users: [] as Record<string, any>[],
    orgs: [] as Record<string, any>[],
    workspaces: [] as Record<string, any>[],
    orders: [] as Record<string, any>[],
    items: [] as Record<string, any>[],
    subscriptions: [] as Record<string, any>[],
    // 事务嵌套深度：>1 说明 recompute 之类的自开事务被塞进了五件套事务里
    txDepth: 0,
    maxTxDepth: 0,
  }
  let seq = 0
  const id = (prefix: string) => `${prefix}-${++seq}`

  const prisma: any = {
    product: {
      findUnique: async () => (state.product ? { ...state.product } : null),
    },
    user: {
      findUnique: async ({ where }: any) => {
        const key = 'username' in where ? 'username' : 'email'
        return state.users.find((u) => u[key] === where[key]) ?? null
      },
      create: async ({ data }: any) => {
        if (state.users.some((u) => u.username === data.username)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' })
        }
        if (data.email && state.users.some((u) => u.email === data.email)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' })
        }
        const row = {
          id: id('user'),
          failedLoginCount: 0,
          lockedUntil: null,
          lastLoginAt: null,
          status: 'ACTIVE',
          platformRole: null,
          phone: null,
          createdAt: REG_NOW,
          updatedAt: REG_NOW,
          ...data,
        }
        state.users.push(row)
        return row
      },
    },
    organization: {
      create: async ({ data }: any) => {
        const row = { id: id('org'), status: 'ACTIVE', billingProfile: {}, ownerOperatorId: null, createdAt: REG_NOW, updatedAt: REG_NOW, ...data }
        state.orgs.push(row)
        return row
      },
    },
    workspace: {
      create: async ({ data }: any) => {
        const row = { id: id('ws'), createdAt: REG_NOW, updatedAt: REG_NOW, ...data }
        state.workspaces.push(row)
        return row
      },
    },
    order: {
      create: async ({ data }: any) => {
        const row = { id: id('order'), currency: 'CNY', refundedCents: 0, createdAt: REG_NOW, updatedAt: REG_NOW, ...data }
        state.orders.push(row)
        return row
      },
    },
    orderItem: {
      create: async ({ data }: any) => {
        const row = { id: id('item'), workspaceId: null, ...data }
        state.items.push(row)
        return row
      },
    },
    subscription: {
      create: async ({ data }: any) => {
        const row = { id: id('sub'), createdAt: REG_NOW, updatedAt: REG_NOW, ...data }
        state.subscriptions.push(row)
        return row
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      // 快照式回滚：任一步抛错，五件套零残留（这是"事务性"断言的证据面）
      const backup = JSON.stringify({
        users: state.users, orgs: state.orgs, workspaces: state.workspaces,
        orders: state.orders, items: state.items, subscriptions: state.subscriptions,
      })
      state.txDepth += 1
      state.maxTxDepth = Math.max(state.maxTxDepth, state.txDepth)
      try {
        return await fn(prisma)
      } catch (err) {
        const parsed = JSON.parse(backup)
        state.users = parsed.users
        state.orgs = parsed.orgs
        state.workspaces = parsed.workspaces
        state.orders = parsed.orders
        state.items = parsed.items
        state.subscriptions = parsed.subscriptions
        throw err
      } finally {
        state.txDepth -= 1
      }
    },
  }
  return { prisma, state }
}

function makeAudit() {
  return { record: vi.fn(async () => {}), list: vi.fn(async () => ({ items: [], total: 0 })) }
}

function makeSessions() {
  return {
    create: vi.fn(async (userId: string) => ({
      token: 'tok-new',
      session: { id: 'sess-new', userId, revokedAt: null },
    })),
    resolve: vi.fn(),
    rotate: vi.fn(),
    revokeAllForUser: vi.fn(async () => 0),
    revokeByToken: vi.fn(async () => 0),
  } as any
}

function makeEnv(overrides: Record<string, string | undefined> = {}) {
  return { REGISTRATION_ENABLED: 'on', BILLING_ENFORCEMENT: 'on', ...overrides }
}

function makeService(opts: {
  db?: ReturnType<typeof makeDb>
  audit?: ReturnType<typeof makeAudit>
  sessions?: ReturnType<typeof makeSessions>
  entitlements?: { recompute: ReturnType<typeof vi.fn> }
  env?: Record<string, string | undefined>
  rateLimiter?: RegistrationRateLimiter
} = {}) {
  const db = opts.db ?? makeDb()
  const audit = opts.audit ?? makeAudit()
  const sessions = opts.sessions ?? makeSessions()
  const entitlements = opts.entitlements ?? { recompute: vi.fn(async () => ({})) }
  const service = createRegistrationService({
    prisma: db.prisma,
    sessions,
    audit,
    entitlements,
    envelopeKey: MASTER_KEY,
    env: makeEnv(opts.env),
    now: () => REG_NOW,
    randomSuffix: () => 'aaaaaaaa',
    ...(opts.rateLimiter ? { rateLimiter: opts.rateLimiter } : {}),
  })
  return { service, db, audit, sessions, entitlements }
}

function input(overrides: Record<string, unknown> = {}) {
  return { username: 'trialuser', password: GOOD_PASSWORD, ip: '203.0.113.9', ...overrides }
}

describe('registerTrial：五件套单事务（逐项断言）', () => {
  it('User：CUSTOMER / ORG_OWNER / mustChangePassword=false', async () => {
    const { service, db } = makeService()
    await service.registerTrial(input({ email: 'trial@example.com' }))
    expect(db.state.users).toHaveLength(1)
    expect(db.state.users[0]).toMatchObject({
      username: 'trialuser',
      displayName: 'trialuser',
      email: 'trial@example.com',
      userType: 'CUSTOMER',
      orgRole: 'ORG_OWNER',
      mustChangePassword: false,
    })
  })

  it('Organization：source=TRIAL（自助租户标记，M4 转化漏斗的锚）', async () => {
    const { service, db } = makeService()
    await service.registerTrial(input())
    expect(db.state.orgs).toHaveLength(1)
    expect(db.state.orgs[0].source).toBe('TRIAL')
  })

  it('Workspace：monitorSchedule=DAILY、monitorSampleCount=3、platformConfig 为信封密文（非明文 {}）', async () => {
    const { service, db } = makeService()
    await service.registerTrial(input())
    expect(db.state.workspaces).toHaveLength(1)
    const ws = db.state.workspaces[0]
    expect(ws.monitorSchedule).toBe('DAILY')
    expect(ws.monitorSampleCount).toBe(3)
    expect(typeof ws.platformConfig).toBe('string')
    expect(ws.platformConfig).not.toBe('{}')
    expect(isEncryptedConfig(ws.platformConfig)).toBe(true)
    // 解密回空配置（证明落库的是"空的密文"，而不是误存了别的东西）
    expect(JSON.parse(decryptConfig(ws.platformConfig, MASTER_KEY))).toEqual({})
  })

  it('Order：$0 / paymentMethod=TRIAL / paidAt=null / COMPLETED', async () => {
    const { service, db } = makeService()
    await service.registerTrial(input())
    expect(db.state.orders).toHaveLength(1)
    expect(db.state.orders[0]).toMatchObject({
      status: 'COMPLETED',
      totalCents: 0,
      payableCents: 0,
      refundedCents: 0,
      paymentMethod: 'TRIAL',
      paidAt: null,
    })
    expect(db.state.orders[0].orderNo).toBe('GEO261018aaaaaaaa')
  })

  it('OrderItem：一条 $0 行，含 planSnapshot（后台订单详情/漏斗完整）', async () => {
    const { service, db } = makeService()
    await service.registerTrial(input())
    expect(db.state.items).toHaveLength(1)
    const item = db.state.items[0]
    expect(item).toMatchObject({ planId: 'plan_trial', quantity: 1, unitPriceCents: 0 })
    expect(item.planSnapshot).toMatchObject({
      name: '试用套餐',
      kind: 'SUBSCRIPTION',
      priceCents: 0,
      billingPeriod: null,
      entitlements: { maxWorkspaces: 1, maxQueries: 10, monitorSampleCountMax: 3 },
    })
  })

  it('Subscription：endAt=注册+7 天直写、entitlements 快照含 _graceDays:90 与 _suppressReminder:true', async () => {
    const { service, db } = makeService()
    await service.registerTrial(input())
    expect(db.state.subscriptions).toHaveLength(1)
    const sub = db.state.subscriptions[0]
    expect(sub.status).toBe('ACTIVE')
    expect(sub.startAt).toEqual(REG_NOW)
    expect(sub.endAt).toEqual(new Date(REG_NOW.getTime() + 7 * DAY_MS))
    expect(sub.entitlements).toMatchObject({
      maxWorkspaces: 1,
      maxQueries: 10,
      monitorSampleCountMax: 3,
      _graceDays: 90,
      _suppressReminder: true,
    })
  })

  it('注册成功直接签发登录态（复用 login 的会话路径）', async () => {
    const { service, sessions } = makeService()
    const result = await service.registerTrial(input())
    expect(sessions.create).toHaveBeenCalledWith(result.user.id, { ip: '203.0.113.9' })
    expect(result.token).toBe('tok-new')
  })

  it('审计五事件各一条（auth.register/organization.create/workspace.create/order.create/subscription.create）', async () => {
    const { service, audit } = makeService()
    await service.registerTrial(input())
    const actions = audit.record.mock.calls.map((c) => (c[0] as { action: string }).action)
    expect(actions).toEqual([
      'auth.register',
      'organization.create',
      'workspace.create',
      'order.create',
      'subscription.create',
    ])
  })
})

describe('registerTrial：事务边界', () => {
  it('recompute 在事务提交后被调，且不在事务内（自开事务不可嵌套）', async () => {
    const { service, db, entitlements } = makeService()
    const recompute = vi.fn(async () => {
      // recompute 执行时事务深度必须已回到 0
      expect(db.state.txDepth).toBe(0)
      expect(db.state.users).toHaveLength(1)
      return {}
    })
    entitlements.recompute = recompute
    await service.registerTrial(input())
    expect(recompute).toHaveBeenCalledTimes(1)
    expect(recompute).toHaveBeenCalledWith(db.state.orgs[0].id)
    expect(db.state.maxTxDepth).toBe(1)
  })
})

describe('registerTrial：派生规则与输入校验', () => {
  it('displayName = brandName ?? username', async () => {
    const { service, db } = makeService()
    await service.registerTrial(input({ brandName: '星海科技' }))
    expect(db.state.users[0].displayName).toBe('星海科技')
    expect(db.state.workspaces[0].defaultBrandName).toBe('星海科技')

    const second = makeService()
    await second.service.registerTrial(input({ username: 'trialuser2' }))
    expect(second.db.state.users[0].displayName).toBe('trialuser2')
  })

  it('organizationName 缺省 "{brand} 的企业"，显式传入优先', async () => {
    const { service, db } = makeService()
    await service.registerTrial(input({ brandName: '星海科技' }))
    expect(db.state.orgs[0].name).toBe('星海科技 的企业')

    const second = makeService()
    await second.service.registerTrial(input({ brandName: '星海科技', organizationName: '上海星海网络科技有限公司' }))
    expect(second.db.state.orgs[0].name).toBe('上海星海网络科技有限公司')
  })

  it('email 可选：缺省落 null，不做唯一性检查', async () => {
    const { service, db } = makeService()
    await service.registerTrial(input())
    expect(db.state.users[0].email).toBeNull()
  })

  it('username 冲突 → BAD_REQUEST 明确文案', async () => {
    const shared = makeService()
    await shared.service.registerTrial(input())
    await expect(
      shared.service.registerTrial(input({ email: 'other@example.com' })),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: REGISTRATION_USERNAME_TAKEN_MESSAGE })
    expect(shared.db.state.orgs).toHaveLength(1)
  })

  it('email 冲突 → BAD_REQUEST 明确文案', async () => {
    const shared = makeService()
    await shared.service.registerTrial(input({ email: 'dup@example.com' }))
    await expect(
      shared.service.registerTrial(input({ username: 'otheruser', email: 'dup@example.com' })),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: REGISTRATION_EMAIL_TAKEN_MESSAGE })
  })

  it('密码不满足策略 → BAD_REQUEST，且零残留', async () => {
    const { service, db } = makeService()
    await expect(service.registerTrial(input({ password: 'weak' }))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(db.state.users).toHaveLength(0)
    expect(db.state.orgs).toHaveLength(0)
  })
})

describe('registerTrial：事务性（任一步失败零残留）', () => {
  it('第 3 步（Order 创建）失败 → User/Organization/Workspace 全部回滚', async () => {
    const db = makeDb()
    const original = db.prisma.order.create
    db.prisma.order.create = async () => {
      throw new Error('boom at order step')
    }
    const { service } = makeService({ db })
    await expect(service.registerTrial(input())).rejects.toThrow('boom at order step')
    expect(db.state.users).toHaveLength(0)
    expect(db.state.orgs).toHaveLength(0)
    expect(db.state.workspaces).toHaveLength(0)
    expect(db.state.orders).toHaveLength(0)
    db.prisma.order.create = original
  })

  it('第 4 步（Subscription 创建）失败 → 前四件同样全部回滚', async () => {
    const db = makeDb()
    db.prisma.subscription.create = async () => {
      throw new Error('boom at subscription step')
    }
    const { service } = makeService({ db })
    await expect(service.registerTrial(input())).rejects.toThrow('boom at subscription step')
    expect(db.state.users).toHaveLength(0)
    expect(db.state.orgs).toHaveLength(0)
    expect(db.state.workspaces).toHaveLength(0)
    expect(db.state.items).toHaveLength(0)
  })
})

describe('registerTrial：TRIAL 计划查找 fail-closed', () => {
  it('目录缺少 code=TRIAL 的商品 → 明确报错且零残留', async () => {
    const { service, db } = makeService({ db: makeDb({ product: null }) })
    await expect(service.registerTrial(input())).rejects.toMatchObject({
      name: 'TRIAL_PLAN_UNAVAILABLE',
    })
    expect(db.state.users).toHaveLength(0)
    expect(db.state.orgs).toHaveLength(0)
  })

  it('TRIAL 商品类型非 SUBSCRIPTION → 明确报错且零残留', async () => {
    const db = makeDb()
    db.state.product.kind = 'SERVICE'
    const { service } = makeService({ db })
    await expect(service.registerTrial(input())).rejects.toMatchObject({
      name: 'TRIAL_PLAN_UNAVAILABLE',
    })
    expect(db.state.users).toHaveLength(0)
  })

  it('套餐全部下架（active=false 过滤后为空）→ 明确报错且零残留', async () => {
    const db = makeDb()
    db.state.product.plans = []
    const { service } = makeService({ db })
    await expect(service.registerTrial(input())).rejects.toMatchObject({
      name: 'TRIAL_PLAN_UNAVAILABLE',
    })
    expect(db.state.users).toHaveLength(0)
  })

  it('套餐未声明 maxWorkspaces ≥ 1 → 明确报错（绝不建无配额租户）', async () => {
    const db = makeDb()
    db.state.product.plans[0].entitlements = { maxWorkspaces: 0, maxQueries: 10 }
    const { service } = makeService({ db })
    await expect(service.registerTrial(input())).rejects.toMatchObject({
      name: 'TRIAL_PLAN_UNAVAILABLE',
    })
    expect(db.state.orgs).toHaveLength(0)
  })
})

describe('双开关四象限（REGISTRATION × ENFORCEMENT，fail-closed）', () => {
  const cases = [
    { name: '双 on → 放行', reg: 'on', enf: 'on', allowed: true },
    { name: '仅注册开、enforcement off → 关闭', reg: 'on', enf: 'off', allowed: false },
    { name: '仅 enforcement 开、注册 off → 关闭', reg: 'off', enf: 'on', allowed: false },
    { name: '双 off → 关闭', reg: 'off', enf: 'off', allowed: false },
  ] as const

  for (const c of cases) {
    it(`${c.name}：registerTrial 与 isEnabled 判定一致`, async () => {
      const { service, db } = makeService({
        env: { REGISTRATION_ENABLED: c.reg, BILLING_ENFORCEMENT: c.enf },
      })
      expect(service.isEnabled()).toBe(c.allowed)
      if (c.allowed) {
        await expect(service.registerTrial(input())).resolves.toMatchObject({
          user: { username: 'trialuser' },
        })
        expect(db.state.orgs).toHaveLength(1)
      } else {
        await expect(service.registerTrial(input())).rejects.toMatchObject({
          code: 'FORBIDDEN',
          message: REGISTRATION_CLOSED_MESSAGE,
        })
        expect(db.state.orgs).toHaveLength(0)
        expect(db.state.users).toHaveLength(0)
      }
    })
  }

  it('缺省（env 两项皆缺）→ 关闭（默认关）', async () => {
    const { service } = makeService({ env: { REGISTRATION_ENABLED: undefined, BILLING_ENFORCEMENT: undefined } })
    expect(service.isEnabled()).toBe(false)
    await expect(service.registerTrial(input())).rejects.toMatchObject({
      message: REGISTRATION_CLOSED_MESSAGE,
    })
  })

  it('registrationEnabled(env) 纯函数与 service 判定同源', () => {
    expect(registrationEnabled({ REGISTRATION_ENABLED: 'true', BILLING_ENFORCEMENT: 'true' })).toBe(true)
    expect(registrationEnabled({ REGISTRATION_ENABLED: 'true', BILLING_ENFORCEMENT: '1' })).toBe(false)
    expect(registrationEnabled({ REGISTRATION_ENABLED: '1', BILLING_ENFORCEMENT: 'on' })).toBe(false)
    expect(registrationEnabled({})).toBe(false)
  })
})

describe('registerTrial：限速（接入 §4 双滑窗）', () => {
  it('同一 IP 第 4 次注册被拒：TOO_MANY_REQUESTS 且不再建任何记录', async () => {
    const shared = makeService()
    for (let i = 0; i < 3; i++) {
      await expect(
        shared.service.registerTrial(input({ username: `trialuser${i}` })),
      ).resolves.toBeTruthy()
    }
    await expect(shared.service.registerTrial(input({ username: 'trialuser3' }))).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: REGISTRATION_RATE_LIMITED_MESSAGE,
    })
    expect(shared.db.state.users).toHaveLength(3)
    expect(shared.db.state.orgs).toHaveLength(3)
  })
})
