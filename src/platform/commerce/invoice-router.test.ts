import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { PrismaClient, User } from '@prisma/client'
import { PLATFORM_ROLE_PERMISSIONS } from '../../core/trpc/init.js'
import { appRouter } from '../../router.js'
import { orgInvoicesRouter, adminInvoicesRouter } from './invoice-router.js'
import { createInvoiceService } from './invoice-service.js'
import type { FilesService } from './files.js'

/**
 * 任务 13：发票路由（客户侧 org.invoices.* 与平台侧 admin.invoices.*）。
 * 模式照 refund-router.test.ts：子树 createCaller + mock ctx，services 注入
 * 真实 InvoiceService（建在 mock prisma 上）——权限矩阵 / 越权 / 审计断言
 * 穿透 router 触达 service 逻辑。
 */

const NOW = new Date('2026-10-15T12:00:00.000Z')

const BILLING_PROFILE = {
  title: '杭州某某科技有限公司',
  taxNo: '91330100MA27X8888X',
}

function makeUser(overrides: Record<string, unknown> = {}): User {
  return {
    id: 'user-1',
    username: 'owner',
    displayName: '企业所有者',
    email: null,
    phone: null,
    passwordHash: 'x',
    userType: 'CUSTOMER',
    platformRole: null,
    organizationId: 'org-1',
    orgRole: 'ORG_OWNER',
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

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    orderNo: 'GEO261015ab12cd34',
    organizationId: 'org-1',
    status: 'COMPLETED',
    totalCents: 30000,
    discountCents: 0,
    payableCents: 30000,
    refundedCents: 0,
    currency: 'CNY',
    paymentMethod: 'WECHAT',
    dueAt: null,
    paidAt: new Date('2026-10-05T12:00:00.000Z'),
    remark: null,
    createdAt: new Date('2026-10-05T12:00:00.000Z'),
    updatedAt: new Date('2026-10-05T12:00:00.000Z'),
    ...overrides,
  }
}

function makeOrg(overrides: Record<string, unknown> = {}) {
  return {
    id: 'org-1',
    name: '杭州某某科技有限公司',
    creditCode: '91330100MA27X8888X',
    industry: null,
    status: 'ACTIVE',
    billingProfile: BILLING_PROFILE,
    ownerOperatorId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function makeInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    organizationId: 'org-1',
    orderIds: ['order-1'],
    titleSnapshot: BILLING_PROFILE,
    amountCents: 30000,
    currency: 'CNY',
    status: 'PENDING',
    invoiceNo: null,
    fileKey: null,
    requestedById: 'user-1',
    issuedById: null,
    remark: null,
    createdAt: new Date('2026-10-15T10:00:00.000Z'),
    updatedAt: new Date('2026-10-15T10:00:00.000Z'),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// mock prisma + 真实 InvoiceService + mock files / audit
// ---------------------------------------------------------------------------

function makePrisma() {
  // updateMany 落库回读模拟（配合 C12 事务后回读语义）：按 id 记录已应用 data，
  // findUnique(id) 合并返回"更新后"的行
  const applied = new Map<string, Record<string, unknown>>()
  const prisma: any = {
    order: {
      findMany: vi.fn(async () => [makeOrder()]),
    },
    organization: {
      findUnique: vi.fn(async () => makeOrg()),
    },
    invoice: {
      // where.invoiceNo → 唯一预查（默认无冲突）；where.id → 发票行读取（默认 inv-1/PENDING）
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.invoiceNo !== undefined) return null
        const base = makeInvoice()
        const overlay = applied.get(String(where.id))
        return overlay ? { ...base, ...overlay } : base
      }),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'inv-new-1',
        createdAt: NOW,
        updatedAt: NOW,
        ...data,
      })),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string }
          data: Record<string, unknown>
        }) => {
          applied.set(where.id, { ...(applied.get(where.id) ?? {}), ...data })
          return { count: 1 }
        },
      ),
    },
  }
  return prisma as PrismaClient & any
}

function makeFiles() {
  return {
    put: vi.fn(async () => '0123456789abcdef0123456789abcdef.pdf'),
    remove: vi.fn(async () => {}),
    resolvePath: vi.fn(),
  }
}

function makeAudit() {
  return { record: vi.fn(async () => {}), list: vi.fn() }
}

let prisma: ReturnType<typeof makePrisma>
let files: ReturnType<typeof makeFiles>
let audit: ReturnType<typeof makeAudit>

beforeEach(() => {
  prisma = makePrisma()
  files = makeFiles()
  audit = makeAudit()
})

function buildInvoiceService() {
  return createInvoiceService({
    prisma,
    files: files as unknown as FilesService,
    audit: audit as never,
  })
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
    services: { prisma, invoices: buildInvoiceService(), audit },
    ...overrides,
  } as any
}

/** 按企业角色构造客户用户 ctx（organizationId 默认 org-1） */
function ctxWithOrgRole(orgRole: string | null) {
  return makeCtx({
    actor: { kind: 'user', user: makeUser({ orgRole }), session: { id: 'sess-1' } },
  })
}

/** 按平台角色构造平台员工 ctx（无企业挂靠） */
function ctxWithPlatformRole(platformRole: string | null) {
  return makeCtx({
    actor: {
      kind: 'user',
      user: makeUser({
        id: 'fin-1',
        username: 'finance',
        userType: 'PLATFORM',
        platformRole,
        organizationId: null,
        orgRole: null,
      }),
      session: { id: 'sess-1' },
    },
  })
}

// ---------------------------------------------------------------------------
// 权限常量表（§2.2）
// ---------------------------------------------------------------------------

describe('PLATFORM_ROLE_PERMISSIONS：invoice.manage 归属', () => {
  it('FINANCE 含 invoice.manage；OPERATOR/SUPPORT 无', () => {
    expect(PLATFORM_ROLE_PERMISSIONS.FINANCE).toContain('invoice.manage')
    expect(PLATFORM_ROLE_PERMISSIONS.OPERATOR).not.toContain('invoice.manage')
    expect(PLATFORM_ROLE_PERMISSIONS.SUPPORT).not.toContain('invoice.manage')
  })
})

// ---------------------------------------------------------------------------
// org.invoices.*：任意客户角色（orgProcedure() 无权限点）
// ---------------------------------------------------------------------------

describe('orgInvoicesRouter（orgProcedure()：任意客户角色可看可申请）', () => {
  it('ORG_OWNER 申请：本企业已支付订单 → PENDING 发票行 + audit invoice.request（service 层）', async () => {
    const caller = orgInvoicesRouter.createCaller(makeCtx())

    const result = await caller.request({ orderIds: ['order-1'] })

    expect(prisma.invoice.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-1',
        orderIds: ['order-1'],
        amountCents: 30000,
        status: 'PENDING',
        requestedById: 'user-1',
      }),
    })
    expect(result.invoice).toMatchObject({ status: 'PENDING' })
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'invoice.request', actorId: 'user-1', organizationId: 'org-1' }),
    )
  })

  it('ORG_MEMBER / ORG_VIEWER 均可 list 与 request（任意客户角色）', async () => {
    const member = orgInvoicesRouter.createCaller(ctxWithOrgRole('ORG_MEMBER'))
    const viewer = orgInvoicesRouter.createCaller(ctxWithOrgRole('ORG_VIEWER'))

    await expect(member.list()).resolves.toMatchObject({ total: 0 })
    await expect(viewer.list()).resolves.toMatchObject({ total: 0 })
    prisma.order.findMany.mockResolvedValue([makeOrder()])
    await expect(member.request({ orderIds: ['order-1'] })).resolves.toBeTruthy()
    await expect(viewer.request({ orderIds: ['order-1'] })).resolves.toBeTruthy()
  })

  it('平台账号（userType=PLATFORM）调 org.invoices.list → FORBIDDEN', async () => {
    const caller = orgInvoicesRouter.createCaller(ctxWithPlatformRole('FINANCE'))
    await expect(caller.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('越权：org-1 成员申请 org-2 订单 → BAD_REQUEST（OrderNotPaidError 映射），不建行', async () => {
    prisma.order.findMany.mockResolvedValue([makeOrder({ id: 'order-9', organizationId: 'org-2' })])
    const caller = orgInvoicesRouter.createCaller(makeCtx())

    await expect(caller.request({ orderIds: ['order-9'] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(prisma.invoice.create).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('未支付订单申请 → BAD_REQUEST，不建行', async () => {
    prisma.order.findMany.mockResolvedValue([makeOrder({ paidAt: null })])
    const caller = orgInvoicesRouter.createCaller(makeCtx())

    await expect(caller.request({ orderIds: ['order-1'] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(prisma.invoice.create).not.toHaveBeenCalled()
  })

  it('orderIds 空数组被 zod 物理拒绝（min 1）', async () => {
    const caller = orgInvoicesRouter.createCaller(makeCtx())
    await expect(caller.request({ orderIds: [] })).rejects.toThrow()
    expect(prisma.order.findMany).not.toHaveBeenCalled()
  })

  it('list：仅本企业 + status 筛选 + 分页；行含 fileKey 与 fileUrl（前端拼 /files/{fileKey}）', async () => {
    prisma.invoice.findMany.mockResolvedValue([
      makeInvoice({
        status: 'ISSUED',
        invoiceNo: 'INV-1',
        fileKey: '0123456789abcdef0123456789abcdef.pdf',
      }),
      makeInvoice({ id: 'inv-2' }),
    ])
    prisma.invoice.count.mockResolvedValue(2)
    const caller = orgInvoicesRouter.createCaller(makeCtx())

    const result = await caller.list({ page: 1, pageSize: 20 })

    expect(prisma.invoice.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      orderBy: { createdAt: 'desc' },
      skip: 0,
      take: 20,
    })
    expect(result.total).toBe(2)
    expect(result.items[0]).toMatchObject({
      id: 'inv-1',
      status: 'ISSUED',
      fileKey: '0123456789abcdef0123456789abcdef.pdf',
      fileUrl: '/files/0123456789abcdef0123456789abcdef.pdf',
    })
    expect(result.items[1].fileUrl).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// admin.invoices.*：platformProcedure('invoice.manage') 权限矩阵
// ---------------------------------------------------------------------------

describe('adminInvoicesRouter：权限矩阵（platformProcedure(invoice.manage)）', () => {
  it('OPERATOR 调 list / issue / reject → FORBIDDEN（资金域），不触 service/prisma', async () => {
    const caller = adminInvoicesRouter.createCaller(ctxWithPlatformRole('OPERATOR'))
    await expect(caller.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      caller.issue({ invoiceId: 'inv-1', invoiceNo: 'INV-1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      caller.reject({ invoiceId: 'inv-1', reason: 'x' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(prisma.invoice.findMany).not.toHaveBeenCalled()
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('SUPPORT 调 list → FORBIDDEN（仅 order.view）', async () => {
    const caller = adminInvoicesRouter.createCaller(ctxWithPlatformRole('SUPPORT'))
    await expect(caller.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('客户账号（无平台角色）调 issue → FORBIDDEN', async () => {
    const caller = adminInvoicesRouter.createCaller(makeCtx())
    await expect(
      caller.issue({ invoiceId: 'inv-1', invoiceNo: 'INV-1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('adminInvoicesRouter.list / issue / reject（FINANCE 放行）', () => {
  it('FINANCE list：全企业待处理列表 + status 筛选 + 分页 + fileUrl 投影', async () => {
    prisma.invoice.findMany.mockResolvedValue([
      makeInvoice({ organizationId: 'org-2', status: 'PENDING' }),
    ])
    prisma.invoice.count.mockResolvedValue(1)
    const caller = adminInvoicesRouter.createCaller(ctxWithPlatformRole('FINANCE'))

    const result = await caller.list({ status: 'PENDING', page: 1, pageSize: 20 })

    expect(prisma.invoice.findMany).toHaveBeenCalledWith({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      skip: 0,
      take: 20,
    })
    expect(result.total).toBe(1)
    expect(result.items[0]).toMatchObject({ organizationId: 'org-2', status: 'PENDING' })
  })

  it('FINANCE issue 含 PDF：files.put → fileKey + ISSUED + audit invoice.issue（service 层）', async () => {
    const contentBase64 = Buffer.from('%PDF-1.4 fake invoice', 'utf8').toString('base64')
    const caller = adminInvoicesRouter.createCaller(ctxWithPlatformRole('FINANCE'))

    const result = await caller.issue({
      invoiceId: 'inv-1',
      invoiceNo: 'INV-20261015-001',
      fileName: '发票.pdf',
      contentBase64,
    })

    expect(files.put).toHaveBeenCalledTimes(1)
    expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: 'inv-1', status: 'PENDING' },
      data: {
        status: 'ISSUED',
        invoiceNo: 'INV-20261015-001',
        fileKey: '0123456789abcdef0123456789abcdef.pdf',
        issuedById: 'fin-1',
      },
    })
    expect(result.invoice).toMatchObject({
      status: 'ISSUED',
      invoiceNo: 'INV-20261015-001',
      fileUrl: '/files/0123456789abcdef0123456789abcdef.pdf',
    })
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'invoice.issue', actorId: 'fin-1', organizationId: 'org-1' }),
    )
  })

  it('invoiceNo 冲突 → CONFLICT（InvoiceNoConflictError 映射）', async () => {
    prisma.invoice.findUnique.mockImplementation(async ({ where }: never) =>
      where?.invoiceNo !== undefined
        ? makeInvoice({ id: 'inv-other', status: 'ISSUED', invoiceNo: 'INV-20261015-001' })
        : makeInvoice(),
    )
    const caller = adminInvoicesRouter.createCaller(ctxWithPlatformRole('FINANCE'))

    await expect(
      caller.issue({ invoiceId: 'inv-1', invoiceNo: 'INV-20261015-001' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('FINANCE reject：REJECTED + remark', async () => {
    const caller = adminInvoicesRouter.createCaller(ctxWithPlatformRole('FINANCE'))

    const result = await caller.reject({ invoiceId: 'inv-1', reason: '抬头信息不全' })

    expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: 'inv-1', status: 'PENDING' },
      data: { status: 'REJECTED', remark: '抬头信息不全' },
    })
    expect(result.invoice).toMatchObject({ status: 'REJECTED', remark: '抬头信息不全' })
  })

  it('发票不存在 → NOT_FOUND（InvoiceNotFoundError 映射）', async () => {
    prisma.invoice.findUnique.mockResolvedValue(null)
    const caller = adminInvoicesRouter.createCaller(ctxWithPlatformRole('FINANCE'))
    await expect(
      caller.reject({ invoiceId: 'inv-x', reason: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

// ---------------------------------------------------------------------------
// appRouter 挂载冒烟：org.invoices.* 与 admin.invoices.* 端点可达
// ---------------------------------------------------------------------------

describe('appRouter 挂载冒烟', () => {
  it('客户侧 org.invoices.list 与平台侧 admin.invoices.list 经 appRouter 可达（services 注入生效）', async () => {
    prisma.invoice.findMany.mockResolvedValue([])
    prisma.invoice.count.mockResolvedValue(0)

    const orgCaller = appRouter.createCaller(makeCtx())
    await expect(orgCaller.org.invoices.list()).resolves.toEqual({ items: [], total: 0 })

    const adminCaller = appRouter.createCaller(ctxWithPlatformRole('FINANCE'))
    await expect(adminCaller.admin.invoices.list()).resolves.toEqual({ items: [], total: 0 })
  })

  it('org 子树展开不丢既有端点：org.workspaces.list 仍经 appRouter 可达', async () => {
    // 展开挂载（...orgRouter._def.procedures）后 org.* 原有子树须原样保留；
    // org service 以 mock 注入（避免惰性默认触碰真实 prisma/主密钥）
    const orgService = { listWorkspaces: vi.fn(async () => ({ items: [], total: 0 })) }
    const ctx = makeCtx({
      services: { prisma, invoices: buildInvoiceService(), audit, org: orgService },
    })
    const orgCaller = appRouter.createCaller(ctx)
    await expect(orgCaller.org.workspaces.list()).resolves.toEqual({ items: [], total: 0 })
    expect(orgService.listWorkspaces).toHaveBeenCalledWith('org-1', undefined)
  })
})
