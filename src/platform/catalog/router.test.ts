import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { PrismaClient, User } from '@prisma/client'
import { catalogRouter, adminCatalogRouter } from './router.js'
import { createCatalogService } from './service.js'
import {
  PLATFORM_ROLE_PERMISSIONS,
  router as trpcRouter,
  platformProcedure,
} from '../../core/trpc/init.js'

const NOW = new Date('2026-10-15T08:00:00.000Z')

function makeUser(overrides: Record<string, unknown> = {}): User {
  return {
    id: 'admin-1',
    username: 'root',
    displayName: '平台管理员',
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

function makePrisma() {
  return {
    product: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    productPlan: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  } as unknown as PrismaClient & Record<string, Record<string, ReturnType<typeof vi.fn>>>
}

function makeAudit() {
  return {
    record: vi.fn(async () => {}),
    list: vi.fn(),
  }
}

let prisma: ReturnType<typeof makePrisma>
let audit: ReturnType<typeof makeAudit>

beforeEach(() => {
  prisma = makePrisma()
  audit = makeAudit()
})

/** 组装真实 catalog service（mock prisma + mock audit）：
 *  权限矩阵断言需穿透 router 触达 service/prisma 调用形状。 */
function buildService() {
  return createCatalogService({ prisma, audit: audit as any })
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    actor: {
      kind: 'user',
      user: makeUser(),
      session: { id: 'sess-1' },
    },
    requestMeta: {
      ip: '1.2.3.4',
      requestId: 'req-1',
      method: 'POST',
      headers: { 'x-geo-csrf': 'test' },
    },
    services: { catalog: buildService() },
    ...overrides,
  } as any
}

/** 按平台角色构造 ctx（默认 SUPER_ADMIN 基线） */
function ctxWithPlatformRole(platformRole: string | null, overrides: Record<string, unknown> = {}) {
  return makeCtx({
    actor: {
      kind: 'user',
      user: makeUser({ platformRole }),
      session: { id: 'sess-1' },
    },
    ...overrides,
  })
}

function productRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prod-1',
    code: 'geo-pro',
    name: 'GEO 专业版',
    kind: 'SUBSCRIPTION',
    description: '按年订阅',
    active: true,
    createdAt: NOW,
    updatedAt: NOW,
    plans: [],
    ...overrides,
  }
}

function planRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'plan-1',
    productId: 'prod-1',
    name: '年付版',
    priceCents: 120000,
    billingPeriod: 'YEAR',
    entitlements: { maxWorkspaces: 3, maxQueries: 10000 },
    deliverables: [],
    active: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

/** Product 完整行（含 plans，include 形状） */
function productWithPlans(plans: Record<string, unknown>[], overrides: Record<string, unknown> = {}) {
  return productRow({ plans, ...overrides })
}

describe('PLATFORM_ROLE_PERMISSIONS：P2 §2.2 逐字', () => {
  it('SUPER_ADMIN 通配', () => {
    expect(PLATFORM_ROLE_PERMISSIONS.SUPER_ADMIN).toEqual(['*'])
  })

  it('OPERATOR = P0 原有 4 项 + 追加 order.view/order.manage（原有值不动）', () => {
    expect(PLATFORM_ROLE_PERMISSIONS.OPERATOR).toEqual([
      'workspace.manage',
      'workspace.enter',
      'credential.write',
      'audit.view',
      'order.view',
      'order.manage',
    ])
  })

  it('FINANCE = order.view/payment.confirm/refund.manage/invoice.manage', () => {
    expect(PLATFORM_ROLE_PERMISSIONS.FINANCE).toEqual([
      'order.view',
      'payment.confirm',
      'refund.manage',
      'invoice.manage',
    ])
  })

  it('SUPPORT = order.view', () => {
    expect(PLATFORM_ROLE_PERMISSIONS.SUPPORT).toEqual(['order.view'])
  })
})

/**
 * 新权限点行为探针：admin.orders.list 等 orders 域端点于任务 3 落地，
 * 此处以同语义 platformProcedure(<perm>) 探针路由验证 §2.2 放行/拒绝行为
 * （FINANCE 调 order.view 门禁端点 → 放行，即简报「admin.orders.list → 放行」用例）。
 */
const probeRouter = trpcRouter({
  orderView: platformProcedure('order.view').query(() => ({ ok: true })),
  orderManage: platformProcedure('order.manage').query(() => ({ ok: true })),
  paymentConfirm: platformProcedure('payment.confirm').query(() => ({ ok: true })),
  refundManage: platformProcedure('refund.manage').query(() => ({ ok: true })),
  invoiceManage: platformProcedure('invoice.manage').query(() => ({ ok: true })),
  catalogManage: platformProcedure('catalog.manage').query(() => ({ ok: true })),
})

/** 探针入口：按 userType + platformRole 构造 actor（probe 均为 query，无需 csrf/method） */
async function probe(
  userType: 'PLATFORM' | 'CUSTOMER',
  platformRole: string | null,
  proc: 'orderView' | 'orderManage' | 'paymentConfirm' | 'refundManage' | 'invoiceManage' | 'catalogManage',
): Promise<string> {
  const caller = probeRouter.createCaller(
    ctxWithPlatformRole(platformRole, {
      actor: {
        kind: 'user',
        user: makeUser({ userType, platformRole }),
        session: { id: 'sess-1' },
      },
    }),
  )
  try {
    const res = await caller[proc]()
    return res.ok ? 'ok' : 'UNEXPECTED'
  } catch (err) {
    return (err as { code?: string }).code ?? 'ERROR'
  }
}

describe('新权限点行为矩阵（platformProcedure 探针）', () => {
  it.each([
    // SUPER_ADMIN '*' 通配一切
    ['PLATFORM', 'SUPER_ADMIN', 'orderView', 'ok'],
    ['PLATFORM', 'SUPER_ADMIN', 'orderManage', 'ok'],
    ['PLATFORM', 'SUPER_ADMIN', 'paymentConfirm', 'ok'],
    ['PLATFORM', 'SUPER_ADMIN', 'refundManage', 'ok'],
    ['PLATFORM', 'SUPER_ADMIN', 'invoiceManage', 'ok'],
    ['PLATFORM', 'SUPER_ADMIN', 'catalogManage', 'ok'],
    // OPERATOR：新增订单运维两项，无 catalog/支付/退款/发票
    ['PLATFORM', 'OPERATOR', 'orderView', 'ok'],
    ['PLATFORM', 'OPERATOR', 'orderManage', 'ok'],
    ['PLATFORM', 'OPERATOR', 'catalogManage', 'FORBIDDEN'],
    ['PLATFORM', 'OPERATOR', 'paymentConfirm', 'FORBIDDEN'],
    ['PLATFORM', 'OPERATOR', 'refundManage', 'FORBIDDEN'],
    ['PLATFORM', 'OPERATOR', 'invoiceManage', 'FORBIDDEN'],
    // FINANCE：只读订单 + 支付确认/退款/发票，无订单管理与目录管理
    ['PLATFORM', 'FINANCE', 'orderView', 'ok'],
    ['PLATFORM', 'FINANCE', 'paymentConfirm', 'ok'],
    ['PLATFORM', 'FINANCE', 'refundManage', 'ok'],
    ['PLATFORM', 'FINANCE', 'invoiceManage', 'ok'],
    ['PLATFORM', 'FINANCE', 'orderManage', 'FORBIDDEN'],
    ['PLATFORM', 'FINANCE', 'catalogManage', 'FORBIDDEN'],
    // SUPPORT：仅只读订单
    ['PLATFORM', 'SUPPORT', 'orderView', 'ok'],
    ['PLATFORM', 'SUPPORT', 'orderManage', 'FORBIDDEN'],
    ['PLATFORM', 'SUPPORT', 'paymentConfirm', 'FORBIDDEN'],
    ['PLATFORM', 'SUPPORT', 'catalogManage', 'FORBIDDEN'],
    // 客户用户（userType=CUSTOMER、无平台角色）：一切平台门禁拒绝
    ['CUSTOMER', null, 'orderView', 'FORBIDDEN'],
    ['CUSTOMER', null, 'catalogManage', 'FORBIDDEN'],
    // PLATFORM 用户但 platformRole 为空（角色被清空的异常态，无权限表可查）：同样全拒
    ['PLATFORM', null, 'orderView', 'FORBIDDEN'],
  ])('%s × %s × %s → %s', async (userType, role, proc, expected) => {
    expect(await probe(userType as 'PLATFORM' | 'CUSTOMER', role as string | null, proc as any)).toBe(
      expected,
    )
  })
})

describe('adminCatalogRouter：权限矩阵（platformProcedure(catalog.manage)）', () => {
  it('OPERATOR 调 product.create → FORBIDDEN（简报用例），不触达 prisma', async () => {
    const caller = adminCatalogRouter.createCaller(ctxWithPlatformRole('OPERATOR'))
    await expect(
      caller.product.create({ code: 'geo-pro', name: 'GEO 专业版', kind: 'SUBSCRIPTION' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(prisma.product.create).not.toHaveBeenCalled()
  })

  it('FINANCE / SUPPORT 调 catalog 管理端点 → FORBIDDEN', async () => {
    for (const role of ['FINANCE', 'SUPPORT']) {
      const caller = adminCatalogRouter.createCaller(ctxWithPlatformRole(role))
      await expect(
        caller.product.create({ code: 'geo-pro', name: 'GEO 专业版', kind: 'SUBSCRIPTION' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(
        caller.plan.create({
          productId: 'prod-1',
          name: '年付版',
          priceCents: 120000,
          entitlements: {},
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    expect(prisma.product.create).not.toHaveBeenCalled()
    expect(prisma.productPlan.create).not.toHaveBeenCalled()
  })

  it('客户用户（无 platformRole）→ FORBIDDEN', async () => {
    const caller = adminCatalogRouter.createCaller(
      ctxWithPlatformRole(null, {
        actor: {
          kind: 'user',
          user: makeUser({
            userType: 'CUSTOMER',
            platformRole: null,
            organizationId: 'org-1',
            orgRole: 'ORG_OWNER',
          }),
          session: { id: 'sess-1' },
        },
      }),
    )
    await expect(
      caller.product.create({ code: 'geo-pro', name: 'GEO 专业版', kind: 'SUBSCRIPTION' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('未登录（anonymous actor）→ UNAUTHORIZED', async () => {
    const caller = adminCatalogRouter.createCaller(
      makeCtx({ actor: { kind: 'anonymous' }, services: undefined }),
    )
    await expect(
      caller.product.create({ code: 'geo-pro', name: 'GEO 专业版', kind: 'SUBSCRIPTION' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('mutation 缺 x-geo-csrf 请求头 → FORBIDDEN（csrf 守卫先于权限判定）', async () => {
    const caller = adminCatalogRouter.createCaller(
      ctxWithPlatformRole('SUPER_ADMIN', {
        requestMeta: {
          ip: '1.2.3.4',
          requestId: 'req-1',
          method: 'POST',
          headers: {},
        },
      }),
    )
    await expect(
      caller.product.create({ code: 'geo-pro', name: 'GEO 专业版', kind: 'SUBSCRIPTION' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(prisma.product.create).not.toHaveBeenCalled()
  })

  it('SUPER_ADMIN：product.create 放行并触达 service/prisma', async () => {
    prisma.product.create.mockResolvedValue(productRow())
    const caller = adminCatalogRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))
    const result = await caller.product.create({
      code: 'geo-pro',
      name: 'GEO 专业版',
      kind: 'SUBSCRIPTION',
    })
    expect(prisma.product.create).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ id: 'prod-1', code: 'geo-pro' })
  })
})

describe('admin.catalog.product.list：后台全量目录（含 inactive，任务 15 审查修复）', () => {
  it('SUPER_ADMIN：返回含 inactive 产品与 plans 的 AdminView 投影（下架条目可再上架）', async () => {
    prisma.product.findMany.mockResolvedValue([
      productWithPlans([
        planRow(),
        planRow({ id: 'plan-off', active: false, name: '已下架套餐' }),
      ]),
      productRow({ id: 'prod-off', code: 'geo-lite', name: 'GEO 轻量版', active: false }),
    ])
    const caller = adminCatalogRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))

    const result = await caller.product.list()

    // 后台视角不过滤 active：where 恒空对象（无 q 时）
    expect(prisma.product.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: 'asc' },
      include: { plans: true },
    })
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({ id: 'prod-1', active: true })
    expect(result.items[0].plans.map((p) => p.id)).toEqual(['plan-1', 'plan-off'])
    expect(result.items[0].plans[1]).toMatchObject({ id: 'plan-off', active: false })
    expect(result.items[1]).toMatchObject({ id: 'prod-off', active: false, plans: [] })
  })

  it('q 过滤透传 where（code/name contains）', async () => {
    prisma.product.findMany.mockResolvedValue([])
    const caller = adminCatalogRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))

    await caller.product.list({ q: 'geo' })

    expect(prisma.product.findMany).toHaveBeenCalledWith({
      where: { OR: [{ code: { contains: 'geo' } }, { name: { contains: 'geo' } }] },
      orderBy: { createdAt: 'asc' },
      include: { plans: true },
    })
  })

  it('OPERATOR（无 catalog.manage）→ FORBIDDEN，不触达 prisma（简报权限用例）', async () => {
    const caller = adminCatalogRouter.createCaller(ctxWithPlatformRole('OPERATOR'))
    await expect(caller.product.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(prisma.product.findMany).not.toHaveBeenCalled()
  })
})

describe('catalogRouter.list（Ruling 7：authedProcedure，登录即可见目录）', () => {
  it('客户用户可调：仅返回 active 产品 + active plans 投影（含 entitlements）', async () => {
    prisma.product.findMany.mockResolvedValue([
      productWithPlans([
        planRow(),
        planRow({ id: 'plan-off', active: false, name: '已下架套餐' }),
      ]),
    ])
    const caller = catalogRouter.createCaller(
      makeCtx({
        actor: {
          kind: 'user',
          user: makeUser({
            userType: 'CUSTOMER',
            platformRole: null,
            organizationId: 'org-1',
            orgRole: 'ORG_MEMBER',
          }),
          session: { id: 'sess-1' },
        },
        requestMeta: {
          ip: '1.2.3.4',
          requestId: 'req-1',
          method: 'GET',
          headers: {},
        },
      }),
    )

    const result = await caller.list()

    expect(prisma.product.findMany).toHaveBeenCalledWith({
      where: { active: true },
      orderBy: { createdAt: 'asc' },
      include: { plans: { where: { active: true }, orderBy: { createdAt: 'asc' } } },
    })
    expect(result).toEqual({
      items: [
        {
          id: 'prod-1',
          code: 'geo-pro',
          name: 'GEO 专业版',
          kind: 'SUBSCRIPTION',
          description: '按年订阅',
          plans: [
            {
              id: 'plan-1',
              name: '年付版',
              priceCents: 120000,
              billingPeriod: 'YEAR',
              entitlements: { maxWorkspaces: 3, maxQueries: 10000 },
              deliverables: [],
            },
          ],
        },
      ],
    })
  })

  it('无参调用与 kind 过滤：kind 透传 where（SERVICE ADDON 售卖页分类）', async () => {
    prisma.product.findMany.mockResolvedValue([])
    const caller = catalogRouter.createCaller(
      makeCtx({
        requestMeta: {
          ip: '1.2.3.4',
          requestId: 'req-1',
          method: 'GET',
          headers: {},
        },
      }),
    )

    await caller.list()
    await caller.list({ kind: 'SERVICE' })

    expect(prisma.product.findMany).toHaveBeenNthCalledWith(1, {
      where: { active: true },
      orderBy: { createdAt: 'asc' },
      include: { plans: { where: { active: true }, orderBy: { createdAt: 'asc' } } },
    })
    expect(prisma.product.findMany).toHaveBeenNthCalledWith(2, {
      where: { active: true, kind: 'SERVICE' },
      orderBy: { createdAt: 'asc' },
      include: { plans: { where: { active: true }, orderBy: { createdAt: 'asc' } } },
    })
  })

  it('未登录 → UNAUTHORIZED', async () => {
    const caller = catalogRouter.createCaller(
      makeCtx({
        actor: { kind: 'anonymous' },
        services: undefined,
        requestMeta: { ip: '1.2.3.4', requestId: 'req-1', method: 'GET', headers: {} },
      }),
    )
    await expect(caller.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })
})

describe('service：createProduct', () => {
  it('落库（description 缺省空串）+ audit catalog.product.create（actorType=USER，照 workspace-admin 惯例）', async () => {
    prisma.product.create.mockResolvedValue(productRow())
    const service = buildService()

    const result = await service.createProduct(
      { code: 'geo-pro', name: 'GEO 专业版', kind: 'SUBSCRIPTION' },
      'admin-1',
    )

    expect(prisma.product.create).toHaveBeenCalledWith({
      data: {
        code: 'geo-pro',
        name: 'GEO 专业版',
        kind: 'SUBSCRIPTION',
        description: '',
      },
    })
    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'admin-1',
      actorType: 'USER',
      action: 'catalog.product.create',
      target: 'Product:prod-1',
      diff: { code: 'geo-pro', name: 'GEO 专业版', kind: 'SUBSCRIPTION' },
    })
    expect(result).toMatchObject({ id: 'prod-1', code: 'geo-pro', active: true, plans: [] })
  })

  it('code 冲突（prisma P2002）→ ProductCodeConflictError，路由层 CONFLICT，不审计', async () => {
    prisma.product.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    )
    const caller = adminCatalogRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))

    await expect(
      caller.product.create({ code: 'geo-pro', name: 'GEO 专业版', kind: 'SUBSCRIPTION' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('kind 非法值 → zod 拒绝，不触达 prisma', async () => {
    const caller = adminCatalogRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))
    await expect(
      caller.product.create({ code: 'geo-pro', name: 'GEO 专业版', kind: 'GOODS' as any }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(prisma.product.create).not.toHaveBeenCalled()
  })
})

describe('service：updateProduct / setProductActive', () => {
  it('update：仅变更字段落库 + audit catalog.product.update（diff=变更字段名数组）', async () => {
    prisma.product.findUnique.mockResolvedValue(productRow())
    prisma.product.update.mockResolvedValue(
      productRow({ name: 'GEO 专业版（新）', description: '新版描述' }),
    )
    const service = buildService()

    const result = await service.updateProduct(
      'prod-1',
      { name: 'GEO 专业版（新）', description: '新版描述' },
      'admin-1',
    )

    expect(prisma.product.update).toHaveBeenCalledWith({
      where: { id: 'prod-1' },
      data: { name: 'GEO 专业版（新）', description: '新版描述' },
      include: { plans: true },
    })
    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'admin-1',
      actorType: 'USER',
      action: 'catalog.product.update',
      target: 'Product:prod-1',
      diff: ['name', 'description'],
    })
    expect(result).toMatchObject({ id: 'prod-1', name: 'GEO 专业版（新）' })
  })

  it('update：仅传 id（全字段缺省）→ 短路返回当前行，不执行空 update 不记 diff:[] 审计（遗留 C11）', async () => {
    prisma.product.findUnique.mockResolvedValue(productWithPlans([planRow()]))
    const service = buildService()

    const result = await service.updateProduct('prod-1', {}, 'admin-1')

    expect(prisma.product.update).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
    expect(result).toMatchObject({ id: 'prod-1', code: 'geo-pro', active: true, plans: [{ id: 'plan-1' }] })
  })

  it('update：商品不存在 → ProductNotFoundError → 路由层 NOT_FOUND，不写库不审计', async () => {
    prisma.product.findUnique.mockResolvedValue(null)
    const caller = adminCatalogRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))

    await expect(
      caller.product.update({ productId: 'prod-x', name: '新名' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(prisma.product.update).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('setProductActive(false)：下架落库 + audit catalog.product.set_active（diff={active}）', async () => {
    prisma.product.findUnique.mockResolvedValue(productRow())
    prisma.product.update.mockResolvedValue(productRow({ active: false }))
    const service = buildService()

    const result = await service.setProductActive('prod-1', false, 'admin-1')

    expect(prisma.product.update).toHaveBeenCalledWith({
      where: { id: 'prod-1' },
      data: { active: false },
      include: { plans: true },
    })
    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'admin-1',
      actorType: 'USER',
      action: 'catalog.product.set_active',
      target: 'Product:prod-1',
      diff: { active: false },
    })
    expect(result).toMatchObject({ id: 'prod-1', active: false })
  })

  it('下架后 catalog.list 不返回：listActive where 恒 active=true（简报用例）', async () => {
    prisma.product.findMany.mockResolvedValue([])
    const service = buildService()

    // 先下架（service 层语义钉住：setProductActive(false) 之后 listActive 的查询条件）
    prisma.product.findUnique.mockResolvedValue(productRow())
    prisma.product.update.mockResolvedValue(productRow({ active: false }))
    await service.setProductActive('prod-1', false, 'admin-1')

    await service.listActive()

    const where = (prisma.product.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where
    expect(where).toEqual({ active: true })
  })
})

describe('service：createPlan', () => {
  it('整数分落库原样 + entitlements/deliverables 透传 + audit catalog.plan.create', async () => {
    prisma.product.findUnique.mockResolvedValue(productRow())
    prisma.productPlan.create.mockResolvedValue(planRow())
    const service = buildService()

    const result = await service.createPlan(
      'prod-1',
      {
        name: '年付版',
        priceCents: 120000,
        billingPeriod: 'YEAR',
        entitlements: { maxWorkspaces: 3, maxQueries: 10000 },
      },
      'admin-1',
    )

    expect(prisma.productPlan.create).toHaveBeenCalledWith({
      data: {
        productId: 'prod-1',
        name: '年付版',
        priceCents: 120000,
        billingPeriod: 'YEAR',
        entitlements: { maxWorkspaces: 3, maxQueries: 10000 },
        deliverables: [],
      },
    })
    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'admin-1',
      actorType: 'USER',
      action: 'catalog.plan.create',
      target: 'ProductPlan:plan-1',
      diff: { productId: 'prod-1', name: '年付版', priceCents: 120000, billingPeriod: 'YEAR' },
    })
    expect(result).toMatchObject({ id: 'plan-1', priceCents: 120000, active: true })
  })

  it('priceCents 非整数（分必须为整数）→ zod 拒绝，不触达 prisma（plan 金额整数分用例）', async () => {
    const caller = adminCatalogRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))
    await expect(
      caller.plan.create({
        productId: 'prod-1',
        name: '年付版',
        priceCents: 199.5,
        entitlements: {},
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(prisma.productPlan.create).not.toHaveBeenCalled()
  })

  it('priceCents 负数 → zod 拒绝', async () => {
    const caller = adminCatalogRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))
    await expect(
      caller.plan.create({
        productId: 'prod-1',
        name: '年付版',
        priceCents: -1,
        entitlements: {},
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(prisma.productPlan.create).not.toHaveBeenCalled()
  })

  it('所属商品不存在 → NOT_FOUND，不建 plan 不审计', async () => {
    prisma.product.findUnique.mockResolvedValue(null)
    const caller = adminCatalogRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))

    await expect(
      caller.plan.create({
        productId: 'prod-x',
        name: '年付版',
        priceCents: 120000,
        entitlements: {},
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(prisma.productPlan.create).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('一次性套餐（billingPeriod 缺省）→ 落库 null', async () => {
    prisma.product.findUnique.mockResolvedValue(productRow())
    prisma.productPlan.create.mockResolvedValue(planRow({ billingPeriod: null }))
    const service = buildService()

    await service.createPlan(
      'prod-1',
      { name: '一次性实施', priceCents: 500000, entitlements: { onboarding: true } },
      'admin-1',
    )

    expect(prisma.productPlan.create).toHaveBeenCalledWith({
      data: {
        productId: 'prod-1',
        name: '一次性实施',
        priceCents: 500000,
        billingPeriod: null,
        entitlements: { onboarding: true },
        deliverables: [],
      },
    })
  })
})

describe('service：updatePlan / setPlanActive', () => {
  it('update：变更字段落库 + audit catalog.plan.update（diff=变更字段名数组）', async () => {
    prisma.productPlan.findUnique.mockResolvedValue(planRow())
    prisma.productPlan.update.mockResolvedValue(planRow({ priceCents: 99000 }))
    const caller = adminCatalogRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))

    const result = await caller.plan.update({ planId: 'plan-1', priceCents: 99000 })

    expect(prisma.productPlan.update).toHaveBeenCalledWith({
      where: { id: 'plan-1' },
      data: { priceCents: 99000 },
    })
    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'admin-1',
      actorType: 'USER',
      action: 'catalog.plan.update',
      target: 'ProductPlan:plan-1',
      diff: ['priceCents'],
    })
    expect(result).toMatchObject({ id: 'plan-1', priceCents: 99000 })
  })

  it('update：billingPeriod 传 null 清除（年付 → 一次性）', async () => {
    prisma.productPlan.findUnique.mockResolvedValue(planRow())
    prisma.productPlan.update.mockResolvedValue(planRow({ billingPeriod: null }))
    const caller = adminCatalogRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))

    await caller.plan.update({ planId: 'plan-1', billingPeriod: null })

    expect(prisma.productPlan.update).toHaveBeenCalledWith({
      where: { id: 'plan-1' },
      data: { billingPeriod: null },
    })
  })

  it('update：仅传 planId（全字段缺省）→ 短路返回当前行，不执行空 update 不记 diff:[] 审计（遗留 C11）', async () => {
    prisma.productPlan.findUnique.mockResolvedValue(planRow())
    const caller = adminCatalogRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))

    const result = await caller.plan.update({ planId: 'plan-1' })

    expect(prisma.productPlan.update).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
    expect(result).toMatchObject({ id: 'plan-1', priceCents: 120000 })
  })

  it('update：plan 不存在 → NOT_FOUND，不写库不审计', async () => {
    prisma.productPlan.findUnique.mockResolvedValue(null)
    const caller = adminCatalogRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))

    await expect(caller.plan.update({ planId: 'plan-x', name: '新名' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(prisma.productPlan.update).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('setPlanActive(false)：audit catalog.plan.set_active（diff={active}）', async () => {
    prisma.productPlan.findUnique.mockResolvedValue(planRow())
    prisma.productPlan.update.mockResolvedValue(planRow({ active: false }))
    const caller = adminCatalogRouter.createCaller(ctxWithPlatformRole('SUPER_ADMIN'))

    const result = await caller.plan.setActive({ planId: 'plan-1', active: false })

    expect(prisma.productPlan.update).toHaveBeenCalledWith({
      where: { id: 'plan-1' },
      data: { active: false },
    })
    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'admin-1',
      actorType: 'USER',
      action: 'catalog.plan.set_active',
      target: 'ProductPlan:plan-1',
      diff: { active: false },
    })
    expect(result).toMatchObject({ id: 'plan-1', active: false })
  })
})
