import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createServiceStateResolver,
  subscriptionGraceDays,
  type ServiceStateResolver,
} from './service-state.js'
import { protectedProcedure, router } from '../../core/trpc/init.js'

// ---------------------------------------------------------------------------
// 遗留 C10：init.ts 模块级惰性默认 resolver 路径。ctx.services.serviceState 未注入时
// requireWorkspace 回落 getServiceStateResolver 的惰性默认，其 prisma 来自
// getPrismaClient()（模块级单例，无法直接注入）——以 vi.mock 替换 db/client 模块，
// 走一个不注入 serviceState 的 protectedProcedure caller，钉住默认 resolver 行为。
// ---------------------------------------------------------------------------

/** hoisted 槽位：vi.mock 工厂先于模块初始化执行，prisma 引用须经此中转 */
const lazyDb = vi.hoisted(() => ({ prisma: null as unknown as PrismaClient }))
vi.mock('../../core/db/client.js', () => ({
  getPrismaClient: () => lazyDb.prisma,
  resetPrismaClient: () => {},
}))

const NOW = new Date('2026-10-15T08:00:00.000Z')

/** mock prisma：默认全部 miss（→ NONE）；各用例按需覆盖返回值 */
function makePrisma(opts: {
  activeSubscription?: () => unknown
  activeDelivery?: () => unknown
  graceSubscription?: () => unknown
} = {}) {
  return {
    subscription: {
      findFirst: vi.fn(async (args: { where: { status?: string } }) =>
        args.where.status === 'GRACE'
          ? (opts.graceSubscription?.() ?? null)
          : (opts.activeSubscription?.() ?? null),
      ),
    },
    serviceDelivery: {
      findFirst: vi.fn(async () => opts.activeDelivery?.() ?? null),
    },
  } as unknown as PrismaClient
}

/** 可推进的时钟：vitest fake timers 不引入，直接闭包变量 */
function makeClock(start: Date) {
  let current = new Date(start)
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms)
    },
  }
}

describe('createServiceStateResolver：三态判定', () => {
  it('存在 ACTIVE 订阅（endAt > now）→ ACTIVE，且短路径不再查交付', async () => {
    const prisma = makePrisma({ activeSubscription: () => ({ id: 'sub-1' }) })
    const resolver = createServiceStateResolver({ prisma, now: () => NOW })

    await expect(resolver.resolve('org-1')).resolves.toBe('ACTIVE')
    expect(prisma.subscription.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', status: 'ACTIVE', endAt: { gt: NOW } },
      select: { id: true },
    })
    expect(prisma.serviceDelivery.findFirst).not.toHaveBeenCalled()
  })

  it('无 ACTIVE 订阅 + 进行中 ServiceDelivery（经 workspace 关联）→ ACTIVE（§3.3 一次性交付期同样有效）', async () => {
    const prisma = makePrisma({ activeDelivery: () => ({ id: 'sd-1' }) })
    const resolver = createServiceStateResolver({ prisma, now: () => NOW })

    await expect(resolver.resolve('org-1')).resolves.toBe('ACTIVE')
    // ServiceDelivery 无 organizationId 列：经 workspace 关系 join 到企业
    expect(prisma.serviceDelivery.findFirst).toHaveBeenCalledWith({
      where: {
        status: { in: ['PENDING_ASSIGN', 'IN_PROGRESS', 'PENDING_ACCEPTANCE'] },
        workspace: { organizationId: 'org-1' },
      },
      select: { id: true },
    })
  })

  it('交付已验收（ACCEPTED）不算进行中：无 ACTIVE 订阅 + GRACE 订阅存在 → GRACE（不看 endAt）', async () => {
    const prisma = makePrisma({ graceSubscription: () => ({ id: 'sub-grace' }) })
    const resolver = createServiceStateResolver({ prisma, now: () => NOW })

    await expect(resolver.resolve('org-1')).resolves.toBe('GRACE')
    expect(prisma.subscription.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', status: 'GRACE' },
      select: { id: true },
    })
  })

  it('ACTIVE 订阅 endAt <= now 不算有效：落到交付/宽限判定', async () => {
    // endAt 过期的 ACTIVE 订阅在 where 里被过滤（findFirst 返回 null），后续无 GRACE → NONE
    const prisma = makePrisma()
    const resolver = createServiceStateResolver({ prisma, now: () => NOW })

    await expect(resolver.resolve('org-1')).resolves.toBe('NONE')
    // 三步都查过：ACTIVE 订阅 → 交付 → GRACE 订阅
    expect(prisma.serviceDelivery.findFirst).toHaveBeenCalledTimes(1)
    expect(prisma.subscription.findFirst).toHaveBeenCalledTimes(2)
  })

  it('皆无 → NONE（兜底 FORBIDDEN 语义）', async () => {
    const prisma = makePrisma()
    const resolver = createServiceStateResolver({ prisma, now: () => NOW })
    await expect(resolver.resolve('org-1')).resolves.toBe('NONE')
  })
})

describe('createServiceStateResolver：TTL 缓存（续费后最迟 1 分钟生效）', () => {
  it('TTL 内重复 resolve 不再查库；推进超过 ttl 后重新查库取到新结果', async () => {
    const clock = makeClock(NOW)
    let renewed = false
    const prisma = makePrisma({
      // 续费后（第二次查库）出现有效订阅
      activeSubscription: () => (renewed ? { id: 'sub-new' } : null),
    })
    const resolver = createServiceStateResolver({ prisma, ttlMs: 60_000, now: clock.now })

    await expect(resolver.resolve('org-1')).resolves.toBe('NONE')
    await expect(resolver.resolve('org-1')).resolves.toBe('NONE')
    // 查库只发生一轮（一轮 = ACTIVE + GRACE 两次 subscription.findFirst）
    expect(prisma.subscription.findFirst).toHaveBeenCalledTimes(2)

    // 推进 60s + 1ms：缓存过期，重新查库
    clock.advance(60_001)
    renewed = true
    await expect(resolver.resolve('org-1')).resolves.toBe('ACTIVE')
    expect(prisma.subscription.findFirst).toHaveBeenCalledTimes(3)
  })

  it('不同 org 独立缓存（TTL 命中按 org 隔离）', async () => {
    const clock = makeClock(NOW)
    const prisma = makePrisma()
    const resolver = createServiceStateResolver({ prisma, ttlMs: 60_000, now: clock.now })

    await resolver.resolve('org-1')
    await resolver.resolve('org-2')
    expect(prisma.subscription.findFirst).toHaveBeenCalledTimes(4) // 两轮（各 2 次）

    clock.advance(30_000)
    await resolver.resolve('org-1') // org-1 未过期：命中缓存
    expect(prisma.subscription.findFirst).toHaveBeenCalledTimes(4)
  })

  it('invalidate(organizationId) 立即失效该 org；invalidate() 全清', async () => {
    const prisma = makePrisma()
    const resolver = createServiceStateResolver({ prisma, now: () => NOW })

    await resolver.resolve('org-1')
    await resolver.resolve('org-2')
    expect(prisma.subscription.findFirst).toHaveBeenCalledTimes(4)

    resolver.invalidate('org-1')
    await resolver.resolve('org-1')
    expect(prisma.subscription.findFirst).toHaveBeenCalledTimes(6) // org-1 重查一轮

    resolver.invalidate()
    await resolver.resolve('org-2')
    expect(prisma.subscription.findFirst).toHaveBeenCalledTimes(8) // org-2 重查一轮
  })

  it('缓存上限：条目超过 10_000 后清空重建（防 org 量大内存膨胀）', async () => {
    const prisma = makePrisma()
    const resolver = createServiceStateResolver({ prisma, ttlMs: 600_000, now: () => NOW })

    const subCallsFor = (org: string) =>
      (prisma.subscription.findFirst as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([where]: [{ where: { organizationId: string } }]) => where.where.organizationId === org,
      ).length

    // 填满 10_000 条（每轮 miss = ACTIVE + GRACE 两次 subscription.findFirst）
    for (let i = 0; i < 10_000; i++) {
      await resolver.resolve(`org-${i}`)
    }
    expect(subCallsFor('org-0')).toBe(2)

    // 命中缓存：不重查
    await resolver.resolve('org-0')
    expect(subCallsFor('org-0')).toBe(2)

    // 第 10_001 个 org 写入触发清空重建
    await resolver.resolve('org-extra')
    await resolver.resolve('org-0') // 缓存已被清空 → 重查
    expect(subCallsFor('org-0')).toBe(4)
  })
})

describe('subscriptionGraceDays（常量导出，任务 11 消费）', () => {
  it('缺省 7 天；SUBSCRIPTION_GRACE_DAYS 可配；非法值回退 7', () => {
    expect(subscriptionGraceDays({})).toBe(7)
    expect(subscriptionGraceDays({ SUBSCRIPTION_GRACE_DAYS: '14' })).toBe(14)
    expect(subscriptionGraceDays({ SUBSCRIPTION_GRACE_DAYS: 'abc' })).toBe(7)
    expect(subscriptionGraceDays({ SUBSCRIPTION_GRACE_DAYS: '-3' })).toBe(7)
  })
})

describe('createServiceStateResolver：resolver 形状', () => {
  it('返回 resolve + invalidate 两个成员', () => {
    const resolver: ServiceStateResolver = createServiceStateResolver({
      prisma: makePrisma(),
      now: () => NOW,
    })
    expect(typeof resolver.resolve).toBe('function')
    expect(typeof resolver.invalidate).toBe('function')
  })
})

describe('init.ts 惰性默认 resolver（遗留 C10）：serviceState 未注入时 requireWorkspace 回落默认且行为正确', () => {
  const lazyRouter = router({
    read: protectedProcedure.query(() => 'read-ok'),
    write: protectedProcedure.mutation(() => 'write-ok'),
  })
  const prevEnforcement = process.env.BILLING_ENFORCEMENT

  beforeEach(() => {
    process.env.BILLING_ENFORCEMENT = 'on'
  })
  afterEach(() => {
    if (prevEnforcement === undefined) delete process.env.BILLING_ENFORCEMENT
    else process.env.BILLING_ENFORCEMENT = prevEnforcement
  })

  it('默认 resolver 经 getPrismaClient 的 prisma 判定：GRACE → query ✓ / mutation 拒（宽限期只读）', async () => {
    // mock prisma：无 ACTIVE 订阅/进行中交付 + 存在 GRACE 订阅 → 默认 resolver 判 GRACE
    lazyDb.prisma = makePrisma({ graceSubscription: () => ({ id: 'sub-grace' }) })

    // services 不含 serviceState → 触发 init.ts 模块级惰性默认构建（enforcement=on 才会走到）
    const caller = lazyRouter.createCaller({
      actor: { kind: 'apiKey', credential: { id: 'cred-1', workspaceId: 'ws-1' } },
      workspace: { id: 'ws-1', organizationId: 'org-1', status: 'ACTIVE' },
      services: {},
      requestMeta: { ip: '1.2.3.4', requestId: 'r1', method: 'POST', headers: { 'x-geo-csrf': '1' } },
    } as any)

    await expect(caller.read()).resolves.toBe('read-ok')
    await expect(caller.write()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('宽限期只读，请续费'),
    })
    // 默认 resolver 的查库确实发生（ACTIVE 订阅 miss → 交付 miss → GRACE 命中）
    expect(lazyDb.prisma.subscription.findFirst).toHaveBeenCalledTimes(2)
    expect(lazyDb.prisma.serviceDelivery.findFirst).toHaveBeenCalledTimes(1)
  })
})
