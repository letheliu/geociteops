import { describe, expect, it, vi } from 'vitest'
import { adminPaymentRouter } from '../src/platform/commerce/admin-payment-router.js'
import { createInvoiceService } from '../src/platform/commerce/invoice-service.js'
import { runOrderReconcile } from '../src/workers/billing-crons.js'
import type { User } from '@prisma/client'

// ---------------------------------------------------------------------------
// M2 §3.0 财务口径钉死（规格 §7「对账/发票」四条真实谓词）：
//
// 试用开通写的是一张 $0 零元单（paymentMethod=TRIAL、paidAt=null、COMPLETED）。
// 这四条断言的意义是：**零元试用单永远不进入任何财务口径**——
// 1. order.reconcile 的扫描谓词只取 PAID/FULFILLING，COMPLETED 的试用单不在其中；
// 2. 注册路径不产生任何 PaymentTransaction（04:30 对账无从扫起）；
// 3. 开票谓词是 paidAt <> NULL，试用单 paidAt=null → ORDER_NOT_PAID；
// 4. 平台收款工作台两视图按 method 分流（CREDIT = CONTRACT_CREDIT/PENDING），
//    TRIAL 既不是 CONTRACT_CREDIT 也没有流水行，天然不在任一视图内。
//
// 这四条不依赖数据库：全部用内存 mock prisma 打真实服务/路由。
// ---------------------------------------------------------------------------

const NOW = new Date('2026-10-18T06:00:00.000Z')
const DAY_MS = 86_400_000

function makePlatformUser(overrides: Record<string, unknown> = {}): User {
  return {
    id: 'admin-1',
    username: 'admin',
    displayName: 'Admin',
    email: null,
    phone: null,
    passwordHash: 'x',
    userType: 'PLATFORM',
    platformRole: 'FINANCE',
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

function platformCtx(prisma: unknown) {
  return {
    actor: { kind: 'user', user: makePlatformUser(), session: { id: 'sess-1' } },
    requestMeta: {
      ip: '1.2.3.4',
      requestId: 'req-1',
      method: 'GET',
      headers: { 'x-geo-csrf': 'test' },
    },
    services: { prisma },
  } as any
}

/** 试用开通写入的那张零元单（形状照 registration-service 落库字段） */
function trialOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'o-trial',
    orderNo: 'GEO261018aaaaaaaa',
    organizationId: 'org-trial',
    status: 'COMPLETED',
    totalCents: 0,
    discountCents: 0,
    payableCents: 0,
    refundedCents: 0,
    currency: 'CNY',
    paymentMethod: 'TRIAL',
    paidAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

describe('M2 §3.0 零元试用单的财务口径', () => {
  it('① order.reconcile 的扫描谓词不含 TRIAL COMPLETED 单（三段扫描都取不到）', async () => {
    const trial = trialOrder()
    // 停留 2 小时 > 1 小时阈值，两段扫描都应命中这两张真实订单
    const longAgo = new Date(NOW.getTime() - 2 * 60 * 60 * 1000)
    const stalePaid = trialOrder({
      id: 'o-paid',
      orderNo: 'GEO261018bbbbbbbb',
      status: 'PAID',
      paidAt: longAgo,
      updatedAt: longAgo,
    })
    const staleFulfilling = trialOrder({
      id: 'o-fulfilling',
      orderNo: 'GEO261018cccccccc',
      status: 'FULFILLING',
      paidAt: longAgo,
      updatedAt: longAgo,
    })
    const orders = [trial, stalePaid, staleFulfilling]

    function matches(order: Record<string, unknown>, where: any): boolean {
      if (where?.status !== undefined && order.status !== where.status) return false
      if (where?.paidAt?.lt !== undefined) {
        const paidAt = order.paidAt as Date | null
        if (!paidAt || !(paidAt < where.paidAt.lt)) return false
      }
      if (where?.updatedAt?.lt !== undefined) {
        const updatedAt = order.updatedAt as Date
        if (!(updatedAt < where.updatedAt.lt)) return false
      }
      return true
    }

    const prisma: any = {
      order: {
        findMany: vi.fn(async ({ where }: any) => orders.filter((o) => matches(o, where))),
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      // 账期扫描按 method=CONTRACT_CREDIT 取流水；试用单没有流水行
      paymentTransaction: { findMany: vi.fn(async () => []) },
      subscription: { updateMany: vi.fn(async () => ({ count: 0 })) },
      workspace: { updateMany: vi.fn(async () => ({ count: 0 })), findMany: vi.fn(async () => []) },
      serviceDelivery: { findFirst: vi.fn(async () => null) },
      orderEvent: { create: vi.fn(async () => ({})) },
    }
    const audit = { record: vi.fn(async () => {}), list: vi.fn(async () => ({ items: [], total: 0 })) }
    const log = { warn: vi.fn(), error: vi.fn() } as any

    const result = await runOrderReconcile({ prisma, audit, logger: log, now: () => NOW })

    // 扫描谓词：PAID 走 paidAt<FULFILLING 走 updatedAt，试用单 status=COMPLETED 两段都取不到
    const scannedStatuses = prisma.order.findMany.mock.calls.map((c: any[]) => c[0].where.status)
    expect(new Set(scannedStatuses)).toEqual(new Set(['PAID', 'FULFILLING']))
    expect(prisma.paymentTransaction.findMany.mock.calls[0][0].where).toMatchObject({
      method: 'CONTRACT_CREDIT',
      status: 'PENDING',
    })

    const touchedTargets = audit.record.mock.calls.map((c: any[]) => c[0].target)
    expect(touchedTargets).not.toContain('Order:o-trial')
    expect(result.paidStalled).toBe(1)
    expect(result.fulfillingStalled).toBe(1)
  })

  it('② 注册路径不产生 PaymentTransaction：由 registration-service.test.ts 的"零残留 + 未触达收款"断言承担', () => {
    // 本文件只覆盖需要真实服务/路由的三条；第 2 条（注册不写收款流水）在
    // src/platform/identity/registration-service.test.ts 中以 mock prisma 的
    // paymentTransaction.create 未被调用来钉死（mock 里没有该方法，任何调用都会抛）。
    expect(typeof runOrderReconcile).toBe('function')
  })

  it('③ org.invoices.request：paidAt=null 的 TRIAL 单抛 ORDER_NOT_PAID', async () => {
    const prisma: any = {
      order: {
        findMany: vi.fn(async () => [
          { id: 'o-trial', organizationId: 'org-trial', status: 'COMPLETED', paidAt: null, payableCents: 0 },
          { id: 'o-paid', organizationId: 'org-trial', status: 'COMPLETED', paidAt: NOW, payableCents: 10000 },
        ]),
      },
      invoice: { create: vi.fn(async (args: any) => ({ id: 'inv-1', ...args.data })), count: vi.fn(async () => 0) },
      organization: { findUnique: vi.fn(async () => ({ id: 'org-trial', billingProfile: {} })) },
    }
    const service = createInvoiceService({ prisma, audit: { record: vi.fn(async () => {}) } as any })

    await expect(
      service.request({ orderIds: ['o-trial'] }, 'user-1', 'org-trial'),
    ).rejects.toMatchObject({ name: 'ORDER_NOT_PAID' })
    expect(prisma.invoice.create).not.toHaveBeenCalled()

    // 同批混入已支付单时，违规列表只含试用单
    await expect(
      service.request({ orderIds: ['o-paid', 'o-trial'] }, 'user-1', 'org-trial'),
    ).rejects.toMatchObject({ name: 'ORDER_NOT_PAID', orderIds: ['o-trial'] })
  })

  it('④ admin.payments 两视图谓词均不含 TRIAL（CREDIT = CONTRACT_CREDIT/PENDING）', async () => {
    const findMany = vi.fn(async () => [])
    const count = vi.fn(async () => 0)
    const prisma: any = { paymentTransaction: { findMany, count } }
    const caller = adminPaymentRouter.createCaller(platformCtx(prisma))

    await caller.list({ view: 'CREDIT' })
    const creditWhere = findMany.mock.calls[0][0].where
    expect(creditWhere).toEqual({ method: 'CONTRACT_CREDIT', status: 'PENDING' })
    expect(creditWhere.method).not.toBe('TRIAL')

    await caller.list({ view: 'VOUCHER' })
    expect(findMany.mock.calls[1][0].where).toEqual({ method: 'BANK_TRANSFER', status: 'PENDING' })
  })
})
