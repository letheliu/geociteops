import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { createOrgService } from '../src/platform/org/service.js'
import { createIdentityService } from '../src/platform/identity/service.js'

const NOW = new Date('2026-10-15T08:00:00.000Z')
const DAY_MS = 86_400_000

// ---------------------------------------------------------------------------
// 赠送配额（Ruling 10 从宽值）：与脚本导出的常量同值（测试里独立字面量，
// 脚本漂移时此处红线断言会先红）。
// ---------------------------------------------------------------------------
const GIFT_ENTITLEMENTS = {
  maxWorkspaces: 5,
  maxQueries: 200,
  allowedPlatforms: [
    'deepseek',
    'doubao',
    'qwen',
    'ernie',
    'perplexity',
    'chatgpt',
    'gemini',
  ],
  diagnosticRunsPerMonth: 30,
  samplesPerRun: 200,
  maxPages: 500,
  optimizationsPerMonth: 100,
}

// ---------------------------------------------------------------------------
// mock prisma（照 tests/migrate-tob-p0.test.ts 模式）
// ---------------------------------------------------------------------------

function makeGrantPrisma() {
  return {
    product: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    productPlan: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    organization: {
      findMany: vi.fn(),
    },
    order: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    subscription: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
    // entitlement service recompute 的事务路径（$transaction 直通 mock prisma 自身）
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    $queryRaw: vi.fn().mockResolvedValue([
      { organizationId: 'org-1', periodStart: NOW, periodEnd: new Date('2026-11-01T00:00:00Z') },
    ]),
    organizationEntitlement: {
      upsert: vi.fn(),
      update: vi.fn(),
    },
  } as unknown as PrismaClient & Record<string, Record<string, ReturnType<typeof vi.fn>>>
}

let prisma: ReturnType<typeof makeGrantPrisma>

beforeEach(() => {
  prisma = makeGrantPrisma()
})

describe('grantGiftSubscriptions', () => {
  it('无有效订阅的 org 发放 90 天赠送：Product/Plan/合成 Order/Subscription 形状 + recompute 逐 org', async () => {
    prisma.product.findUnique.mockResolvedValue(null)
    prisma.product.create.mockResolvedValue({ id: 'prod-gift', code: 'gift-migration' })
    prisma.productPlan.findFirst.mockResolvedValue(null)
    prisma.productPlan.create.mockResolvedValue({ id: 'plan-gift', productId: 'prod-gift' })
    prisma.organization.findMany.mockResolvedValue([
      { id: 'org-1' },
      { id: 'org-2' },
      { id: 'org-3' },
    ])
    prisma.order.findUnique.mockResolvedValue(null)
    // gift 锚检查（where.sourceOrderId）均未命中；有效订阅检查仅 org-2 命中
    prisma.subscription.findFirst.mockImplementation(async (args: unknown) => {
      const where = (args as { where?: Record<string, unknown> })?.where ?? {}
      if (where.sourceOrderId !== undefined) return null
      return where.organizationId === 'org-2' ? { id: 'sub-active' } : null
    })

    const { grantGiftSubscriptions } = await import('../scripts/grant-gift-subscriptions.js')
    const result = await grantGiftSubscriptions(prisma, { now: () => NOW })

    expect(result).toEqual({
      ensuredProduct: true,
      ensuredPlan: true,
      granted: 2, // org-1 / org-3（org-3 仅剩 EXPIRED 订阅，不算有效，仍兜底发放）
      skipped: 1, // org-2 已有有效订阅
    })

    // Product：code 查找或建，kind SUBSCRIPTION、active=false（不在商城展示）
    expect(prisma.product.create).toHaveBeenCalledWith({
      data: {
        code: 'gift-migration',
        name: expect.any(String),
        kind: 'SUBSCRIPTION',
        description: expect.any(String),
        active: false,
      },
    })

    // Plan：priceCents=0、billingPeriod=null、entitlements=Ruling 10 从宽值、active=false
    expect(prisma.productPlan.create).toHaveBeenCalledWith({
      data: {
        productId: 'prod-gift',
        name: '迁移赠送 90 天',
        priceCents: 0,
        billingPeriod: null,
        entitlements: GIFT_ENTITLEMENTS,
        deliverables: [],
        active: false,
      },
    })

    // 合成 Order（订阅 sourceOrderId 的 FK 锚）：id/orderNo=gift-<orgId>，0 元，COMPLETED
    expect(prisma.order.create).toHaveBeenCalledWith({
      data: {
        id: 'gift-org-1',
        orderNo: 'gift-org-1',
        organizationId: 'org-1',
        status: 'COMPLETED',
        totalCents: 0,
        payableCents: 0,
        remark: expect.any(String),
      },
    })

    // Subscription：sourceOrderId=gift-<orgId>、startAt=now、endAt=now+90d、entitlements=快照
    expect(prisma.subscription.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org-1',
        planId: 'plan-gift',
        sourceOrderId: 'gift-org-1',
        startAt: NOW,
        endAt: new Date(NOW.getTime() + 90 * DAY_MS),
        status: 'ACTIVE',
        entitlements: GIFT_ENTITLEMENTS,
      },
    })
    expect(prisma.subscription.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org-3',
        planId: 'plan-gift',
        sourceOrderId: 'gift-org-3',
        startAt: NOW,
        endAt: new Date(NOW.getTime() + 90 * DAY_MS),
        status: 'ACTIVE',
        entitlements: GIFT_ENTITLEMENTS,
      },
    })
    // org-2 不发放
    expect(prisma.subscription.create).toHaveBeenCalledTimes(2)

    // recompute 逐 granted org（org-1 / org-3），跳过的 org-2 不重算
    const recomputed = prisma.organizationEntitlement.upsert.mock.calls.map(
      (call) => (call[0] as { where: { organizationId: string } }).where.organizationId,
    )
    expect(recomputed).toEqual(['org-1', 'org-3'])
  })

  it('幂等第二遍：Product/Plan 复用不重建，gift 锚已存在的 org 全量跳过不重复发放（锚命中仍重算）', async () => {
    prisma.product.findUnique.mockResolvedValue({ id: 'prod-gift', code: 'gift-migration' })
    prisma.productPlan.findFirst.mockResolvedValue({
      id: 'plan-gift',
      productId: 'prod-gift',
      name: '迁移赠送 90 天',
    })
    prisma.organization.findMany.mockResolvedValue([{ id: 'org-1' }, { id: 'org-2' }])
    // 第二遍：gift 锚检查（与有效订阅检查）均命中 → 全量跳过
    prisma.subscription.findFirst.mockResolvedValue({ id: 'sub-gift' })

    const { grantGiftSubscriptions } = await import('../scripts/grant-gift-subscriptions.js')
    const result = await grantGiftSubscriptions(prisma, { now: () => NOW })

    expect(result).toEqual({
      ensuredProduct: false,
      ensuredPlan: false,
      granted: 0,
      skipped: 2,
    })
    expect(prisma.product.create).not.toHaveBeenCalled()
    expect(prisma.productPlan.create).not.toHaveBeenCalled()
    expect(prisma.order.create).not.toHaveBeenCalled()
    expect(prisma.subscription.create).not.toHaveBeenCalled()
    // 锚命中的 org 仍触发配额重算（recompute 幂等——中断自愈语义，见下条用例）
    const recomputed = prisma.organizationEntitlement.upsert.mock.calls.map(
      (call) => (call[0] as { where: { organizationId: string } }).where.organizationId,
    )
    expect(recomputed).toEqual(['org-1', 'org-2'])
  })

  it('中断自愈：org 已有 gift 订阅但 OE 未算（上轮 create 后 recompute 前中断）→ 重跑锚命中 skip 仍补算该 org', async () => {
    prisma.product.findUnique.mockResolvedValue({ id: 'prod-gift', code: 'gift-migration' })
    prisma.productPlan.findFirst.mockResolvedValue({
      id: 'plan-gift',
      productId: 'prod-gift',
      name: '迁移赠送 90 天',
    })
    prisma.organization.findMany.mockResolvedValue([{ id: 'org-1' }, { id: 'org-2' }])
    // 上轮中断现场：org-1 的 gift 订阅已创建（锚命中）但 recompute 未及执行；
    // org-2 是独立的有效订阅（非 gift），命中"有效订阅"skip
    prisma.subscription.findFirst.mockImplementation(async (args: unknown) => {
      const where = (args as { where?: Record<string, unknown> })?.where ?? {}
      if (where.sourceOrderId !== undefined) {
        return where.organizationId === 'org-1' ? { id: 'sub-gift-1' } : null
      }
      return where.organizationId === 'org-2' ? { id: 'sub-active-2' } : null
    })

    const { grantGiftSubscriptions } = await import('../scripts/grant-gift-subscriptions.js')
    const result = await grantGiftSubscriptions(prisma, { now: () => NOW })

    expect(result).toEqual({ ensuredProduct: false, ensuredPlan: false, granted: 0, skipped: 2 })
    // 不重复发放（假绿但零副作用不是目标——目标是下面的补算）
    expect(prisma.order.create).not.toHaveBeenCalled()
    expect(prisma.subscription.create).not.toHaveBeenCalled()
    // 自愈：gift 锚命中的 org-1 被重算；有效订阅 skip 的 org-2 不在本脚本重算范围
    const recomputed = prisma.organizationEntitlement.upsert.mock.calls.map(
      (call) => (call[0] as { where: { organizationId: string } }).where.organizationId,
    )
    expect(recomputed).toEqual(['org-1'])
  })

  it('锚判定不绑 planId：plan 被删重建（新 id）后旧 gift 订阅仍被锚命中，不二次发放', async () => {
    prisma.product.findUnique.mockResolvedValue({ id: 'prod-gift', code: 'gift-migration' })
    // plan 行被运营删除后脚本重建 → 新 plan id，旧 gift 订阅的 planId 与之不同
    prisma.productPlan.findFirst.mockResolvedValue({ id: 'plan-new', productId: 'prod-gift' })
    prisma.organization.findMany.mockResolvedValue([{ id: 'org-1' }])
    // 锚查询按 sourceOrderId 命中（即使 planId 不同）
    prisma.subscription.findFirst.mockResolvedValue({ id: 'sub-gift-old' })

    const { grantGiftSubscriptions } = await import('../scripts/grant-gift-subscriptions.js')
    const result = await grantGiftSubscriptions(prisma, { now: () => NOW })

    expect(result).toEqual({ ensuredProduct: false, ensuredPlan: false, granted: 0, skipped: 1 })
    expect(prisma.subscription.create).not.toHaveBeenCalled()
    expect(prisma.order.create).not.toHaveBeenCalled()
    // 锚查询 where 不含 planId：仅按 organizationId + sourceOrderId 判定
    const anchorQueries = prisma.subscription.findFirst.mock.calls
      .map((call) => call[0] as { where?: Record<string, unknown> })
      .filter((args) => args.where?.sourceOrderId !== undefined)
    expect(anchorQueries).toHaveLength(1)
    expect(anchorQueries[0].where).toEqual({
      organizationId: 'org-1',
      sourceOrderId: 'gift-org-1',
    })
  })
})

// ---------------------------------------------------------------------------
// P1 遗留 2a：org.credentials.issue 补审计 credential.issue
// ---------------------------------------------------------------------------

function makeOrgServiceMocks() {
  const orgPrisma = {
    workspace: { findUnique: vi.fn() },
    apiCredential: { findUnique: vi.fn() },
  } as unknown as PrismaClient & Record<string, Record<string, ReturnType<typeof vi.fn>>>
  const audit = { record: vi.fn(async () => {}), list: vi.fn() }
  const credentials = {
    list: vi.fn(),
    issue: vi.fn(),
    revoke: vi.fn(),
  }
  const service = createOrgService({
    prisma: orgPrisma,
    identity: {} as never,
    members: {} as never,
    audit: audit as never,
    credentials: credentials as never,
    workspaceAdmin: {} as never,
  })
  return { orgPrisma, audit, credentials, service }
}

describe('org service credentials.issue 审计（P1 遗留 2a）', () => {
  it('属本企业签发成功 → audit credential.issue（organizationId/workspaceId/target 齐全）', async () => {
    const { orgPrisma, audit, credentials, service } = makeOrgServiceMocks()
    orgPrisma.workspace.findUnique.mockResolvedValue({ id: 'ws-1', organizationId: 'org-1' })
    credentials.issue.mockResolvedValue({
      credential: {
        id: 'cred-1',
        name: '备份 Key',
        keyPrefix: 'geo_ab12',
        lastUsedAt: null,
        scopes: ['*'],
        revokedAt: null,
      },
      plaintext: 'geo_once_plaintext',
    })

    const result = await service.issueCredential('org-1', 'ws-1', '备份 Key', 'user-1')

    expect(credentials.issue).toHaveBeenCalledWith('ws-1', '备份 Key', 'user-1')
    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'user-1',
      actorType: 'USER',
      action: 'credential.issue',
      organizationId: 'org-1',
      workspaceId: 'ws-1',
      target: 'ApiCredential:cred-1',
    })
    expect(result.plaintext).toBe('geo_once_plaintext')
    expect(result.credential).not.toHaveProperty('keyHash')
  })
})

// ---------------------------------------------------------------------------
// P1 遗留 2b：identity listUsers 加 organizationId 过滤（平台按企业查客户账号）
// ---------------------------------------------------------------------------

function makeIdentityService() {
  const identityPrisma = {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    organization: { findUnique: vi.fn(), update: vi.fn() },
    workspace: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
    session: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  } as unknown as PrismaClient & Record<string, Record<string, ReturnType<typeof vi.fn>>>
  const service = createIdentityService({
    prisma: identityPrisma,
    sessions: {
      create: vi.fn(async () => ({ token: 'tok-1', session: { id: 'sess-1' } })),
      resolve: vi.fn(),
      rotate: vi.fn(),
      revokeAllForUser: vi.fn(async () => 1),
      revokeByToken: vi.fn(async () => 1),
      purge: vi.fn(),
    } as never,
    audit: { record: vi.fn(async () => {}), list: vi.fn() } as never,
    loginRateLimiter: { check: vi.fn(() => true) } as never,
    members: {} as never,
  })
  return { identityPrisma, service }
}

describe('identity listUsers organizationId 过滤（P1 遗留 2b）', () => {
  it('传 organizationId → 只查该企业 CUSTOMER 用户', async () => {
    const { identityPrisma, service } = makeIdentityService()
    const customerItem = {
      id: 'user-9',
      username: 'member_a',
      displayName: '成员 A',
      platformRole: null,
      status: 'ACTIVE',
      mustChangePassword: false,
      lastLoginAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    }
    identityPrisma.user.findMany.mockResolvedValue([customerItem])
    identityPrisma.user.count.mockResolvedValue(1)

    const result = await service.listUsers({ organizationId: 'org-9' })

    const expectedWhere = { userType: 'CUSTOMER', organizationId: 'org-9' }
    expect(identityPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedWhere }),
    )
    expect(identityPrisma.user.count).toHaveBeenCalledWith({ where: expectedWhere })
    expect(result).toEqual({ items: [customerItem], total: 1 })
  })

  it('不传 organizationId → 维持 PLATFORM 用户列表语义不变', async () => {
    const { identityPrisma, service } = makeIdentityService()
    identityPrisma.user.findMany.mockResolvedValue([])
    identityPrisma.user.count.mockResolvedValue(0)

    await service.listUsers({})

    expect(identityPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userType: 'PLATFORM' } }),
    )
    expect(identityPrisma.user.count).toHaveBeenCalledWith({ where: { userType: 'PLATFORM' } })
  })
})
