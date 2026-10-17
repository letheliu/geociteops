import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  CREDIT_OVERDUE_SUSPEND_REASON,
  createOrderService,
} from '../platform/commerce/order-service.js'
import {
  addBillingPeriod,
  addMonthsClamped,
  createOrderActivateWorker,
  initialMilestones,
  startOrderActivateWorker,
  SUBSCRIPTION_EXPIRED_SUSPEND_REASON,
  SUBSCRIPTION_EXTEND_MARKER_EVENT,
} from './order-activate.js'
import {
  BILLING_CRON_QUEUES,
  ORDER_EXPIRE_CRON,
  ORDER_RECONCILE_CRON,
  SUBSCRIPTION_EXPIRE_CHECK_CRON,
  runOrderExpire,
  runOrderReconcile,
  startBillingCrons,
} from './billing-crons.js'
import { runExpireCheck } from '../platform/billing/subscription-service.js'

// ---------------------------------------------------------------------------
// 测试基建：内存版 prisma（照 order-service.test.ts 的 mock 模式扩展——
// 唯一约束（P2002）/ 乐观并发 updateMany / 关系过滤均按真实驱动语义实现子集）
// ---------------------------------------------------------------------------

const FIXED_NOW = () => new Date('2026-10-15T12:00:00.000Z')

function snapshot(
  kind: 'SUBSCRIPTION' | 'SERVICE' | 'ADDON',
  overrides: Record<string, unknown> = {},
) {
  return {
    name: kind === 'SUBSCRIPTION' ? '专业版' : kind === 'ADDON' ? '加购包' : 'SEO 优化服务',
    kind,
    priceCents: 10000,
    billingPeriod: kind === 'SUBSCRIPTION' ? 'MONTH' : null,
    entitlements: kind === 'ADDON' ? { maxQueries: 1000 } : { maxWorkspaces: 3 },
    deliverables: kind === 'SERVICE' ? [{ name: '站群诊断', days: 7 }, { name: '结构化数据部署' }] : [],
    ...overrides,
  }
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    orderId: 'o1',
    planId: 'plan-1',
    workspaceId: null,
    quantity: 1,
    unitPriceCents: 10000,
    planSnapshot: snapshot('SUBSCRIPTION'),
    ...overrides,
  }
}

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    orderNo: 'GEO261015ab12cd34',
    organizationId: 'org-1',
    status: 'PAID',
    totalCents: 10000,
    discountCents: 0,
    payableCents: 10000,
    refundedCents: 0,
    currency: 'CNY',
    paymentMethod: 'BANK_TRANSFER',
    dueAt: null,
    paidAt: new Date('2026-10-15T11:00:00.000Z'),
    remark: null,
    createdAt: new Date('2026-10-15T02:00:00.000Z'),
    updatedAt: new Date('2026-10-15T11:30:00.000Z'),
    ...overrides,
  }
}

function makeWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ws-1',
    name: '客户工作区',
    domain: null,
    llmsTxtUrl: null,
    defaultBrandName: '品牌',
    platformConfig: {},
    publicationConfig: {},
    status: 'ACTIVE',
    suspendReason: null,
    organizationId: 'org-1',
    archivedAt: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  }
}

function p2002(target: string[]) {
  return Object.assign(
    new Error(`Unique constraint failed on the fields: (${target.join(',')})`),
    { code: 'P2002', meta: { target } },
  )
}

function makeDb(
  fixtures: {
    order?: Record<string, any> | null
    items?: Record<string, any>[]
    subscriptions?: Record<string, any>[]
    deliveries?: Record<string, any>[]
    workspaces?: Record<string, any>[]
    org?: Record<string, any> | null
    payments?: Record<string, any>[]
    /** 预置 OrderEvent 行（如续费延长标记） */
    events?: Record<string, any>[]
    /** order.findMany 直接返回的陈旧列表（模拟扫描后状态竞态） */
    staleOrders?: Record<string, any>[]
    /** paymentTransaction.findMany 直接返回的列表 */
    stalePayments?: Record<string, any>[]
  } = {},
) {
  const orderRow = fixtures.order === undefined ? makeOrder() : fixtures.order
  const orgId = orderRow?.organizationId ?? 'org-1'
  const store = {
    orders: new Map<string, any>(orderRow ? [[orderRow.id, { ...orderRow }]] : []),
    items: new Map<string, any>(
      (fixtures.items ?? []).map((it, i) => [
        (it.id as string) ?? `item-${i + 1}`,
        { orderId: orderRow?.id ?? 'o1', ...it },
      ]),
    ),
    subscriptions: (fixtures.subscriptions ?? []).map((s) => ({ ...s })),
    deliveries: (fixtures.deliveries ?? []).map((d) => ({ ...d })),
    workspaces: (fixtures.workspaces ?? []).map((w) => ({ ...w })),
    payments: (fixtures.payments ?? []).map((p) => ({ ...p })),
    events: (fixtures.events ?? []).map((e) => ({
      createdAt: new Date('2026-10-15T11:00:00.000Z'),
      ...e,
    })),
    orgs: new Map<string, any>([
      [orgId, fixtures.org === undefined ? { id: orgId, name: 'Acme 公司' } : fixtures.org],
    ]),
  }
  let seq = 0
  const nextId = (prefix: string) => `${prefix}-${++seq}`

  const prisma: any = {
    order: {
      findUnique: vi.fn(async ({ where, include }: any) => {
        const o = store.orders.get(where.id)
        if (!o) return null
        return {
          ...o,
          ...(include?.items
            ? { items: [...store.items.values()].filter((i) => i.orderId === o.id) }
            : {}),
        }
      }),
      findMany: vi.fn(async ({ where, include }: any) => {
        if (fixtures.staleOrders) return [...fixtures.staleOrders]
        const rows = [...store.orders.values()].filter((o) => {
          if (where?.status !== undefined && o.status !== where.status) return false
          if (where?.updatedAt?.lt && !(o.updatedAt < where.updatedAt.lt)) return false
          if (where?.paidAt?.lt && !(o.paidAt != null && o.paidAt < where.paidAt.lt)) return false
          if (where?.createdAt?.lt && !(o.createdAt < where.createdAt.lt)) return false
          return true
        })
        // 遗留 E1：FULFILLING 停滞扫描 include items(+嵌套 include serviceDelivery)——
        // OrderItem 1:1 ServiceDelivery 关系 join（内存版按 store 物化）
        if (include?.items) {
          return rows.map((o) => ({
            ...o,
            items: [...store.items.values()]
              .filter((i) => i.orderId === o.id)
              .map((i) => ({
                ...i,
                ...(include.items.include?.serviceDelivery
                  ? {
                      serviceDelivery:
                        store.deliveries.find((d) => d.orderItemId === i.id) ?? null,
                    }
                  : {}),
              })),
          }))
        }
        return rows
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0
        for (const o of store.orders.values()) {
          if (where.id !== undefined && o.id !== where.id) continue
          if (where.status?.in && !where.status.in.includes(o.status)) continue
          Object.assign(o, data, { updatedAt: new Date('2026-10-15T12:00:01.000Z') })
          count += 1
        }
        return { count }
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const o = store.orders.get(where.id)
        Object.assign(o, data)
        return { ...o }
      }),
    },
    orderEvent: {
      create: vi.fn(async ({ data }: any) => {
        // 遗留 A3：OrderEvent(orderId, event) 部分唯一索引（WHERE event =
        // 'subscription.extend'，迁移 _tob_p2_order_event_extend_unique）——
        // 同单重复写延长标记 → P2002（其它事件名不受该索引约束）
        if (
          data.event === 'subscription.extend' &&
          store.events.some(
            (e) => e.orderId === data.orderId && e.event === 'subscription.extend',
          )
        ) {
          throw p2002(['orderId', 'event'])
        }
        const row = { id: nextId('evt'), createdAt: new Date(), ...data }
        store.events.push(row)
        return row
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const rows = store.events.filter(
          (e) =>
            (where?.orderId === undefined || e.orderId === where.orderId) &&
            (where?.event === undefined || e.event === where.event) &&
            (where?.toStatus === undefined || e.toStatus === where.toStatus),
        )
        return rows.length > 0 ? { ...rows[rows.length - 1] } : null
      }),
    },
    subscription: {
      findFirst: vi.fn(async ({ where }: any) => {
        const rows = store.subscriptions
          .filter(
            (s) =>
              (where.organizationId === undefined ||
                s.organizationId === where.organizationId) &&
              (where.planId === undefined || s.planId === where.planId) &&
              (where.id?.not === undefined || s.id !== where.id.not) &&
              // sourceOrderId 支持 { not: x }（旧账期暂停聚合判定）、{ notIn: [...] }
              // （遗留 E2：排除全部超期应收订单）与等值三种形态
              (where.sourceOrderId === undefined
                ? true
                : where.sourceOrderId !== null &&
                    typeof where.sourceOrderId === 'object' &&
                    'notIn' in where.sourceOrderId
                  ? !where.sourceOrderId.notIn.includes(s.sourceOrderId)
                  : typeof where.sourceOrderId === 'object' && 'not' in where.sourceOrderId
                    ? s.sourceOrderId !== (where.sourceOrderId as { not: string }).not
                    : s.sourceOrderId === where.sourceOrderId) &&
              (where.status?.in ? where.status.in.includes(s.status) : true) &&
              // 任务 11 ③ 聚合判定：OR: [{status,endAt.gt},{status}] 形状
              (where.OR
                ? where.OR.some(
                    (alt: any) =>
                      (alt.status === undefined || s.status === alt.status) &&
                      (alt.endAt?.gt === undefined || s.endAt > alt.endAt.gt),
                  )
                : true),
          )
          .sort((a, b) => b.endAt.getTime() - a.endAt.getTime())
        return rows[0] ? { ...rows[0] } : null
      }),
      // 任务 11：expire-check 扫描（status + endAt 区间，take 批量上限）
      findMany: vi.fn(async ({ where, take }: any) => {
        let rows = store.subscriptions.filter((s) => {
          if (where?.status !== undefined && s.status !== where.status) return false
          if (where?.endAt?.gt !== undefined && !(s.endAt > where.endAt.gt)) return false
          if (where?.endAt?.lte !== undefined && !(s.endAt <= where.endAt.lte)) return false
          return true
        })
        rows = [...rows].sort((a, b) => a.endAt.getTime() - b.endAt.getTime())
        if (take !== undefined) rows = rows.slice(0, take)
        return rows.map((r) => ({ ...r }))
      }),
      create: vi.fn(async ({ data }: any) => {
        // @@unique([sourceOrderId, planId])：同单同套餐重复建行 → P2002
        if (
          store.subscriptions.some(
            (s) => s.sourceOrderId === data.sourceOrderId && s.planId === data.planId,
          )
        ) {
          throw p2002(['sourceOrderId', 'planId'])
        }
        const row = { id: nextId('sub'), createdAt: new Date(), updatedAt: new Date(), ...data }
        store.subscriptions.push(row)
        return { ...row }
      }),
      // 任务 11：expire-check 逐条乐观迁移（where id+status 防并发丢 audit）
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0
        for (const s of store.subscriptions) {
          if (where?.id !== undefined && s.id !== where.id) continue
          if (where?.status !== undefined && s.status !== where.status) continue
          Object.assign(s, data, { updatedAt: new Date('2026-10-15T12:00:01.000Z') })
          count += 1
        }
        return { count }
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = store.subscriptions.find((s) => s.id === where.id)
        if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' })
        Object.assign(row, data, { updatedAt: new Date('2026-10-15T12:00:01.000Z') })
        return { ...row }
      }),
    },
    serviceDelivery: {
      create: vi.fn(async ({ data }: any) => {
        // orderItemId @unique：重复建交付单 → P2002
        if (store.deliveries.some((d) => d.orderItemId === data.orderItemId)) {
          throw p2002(['orderItemId'])
        }
        const row = {
          id: nextId('sd'),
          assigneeId: null,
          acceptedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        }
        store.deliveries.push(row)
        return { ...row }
      }),
      // 任务 11 ③/④：org 有效服务探测（status in + workspace.organizationId 关系）
      findFirst: vi.fn(async ({ where }: any) => {
        const rows = store.deliveries.filter((d) => {
          if (where?.status?.in && !where.status.in.includes(d.status)) return false
          if (where?.workspace?.organizationId !== undefined) {
            const ws = store.workspaces.find((w) => w.id === d.workspaceId)
            if (!ws || ws.organizationId !== where.workspace.organizationId) return false
          }
          return true
        })
        return rows[0] ? { ...rows[0] } : null
      }),
    },
    workspace: {
      findFirst: vi.fn(async ({ where }: any) => {
        let rows = store.workspaces.filter((w) => w.organizationId === where.organizationId)
        if (where.status !== undefined) rows = rows.filter((w) => w.status === where.status)
        const sorted = [...rows].sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
        )
        return sorted[0] ? { ...sorted[0] } : null
      }),
      // 任务 11 ④：孤儿恢复扫描（status + suspendReason 过滤）
      findMany: vi.fn(async ({ where, take }: any) => {
        let rows = store.workspaces.filter((w) => {
          if (where?.status !== undefined && w.status !== where.status) return false
          if (where?.suspendReason !== undefined && w.suspendReason !== where.suspendReason) return false
          return true
        })
        if (take !== undefined) rows = rows.slice(0, take)
        return rows.map((r) => ({ ...r }))
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: nextId('ws'),
          domain: null,
          llmsTxtUrl: null,
          platformConfig: {},
          publicationConfig: {},
          status: 'ACTIVE',
          suspendReason: null,
          archivedAt: null,
          createdAt: new Date('2026-10-15T12:00:01.000Z'),
          updatedAt: new Date('2026-10-15T12:00:01.000Z'),
          ...data,
        }
        store.workspaces.push(row)
        return { ...row }
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0
        for (const w of store.workspaces) {
          if (where.organizationId !== undefined && w.organizationId !== where.organizationId) continue
          if (where.status !== undefined && w.status !== where.status) continue
          if (where.suspendReason !== undefined && w.suspendReason !== where.suspendReason) continue
          Object.assign(w, data, { updatedAt: new Date('2026-10-15T12:00:01.000Z') })
          count += 1
        }
        return { count }
      }),
    },
    organization: {
      findUnique: vi.fn(async ({ where }: any) => store.orgs.get(where.id) ?? null),
    },
    paymentTransaction: {
      findMany: vi.fn(async ({ where, include }: any) => {
        if (fixtures.stalePayments) return [...fixtures.stalePayments]
        const rows = store.payments.filter((p) => {
          if (where.method !== undefined && p.method !== where.method) return false
          if (where.status !== undefined && p.status !== where.status) return false
          if (where.order?.dueAt?.lt) {
            const o = store.orders.get(p.orderId)
            if (!o || o.dueAt == null || !(o.dueAt < where.order.dueAt.lt)) return false
          }
          return true
        })
        // include: { order: true } 的关系 join
        return include?.order ? rows.map((p) => ({ ...p, order: store.orders.get(p.orderId) ?? null })) : rows
      }),
      // 终审 I1 闭环测试：confirmPayment 读流水（include order）+ 条件更新
      findUnique: vi.fn(async ({ where, include }: any) => {
        const p = store.payments.find((x) => x.id === where.id)
        if (!p) return null
        return include?.order
          ? { ...p, order: store.orders.get(p.orderId) ?? null }
          : { ...p }
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0
        for (const p of store.payments) {
          if (where.id !== undefined && p.id !== where.id) continue
          if (where.status !== undefined && p.status !== where.status) continue
          Object.assign(p, data)
          count += 1
        }
        return { count }
      }),
    },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  }
  return { prisma, store }
}

function makeHarness(db: ReturnType<typeof makeDb>) {
  const orders = createOrderService({ prisma: db.prisma, now: FIXED_NOW })
  const entitlements = { recompute: vi.fn(async () => ({})) }
  const audit = { record: vi.fn(async () => {}) }
  const worker = createOrderActivateWorker({
    prisma: db.prisma,
    orders,
    entitlements,
    audit,
    now: FIXED_NOW,
  })
  return { worker, orders, entitlements, audit }
}

// ---------------------------------------------------------------------------
// 周期计算（月末钳制）
// ---------------------------------------------------------------------------

describe('addMonthsClamped / addBillingPeriod', () => {
  it('普通月加：10-15 + 1mo = 11-15（时间分量保留）', () => {
    const out = addMonthsClamped(new Date('2026-10-15T12:00:00.000Z'), 1)
    expect(out).toEqual(new Date('2026-11-15T12:00:00.000Z'))
  })

  it('月末溢出钳制：1/31 + 1mo = 2/28（setMonth 裸加会跳 3/3）', () => {
    const out = addMonthsClamped(new Date('2026-01-31T09:30:00.000Z'), 1)
    expect(out).toEqual(new Date('2026-02-28T09:30:00.000Z'))
  })

  it('闰年：2028-02-29 + 12mo = 2029-02-28', () => {
    const out = addMonthsClamped(new Date('2028-02-29T00:00:00.000Z'), 12)
    expect(out).toEqual(new Date('2029-02-28T00:00:00.000Z'))
  })

  it('遗留 B6：UTC 边界——本地日期已翻月的时刻仍按 UTC 日计算（1/31T23:30Z + 1mo = 2/28T23:30Z）', () => {
    // 该时刻在东八区已是 2/1 本地：本地时间方法实现会把"原日"误读为 1 → 3/1；
    // UTC 实现取 UTC 日 31 → 钳制到 2 月末
    const out = addMonthsClamped(new Date('2026-01-31T23:30:00.000Z'), 1)
    expect(out).toEqual(new Date('2026-02-28T23:30:00.000Z'))
  })

  it('addBillingPeriod：MONTH +1 月 / YEAR +1 年 / 缺失按 +1 月（防御）', () => {
    const base = new Date('2026-10-15T12:00:00.000Z')
    expect(addBillingPeriod(base, 'MONTH')).toEqual(new Date('2026-11-15T12:00:00.000Z'))
    expect(addBillingPeriod(base, 'YEAR')).toEqual(new Date('2027-10-15T12:00:00.000Z'))
    expect(addBillingPeriod(base, null)).toEqual(new Date('2026-11-15T12:00:00.000Z'))
    expect(addBillingPeriod(base, undefined)).toEqual(new Date('2026-11-15T12:00:00.000Z'))
  })

  it('initialMilestones：deliverables 模板逐项附 status=PENDING；非数组归一空', () => {
    expect(initialMilestones([{ name: 'A' }, { name: 'B', days: 7 }])).toEqual([
      { name: 'A', status: 'PENDING' },
      { name: 'B', days: 7, status: 'PENDING' },
    ])
    expect(initialMilestones(null)).toEqual([])
    expect(initialMilestones('x')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 开通 worker：四步流程 + 幂等
// ---------------------------------------------------------------------------

describe('order.activate worker', () => {
  it('SUBSCRIPTION 新建：订阅行 + COMPLETED + recompute + 自动建首个 workspace', async () => {
    const db = makeDb({ items: [item()] })
    const h = makeHarness(db)

    const res = await h.worker.activateOrder('o1')

    expect(res.activated).toBe(true)
    // 无 SERVICE 行 → fulfill.complete（"订阅立即生效"）
    expect(db.store.orders.get('o1')!.status).toBe('COMPLETED')
    expect(db.store.events.map((e) => e.event)).toContain('activate.start')
    expect(db.store.events.map((e) => e.event)).toContain('fulfill.complete')
    // 订阅行：startAt=now、endAt=now+1mo、entitlements=快照
    expect(db.store.subscriptions).toHaveLength(1)
    expect(db.store.subscriptions[0]).toMatchObject({
      organizationId: 'org-1',
      planId: 'plan-1',
      sourceOrderId: 'o1',
      status: 'ACTIVE',
      entitlements: { maxWorkspaces: 3 },
    })
    expect(db.store.subscriptions[0].startAt).toEqual(new Date('2026-10-15T12:00:00.000Z'))
    expect(db.store.subscriptions[0].endAt).toEqual(new Date('2026-11-15T12:00:00.000Z'))
    // 配额重算被调（org 维度）
    expect(h.entitlements.recompute).toHaveBeenCalledTimes(1)
    expect(h.entitlements.recompute).toHaveBeenCalledWith('org-1')
    // 企业无 workspace → 自动创建首个（name/defaultBrandName 取 org.name）
    expect(db.store.workspaces).toHaveLength(1)
    expect(db.store.workspaces[0]).toMatchObject({
      name: 'Acme 公司',
      defaultBrandName: 'Acme 公司',
      organizationId: 'org-1',
      status: 'ACTIVE',
    })
    // audit：SYSTEM 主体 + 注明订单开通自动创建
    const wsCreate = h.audit.record.mock.calls.map((c) => c[0]).find((a) => a.action === 'workspace.create')
    expect(wsCreate).toMatchObject({
      actorType: 'SYSTEM',
      organizationId: 'org-1',
      diff: expect.objectContaining({ orderId: 'o1' }),
    })
    expect(JSON.stringify(wsCreate!.diff)).toContain('订单开通自动创建')
  })

  it('幂等：同 orderId 跑两遍——订阅恰 1 行、endAt 不二次延长、第二遍在入口闸返回（COMPLETED→already_processed）', async () => {
    const db = makeDb({ items: [item()] })
    const h = makeHarness(db)

    await h.worker.activateOrder('o1')
    const endAtFirst = db.store.subscriptions[0].endAt
    const res2 = await h.worker.activateOrder('o1')

    expect(res2).toEqual({ activated: false, reason: 'already_processed' })
    expect(db.store.subscriptions).toHaveLength(1)
    expect(db.store.subscriptions[0].endAt).toBe(endAtFirst)
    expect(db.store.workspaces).toHaveLength(1)
    expect(h.entitlements.recompute).toHaveBeenCalledTimes(1)
    expect(db.store.orders.get('o1')!.status).toBe('COMPLETED')
    // 第二遍在第一闸即返回：无任何新增事件
    expect(db.store.events.filter((e) => e.event === 'activate.start')).toHaveLength(1)
  })

  it('SUBSCRIPTION 复用延长：org+plan 已有未到期 ACTIVE 行 → endAt = 原 endAt + 周期，不新建', async () => {
    const db = makeDb({
      items: [item()],
      subscriptions: [
        {
          id: 'sub-old',
          organizationId: 'org-1',
          planId: 'plan-1',
          sourceOrderId: 'o0',
          startAt: new Date('2026-07-01T00:00:00.000Z'),
          endAt: new Date('2026-11-20T12:00:00.000Z'),
          status: 'ACTIVE',
          entitlements: { maxWorkspaces: 1 },
          createdAt: new Date('2026-07-01T00:00:00.000Z'),
          updatedAt: new Date('2026-07-01T00:00:00.000Z'),
        },
      ],
      workspaces: [makeWorkspace()],
    })
    const h = makeHarness(db)

    await h.worker.activateOrder('o1')

    expect(db.store.subscriptions).toHaveLength(1)
    const sub = db.store.subscriptions[0]
    expect(sub.id).toBe('sub-old')
    expect(sub.status).toBe('ACTIVE')
    // 原 endAt（未来）为基准顺延 1 月 = 2026-12-20
    expect(sub.endAt).toEqual(new Date('2026-12-20T12:00:00.000Z'))
    // 复用不覆盖既有配额快照
    expect(sub.entitlements).toEqual({ maxWorkspaces: 1 })
    expect(db.store.orders.get('o1')!.status).toBe('COMPLETED')
    // org 已有 workspace → 不自动创建
    expect(db.store.workspaces).toHaveLength(1)
  })

  it('GRACE 恢复：过期宽限行 → ACTIVE 且 endAt=now+周期；仅恢复 suspendReason=订阅到期 的 workspace', async () => {
    const db = makeDb({
      items: [item()],
      subscriptions: [
        {
          id: 'sub-grace',
          organizationId: 'org-1',
          planId: 'plan-1',
          sourceOrderId: 'o0',
          startAt: new Date('2026-07-01T00:00:00.000Z'),
          endAt: new Date('2026-10-01T00:00:00.000Z'),
          status: 'GRACE',
          entitlements: { maxWorkspaces: 1 },
          createdAt: new Date('2026-07-01T00:00:00.000Z'),
          updatedAt: new Date('2026-07-01T00:00:00.000Z'),
        },
      ],
      workspaces: [
        makeWorkspace({ id: 'ws-exp', name: '到期暂停', status: 'SUSPENDED', suspendReason: SUBSCRIPTION_EXPIRED_SUSPEND_REASON }),
        makeWorkspace({ id: 'ws-man', name: '其他原因暂停', status: 'SUSPENDED', suspendReason: '违规内容' }),
        makeWorkspace({ id: 'ws-credit', name: '账期暂停', status: 'SUSPENDED', suspendReason: '账期超期' }),
        makeWorkspace({ id: 'ws-ok', name: '正常', status: 'ACTIVE', suspendReason: null }),
      ],
    })
    const h = makeHarness(db)

    await h.worker.activateOrder('o1')

    const sub = db.store.subscriptions[0]
    expect(sub.id).toBe('sub-grace')
    expect(sub.status).toBe('ACTIVE')
    // GRACE 行 endAt <= now → 从当下起算：now + 1mo
    expect(sub.endAt).toEqual(new Date('2026-11-15T12:00:00.000Z'))
    // 恢复范围精确：仅 suspendReason='订阅到期'
    expect(db.store.workspaces.find((w) => w.id === 'ws-exp')).toMatchObject({
      status: 'ACTIVE',
      suspendReason: null,
    })
    expect(db.store.workspaces.find((w) => w.id === 'ws-man')!.status).toBe('SUSPENDED')
    expect(db.store.workspaces.find((w) => w.id === 'ws-credit')!.status).toBe('SUSPENDED')
    expect(db.store.workspaces.find((w) => w.id === 'ws-ok')!.status).toBe('ACTIVE')
  })

  it('端到端（任务 11 §6.4）：expire-check 暂停 → activateOrder 续费 → 订阅 ACTIVE 且 endAt 延长 + workspace 回 ACTIVE', async () => {
    // 长逾期 ACTIVE 订阅：单 run 内 ②→③ 迁到 EXPIRED 并暂停 org 全部 ACTIVE workspace
    const db = makeDb({
      items: [item()],
      subscriptions: [
        {
          id: 'sub-old',
          organizationId: 'org-1',
          planId: 'plan-1',
          sourceOrderId: 'o0',
          startAt: new Date('2026-08-01T00:00:00.000Z'),
          endAt: new Date('2026-09-01T00:00:00.000Z'),
          status: 'ACTIVE',
          entitlements: { maxWorkspaces: 1 },
          createdAt: new Date('2026-08-01T00:00:00.000Z'),
          updatedAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ],
      workspaces: [
        makeWorkspace({ id: 'ws-a' }),
        makeWorkspace({ id: 'ws-b', name: '第二个工作区' }),
      ],
    })
    const h = makeHarness(db)

    // 第一段：到期检查——ACTIVE→GRACE→EXPIRED + 两个 ACTIVE workspace 暂停（订阅到期）
    const expireResult = await runExpireCheck({ prisma: db.prisma, audit: h.audit, now: FIXED_NOW })
    expect(expireResult).toMatchObject({ enteredGrace: 1, expired: 1 })
    expect(db.store.subscriptions[0].status).toBe('EXPIRED')
    for (const ws of db.store.workspaces) {
      expect(ws).toMatchObject({ status: 'SUSPENDED', suspendReason: SUBSCRIPTION_EXPIRED_SUSPEND_REASON })
    }
    const expiredAudit = h.audit.record.mock.calls
      .map((c) => c[0])
      .find((a) => a.action === 'subscription.expired')
    expect(expiredAudit!.diff).toMatchObject({ subscriptionId: 'sub-old', workspaceSuspended: 2 })

    // 第二段：客户续费（PAID 订单走开通 worker）——EXPIRED 复用分支
    const res = await h.worker.activateOrder('o1')
    expect(res.activated).toBe(true)

    const sub = db.store.subscriptions[0]
    expect(sub.id).toBe('sub-old')
    expect(sub.status).toBe('ACTIVE')
    // 原 endAt（2026-09-01）已过 → 从当下起算：now + 1mo
    expect(sub.endAt).toEqual(new Date('2026-11-15T12:00:00.000Z'))
    // 仅恢复"订阅到期"暂停的 workspace（两个都因订阅到期暂停 → 都恢复）
    expect(db.store.workspaces.find((w) => w.id === 'ws-a')).toMatchObject({
      status: 'ACTIVE',
      suspendReason: null,
    })
    expect(db.store.workspaces.find((w) => w.id === 'ws-b')).toMatchObject({
      status: 'ACTIVE',
      suspendReason: null,
    })
    expect(db.store.orders.get('o1')!.status).toBe('COMPLETED')
    expect(h.entitlements.recompute).toHaveBeenCalledWith('org-1')
  })

  it('续费延长幂等标记（修复轮 2）：首跑延长一次并写 subscription.extend 标记（note 含 planId/新旧 endAt/周期）', async () => {
    const db = makeDb({
      items: [item()],
      subscriptions: [
        {
          id: 'sub-old',
          organizationId: 'org-1',
          planId: 'plan-1',
          sourceOrderId: 'o0',
          startAt: new Date('2026-07-01T00:00:00.000Z'),
          endAt: new Date('2026-11-20T12:00:00.000Z'),
          status: 'ACTIVE',
          entitlements: { maxWorkspaces: 1 },
          createdAt: new Date('2026-07-01T00:00:00.000Z'),
          updatedAt: new Date('2026-07-01T00:00:00.000Z'),
        },
      ],
      workspaces: [makeWorkspace()],
    })
    const h = makeHarness(db)

    await h.worker.activateOrder('o1')

    // 延长恰一次：原 endAt（未来）+ 1mo
    expect(db.store.subscriptions).toHaveLength(1)
    expect(db.store.subscriptions[0].endAt).toEqual(new Date('2026-12-20T12:00:00.000Z'))
    // 标记事件写入本单
    const markers = db.store.events.filter((e) => e.event === SUBSCRIPTION_EXTEND_MARKER_EVENT)
    expect(markers).toHaveLength(1)
    expect(markers[0]).toMatchObject({ orderId: 'o1', toStatus: 'FULFILLING' })
    expect(markers[0].note).toContain('plan-1')
    expect(markers[0].note).toContain('2026-11-20T12:00:00.000Z')
    expect(markers[0].note).toContain('2026-12-20T12:00:00.000Z')
    expect(markers[0].note).toContain('MONTH')
  })

  it('续费延长幂等标记：同单重入（标记已存在）→ endAt 不再延长，补走 fulfill.complete', async () => {
    const db = makeDb({
      // 首跑已应用延长（2026-11-20 → 2026-12-20）并写标记后崩溃，订单停留 FULFILLING
      order: makeOrder({ status: 'FULFILLING' }),
      items: [item()],
      subscriptions: [
        {
          id: 'sub-old',
          organizationId: 'org-1',
          planId: 'plan-1',
          sourceOrderId: 'o0',
          startAt: new Date('2026-07-01T00:00:00.000Z'),
          endAt: new Date('2026-12-20T12:00:00.000Z'),
          status: 'ACTIVE',
          entitlements: { maxWorkspaces: 1 },
          createdAt: new Date('2026-07-01T00:00:00.000Z'),
          updatedAt: new Date('2026-07-01T00:00:00.000Z'),
        },
      ],
      events: [
        { id: 'evt-marker', orderId: 'o1', event: SUBSCRIPTION_EXTEND_MARKER_EVENT, fromStatus: null, toStatus: 'FULFILLING', actorId: null, note: '续费延长（首跑）' },
      ],
      workspaces: [makeWorkspace()],
    })
    const h = makeHarness(db)

    const res = await h.worker.activateOrder('o1')

    expect(res.activated).toBe(true)
    // 标记闸拦截：endAt 不二次延长（不会变 2027-01-20）
    expect(db.store.subscriptions).toHaveLength(1)
    expect(db.store.subscriptions[0].endAt).toEqual(new Date('2026-12-20T12:00:00.000Z'))
    // 标记不重复写
    expect(db.store.events.filter((e) => e.event === SUBSCRIPTION_EXTEND_MARKER_EVENT)).toHaveLength(1)
    // 剩余流程补完：无 SERVICE → fulfill.complete
    expect(db.store.orders.get('o1')!.status).toBe('COMPLETED')
    expect(h.entitlements.recompute).toHaveBeenCalledWith('org-1')
  })

  it('并发双写兜底（遗留 A3）：双 worker 同过查询闸，第二次标记 create 撞 P2002 → 跳过不双延长', async () => {
    // 交错模拟：worker B 在 worker A 提交前完成全部读取（查询闸 + existing 订阅行）
    const db = makeDb({
      order: makeOrder({ status: 'FULFILLING' }),
      items: [item()],
      subscriptions: [
        {
          id: 'sub-old',
          organizationId: 'org-1',
          planId: 'plan-1',
          sourceOrderId: 'o0',
          startAt: new Date('2026-07-01T00:00:00.000Z'),
          endAt: new Date('2026-11-20T12:00:00.000Z'),
          status: 'ACTIVE',
          entitlements: { maxWorkspaces: 1 },
          createdAt: new Date('2026-07-01T00:00:00.000Z'),
          updatedAt: new Date('2026-07-01T00:00:00.000Z'),
        },
      ],
      workspaces: [makeWorkspace()],
    })
    const h = makeHarness(db)

    // 首跑（worker A）：延长 11-20 → 12-20 并写标记
    await h.worker.activateOrder('o1')
    expect(db.store.subscriptions[0].endAt).toEqual(new Date('2026-12-20T12:00:00.000Z'))
    expect(db.store.events.filter((e) => e.event === SUBSCRIPTION_EXTEND_MARKER_EVENT)).toHaveLength(1)

    // worker B 的读取均发生在 A 提交前：标记查询闸回 null（A 尚未提交）、
    // existing 订阅行仍是延长前快照（11-20）
    db.store.orders.get('o1')!.status = 'FULFILLING'
    db.store.subscriptions[0].endAt = new Date('2026-11-20T12:00:00.000Z')
    const originalFindFirst = db.prisma.orderEvent.findFirst.getMockImplementation()
    db.prisma.orderEvent.findFirst.mockImplementation(async (args: any) => {
      if (args?.where?.event === SUBSCRIPTION_EXTEND_MARKER_EVENT) return null
      return originalFindFirst?.(args) ?? null
    })

    // 次跑（worker B）：过查询闸 → 复算同一 newEndAt（12-20）→ 标记 create 撞
    // 部分唯一索引 P2002 → 整体回滚后视为已标记跳过——不抛错（不进 pg-boss 重试）
    const res = await h.worker.activateOrder('o1')

    expect(res.activated).toBe(true)
    // 第二次确实触达了 create（区别于查询闸拦截——闸已被 mock 旁路）
    const extendCreates = db.prisma.orderEvent.create.mock.calls.filter(
      ([{ data }]: [{ data: { event: string } }]) => data.event === SUBSCRIPTION_EXTEND_MARKER_EVENT,
    )
    expect(extendCreates).toHaveLength(2)
    // 标记仍恰一条（第二次被唯一索引拒绝）；endAt 不双延长（≠ 2027-01-20）
    expect(db.store.events.filter((e) => e.event === SUBSCRIPTION_EXTEND_MARKER_EVENT)).toHaveLength(1)
    expect(db.store.subscriptions[0].endAt).toEqual(new Date('2026-12-20T12:00:00.000Z'))
    // B 侧同前象计算（12-20），落库同值幂等；真实驱动下该 update 随事务回滚
  })

  it('混合行项（修复轮 2）：续费延长行 + 新购锚行（ADDON）+ SERVICE 互不干扰，重入全稳定', async () => {
    const db = makeDb({
      items: [
        // plan-1：org 已有他单 ACTIVE 行 → 走续费延长（标记闸路径）
        item({ id: 'item-1', planSnapshot: snapshot('SUBSCRIPTION') }),
        // plan-2：org 无既有行 → 新购锚路径（create + P2002）
        item({ id: 'item-2', planId: 'plan-2', planSnapshot: snapshot('ADDON') }),
        // 交付单：orderItemId unique 锚路径
        item({ id: 'item-3', planId: 'plan-svc', planSnapshot: snapshot('SERVICE') }),
      ],
      subscriptions: [
        {
          id: 'sub-old',
          organizationId: 'org-1',
          planId: 'plan-1',
          sourceOrderId: 'o0',
          startAt: new Date('2026-07-01T00:00:00.000Z'),
          endAt: new Date('2026-11-20T12:00:00.000Z'),
          status: 'ACTIVE',
          entitlements: { maxWorkspaces: 1 },
          createdAt: new Date('2026-07-01T00:00:00.000Z'),
          updatedAt: new Date('2026-07-01T00:00:00.000Z'),
        },
      ],
      workspaces: [makeWorkspace()],
    })
    const h = makeHarness(db)

    // 首跑：延长 plan-1（标记写入）+ 新建 plan-2 锚行 + 建交付单；含 SERVICE 停留 FULFILLING
    await h.worker.activateOrder('o1')
    expect(db.store.subscriptions).toHaveLength(2)
    expect(db.store.subscriptions.find((s) => s.planId === 'plan-1')!.endAt).toEqual(
      new Date('2026-12-20T12:00:00.000Z'),
    )
    expect(db.store.subscriptions.find((s) => s.planId === 'plan-2')!.endAt).toEqual(
      new Date('2027-10-15T12:00:00.000Z'),
    )
    expect(db.store.deliveries).toHaveLength(1)
    expect(db.store.events.filter((e) => e.event === SUBSCRIPTION_EXTEND_MARKER_EVENT)).toHaveLength(1)
    expect(db.store.orders.get('o1')!.status).toBe('FULFILLING')

    // 重入（FULFILLING 放行）：标记闸 + 两个 unique 锚各自拦截，全部稳定
    await h.worker.activateOrder('o1')
    expect(db.store.subscriptions).toHaveLength(2)
    expect(db.store.subscriptions.find((s) => s.planId === 'plan-1')!.endAt).toEqual(
      new Date('2026-12-20T12:00:00.000Z'),
    )
    expect(db.store.subscriptions.find((s) => s.planId === 'plan-2')!.endAt).toEqual(
      new Date('2027-10-15T12:00:00.000Z'),
    )
    expect(db.store.deliveries).toHaveLength(1)
    expect(db.store.events.filter((e) => e.event === SUBSCRIPTION_EXTEND_MARKER_EVENT)).toHaveLength(1)
    expect(db.store.orders.get('o1')!.status).toBe('FULFILLING')
  })

  it('SERVICE：交付单 PENDING_ASSIGN + 里程碑初始态 + audit 通知运营；订单停留 FULFILLING 不 complete', async () => {
    const db = makeDb({
      items: [item({ id: 'item-svc', planId: 'plan-svc', planSnapshot: snapshot('SERVICE') })],
      workspaces: [
        makeWorkspace({ id: 'ws-a', createdAt: new Date('2026-09-01T00:00:00.000Z') }),
        makeWorkspace({ id: 'ws-b', createdAt: new Date('2026-09-02T00:00:00.000Z') }),
      ],
    })
    const h = makeHarness(db)

    await h.worker.activateOrder('o1')

    expect(db.store.deliveries).toHaveLength(1)
    expect(db.store.deliveries[0]).toMatchObject({
      orderItemId: 'item-svc',
      workspaceId: 'ws-a', // org 第一个 ACTIVE workspace（createdAt 升序）
      status: 'PENDING_ASSIGN',
    })
    expect(db.store.deliveries[0].milestones).toEqual([
      { name: '站群诊断', days: 7, status: 'PENDING' },
      { name: '结构化数据部署', status: 'PENDING' },
    ])
    // 含 SERVICE 停留 FULFILLING（P4 里程碑验收后 complete）
    expect(db.store.orders.get('o1')!.status).toBe('FULFILLING')
    expect(db.store.events.map((e) => e.event)).not.toContain('fulfill.complete')
    // 通知运营 = 写 audit delivery.pending_assignment
    const alert = h.audit.record.mock.calls.map((c) => c[0]).find((a) => a.action === 'delivery.pending_assignment')
    expect(alert).toMatchObject({
      actorType: 'SYSTEM',
      organizationId: 'org-1',
      workspaceId: 'ws-a',
      target: 'OrderItem:item-svc',
    })
    expect(h.entitlements.recompute).toHaveBeenCalledWith('org-1')
  })

  it('SERVICE：item.workspaceId 优先于 org 默认；无可用 workspace 时 workspaceId=null（P4 分配）', async () => {
    const db = makeDb({
      items: [
        item({ id: 'item-svc', planSnapshot: snapshot('SERVICE'), workspaceId: 'ws-9' }),
      ],
      workspaces: [makeWorkspace({ id: 'ws-a' })],
    })
    const h = makeHarness(db)
    await h.worker.activateOrder('o1')
    expect(db.store.deliveries[0].workspaceId).toBe('ws-9')

    const db2 = makeDb({ items: [item({ id: 'item-svc', planSnapshot: snapshot('SERVICE') })] })
    const h2 = makeHarness(db2)
    await h2.worker.activateOrder('o1')
    expect(db2.store.deliveries[0].workspaceId).toBeNull()
    // SERVICE-only 订单不触发首个 workspace 自动创建
    expect(db2.store.workspaces).toHaveLength(0)
  })

  it('ADDON：增量 Subscription 行，无周期 +1 年；同单同套餐重复行被 unique 锚跳过', async () => {
    const db = makeDb({
      items: [
        item({ id: 'item-1', planSnapshot: snapshot('SUBSCRIPTION') }),
        item({ id: 'item-2', planId: 'plan-2', planSnapshot: snapshot('ADDON') }),
        // 同 planId 的第二个 ADDON 行 → (sourceOrderId, planId) 冲突即已处理
        item({ id: 'item-3', planId: 'plan-2', planSnapshot: snapshot('ADDON') }),
      ],
      workspaces: [makeWorkspace()],
    })
    const h = makeHarness(db)

    await h.worker.activateOrder('o1')

    expect(db.store.subscriptions).toHaveLength(2)
    const addon = db.store.subscriptions.find((s) => s.planId === 'plan-2')
    expect(addon).toMatchObject({
      organizationId: 'org-1',
      sourceOrderId: 'o1',
      status: 'ACTIVE',
      entitlements: { maxQueries: 1000 },
    })
    // 无周期 ADDON：+1 年
    expect(addon!.endAt).toEqual(new Date('2027-10-15T12:00:00.000Z'))
    expect(db.store.orders.get('o1')!.status).toBe('COMPLETED')
  })

  it('终审 C1 端到端：ADDON ×3 → 单行锚不变，容量数值 ×3 落 entitlements，allowedPlatforms 不乘', async () => {
    const db = makeDb({
      items: [
        item({
          id: 'item-1',
          planId: 'plan-2',
          quantity: 3,
          planSnapshot: snapshot('ADDON', {
            entitlements: {
              maxQueries: 1000,
              maxPages: 40,
              samplesPerRun: 5,
              allowedPlatforms: ['google', 'bing'],
              note: '文本字段不乘',
            },
          }),
        }),
      ],
      workspaces: [makeWorkspace()],
    })
    const h = makeHarness(db)

    await h.worker.activateOrder('o1')

    // 交付：恰 1 行 Subscription（单行锚 [sourceOrderId, planId] 不因数量拆行）
    expect(db.store.subscriptions).toHaveLength(1)
    const addon = db.store.subscriptions[0]
    expect(addon).toMatchObject({ planId: 'plan-2', sourceOrderId: 'o1', status: 'ACTIVE' })
    // quantity 语义体现在 entitlements 数值容量：CAPACITY_FIELDS ×3
    expect(addon.entitlements).toEqual({
      maxQueries: 3000,
      maxPages: 120,
      samplesPerRun: 15,
      // 集合字段不乘（平台集合仅来自订阅，§6.4）；未知/文本字段原样保留
      allowedPlatforms: ['google', 'bing'],
      note: '文本字段不乘',
    })
    // 重入幂等：unique 锚拦截，倍乘不叠加（不会变 ×6）
    await h.worker.activateOrder('o1')
    expect(db.store.subscriptions).toHaveLength(1)
    expect(db.store.subscriptions[0].entitlements.maxQueries).toBe(3000)
  })

  it('混合订单（SUB + SERVICE）：订阅与交付单都建，但不 fulfill.complete', async () => {
    const db = makeDb({
      items: [
        item({ id: 'item-1', planSnapshot: snapshot('SUBSCRIPTION') }),
        item({ id: 'item-2', planId: 'plan-svc', planSnapshot: snapshot('SERVICE') }),
      ],
      workspaces: [makeWorkspace()],
    })
    const h = makeHarness(db)

    await h.worker.activateOrder('o1')

    expect(db.store.orders.get('o1')!.status).toBe('FULFILLING')
    expect(db.store.subscriptions).toHaveLength(1)
    expect(db.store.deliveries).toHaveLength(1)
    expect(h.entitlements.recompute).toHaveBeenCalledWith('org-1')
  })

  it('SUBSCRIPTION 快照缺 billingPeriod（防御）：按 +1 月处理；YEAR 周期按 +1 年', async () => {
    const db = makeDb({
      items: [item({ planSnapshot: snapshot('SUBSCRIPTION', { billingPeriod: null }) })],
    })
    const h = makeHarness(db)
    await h.worker.activateOrder('o1')
    expect(db.store.subscriptions[0].endAt).toEqual(new Date('2026-11-15T12:00:00.000Z'))

    const db2 = makeDb({
      items: [item({ planSnapshot: snapshot('SUBSCRIPTION', { billingPeriod: 'YEAR' }) })],
    })
    const h2 = makeHarness(db2)
    await h2.worker.activateOrder('o1')
    expect(db2.store.subscriptions[0].endAt).toEqual(new Date('2027-10-15T12:00:00.000Z'))
  })

  it('非 PAID 订单（已取消）在入口闸直接返回，不产生任何副作用', async () => {
    const db = makeDb({ order: makeOrder({ status: 'CANCELLED' }), items: [item()] })
    const h = makeHarness(db)

    const res = await h.worker.activateOrder('o1')

    expect(res).toEqual({ activated: false, reason: 'already_processed' })
    expect(db.store.subscriptions).toHaveLength(0)
    expect(db.store.workspaces).toHaveLength(0)
    expect(h.entitlements.recompute).not.toHaveBeenCalled()
    expect(db.store.orders.get('o1')!.status).toBe('CANCELLED')
  })

  it('账期路径（Critical 修复）：credit.open 先迁移 FULFILLING 再入队 → 照常开通 + complete', async () => {
    const db = makeDb({
      order: makeOrder({ status: 'FULFILLING', paymentMethod: 'CONTRACT_CREDIT' }),
      items: [item()],
    })
    const h = makeHarness(db)

    const res = await h.worker.activateOrder('o1')

    expect(res.activated).toBe(true)
    expect(db.store.subscriptions).toHaveLength(1)
    expect(db.store.subscriptions[0]).toMatchObject({
      sourceOrderId: 'o1',
      status: 'ACTIVE',
      endAt: new Date('2026-11-15T12:00:00.000Z'),
    })
    // FULFILLING → COMPLETED（fulfill.complete）
    expect(db.store.orders.get('o1')!.status).toBe('COMPLETED')
    expect(db.store.events.map((e) => e.event)).toContain('fulfill.complete')
    expect(h.entitlements.recompute).toHaveBeenCalledWith('org-1')
    expect(db.store.workspaces).toHaveLength(1)
  })

  it('崩溃重入（Critical 修复）：首跑已建锚行/部分行项后停留 FULFILLING → 补完剩余且 endAt 不二次延长', async () => {
    const db = makeDb({
      order: makeOrder({ status: 'FULFILLING' }),
      items: [
        item({ id: 'item-1', planSnapshot: snapshot('SUBSCRIPTION') }),
        item({ id: 'item-2', planId: 'plan-svc', planSnapshot: snapshot('SERVICE') }),
      ],
      // 首跑已处理：订阅锚行（sourceOrderId=o1）已建、交付单未建即崩溃
      subscriptions: [
        {
          id: 'sub-1',
          organizationId: 'org-1',
          planId: 'plan-1',
          sourceOrderId: 'o1',
          startAt: new Date('2026-10-15T12:00:00.000Z'),
          endAt: new Date('2026-11-15T12:00:00.000Z'),
          status: 'ACTIVE',
          entitlements: { maxWorkspaces: 3 },
          createdAt: new Date('2026-10-15T12:00:00.000Z'),
          updatedAt: new Date('2026-10-15T12:00:00.000Z'),
        },
      ],
      workspaces: [makeWorkspace()],
    })
    const h = makeHarness(db)

    const res = await h.worker.activateOrder('o1')

    expect(res.activated).toBe(true)
    // 锚行跳过：恰 1 行、endAt 不二次延长（不会变 2026-12-15）
    expect(db.store.subscriptions).toHaveLength(1)
    expect(db.store.subscriptions[0].endAt).toEqual(new Date('2026-11-15T12:00:00.000Z'))
    expect(db.store.subscriptions[0].id).toBe('sub-1')
    // 剩余行项补完：交付单本次创建
    expect(db.store.deliveries).toHaveLength(1)
    expect(db.store.deliveries[0]).toMatchObject({ orderItemId: 'item-2', workspaceId: 'ws-1' })
    // 含 SERVICE 停留 FULFILLING；recompute 正常执行
    expect(db.store.orders.get('o1')!.status).toBe('FULFILLING')
    expect(h.entitlements.recompute).toHaveBeenCalledWith('org-1')
  })

  it('重复投递（已 COMPLETED）：入口闸返回 already_processed，零副作用', async () => {
    const db = makeDb({ order: makeOrder({ status: 'COMPLETED' }), items: [item()] })
    const h = makeHarness(db)

    const res = await h.worker.activateOrder('o1')

    expect(res).toEqual({ activated: false, reason: 'already_processed' })
    expect(db.store.subscriptions).toHaveLength(0)
    expect(h.entitlements.recompute).not.toHaveBeenCalled()
  })

  it('混合订单（SUB+SERVICE）首购企业：首个 workspace 先确保，交付单自动归属（非 null）', async () => {
    const db = makeDb({
      items: [
        item({ id: 'item-1', planSnapshot: snapshot('SUBSCRIPTION') }),
        item({ id: 'item-2', planId: 'plan-svc', planSnapshot: snapshot('SERVICE') }),
      ],
    })
    const h = makeHarness(db)

    await h.worker.activateOrder('o1')

    expect(db.store.workspaces).toHaveLength(1)
    const created = db.store.workspaces[0]
    expect(db.store.deliveries).toHaveLength(1)
    expect(db.store.deliveries[0].workspaceId).toBe(created.id)
    expect(db.store.orders.get('o1')!.status).toBe('FULFILLING')
  })

  it('startOrderActivateWorker：createQueue + work(order.activate) 装配，handler 消费 { orderId }', async () => {
    const db = makeDb({ items: [item()] })
    const boss = {
      createQueue: vi.fn(async () => ({})),
      send: vi.fn(async () => ({})),
      work: vi.fn(async () => ({})),
    }
    const entitlements = { recompute: vi.fn(async () => ({})) }
    const audit = { record: vi.fn(async () => {}) }

    await startOrderActivateWorker({
      boss: boss as any,
      prisma: db.prisma,
      entitlements,
      audit,
      now: FIXED_NOW,
    })

    expect(boss.createQueue).toHaveBeenCalledWith('order.activate')
    expect(boss.work).toHaveBeenCalledWith('order.activate', expect.any(Function))
    const handler = boss.work.mock.calls[0][1]
    await handler([{ data: { orderId: 'o1' } }])
    expect(db.store.orders.get('o1')!.status).toBe('COMPLETED')
    expect(entitlements.recompute).toHaveBeenCalledWith('org-1')
  })
})

// ---------------------------------------------------------------------------
// billing-crons：order.reconcile（告警）/ order.expire（超时取消）
// ---------------------------------------------------------------------------

describe('billing-crons', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('order.reconcile：PAID 停留 >1h → audit order.reconcile_alert(PAID_STALLED) + console.warn，不动状态', async () => {
    const db = makeDb({
      // 遗留 E5：告警时钟改用 paidAt（updatedAt 仅作参考）——paidAt = now - 2h
      order: makeOrder({
        status: 'PAID',
        paidAt: new Date('2026-10-15T10:00:00.000Z'),
        updatedAt: new Date('2026-10-15T10:00:00.000Z'),
      }),
    })
    const audit = { record: vi.fn(async () => {}) }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await runOrderReconcile({ prisma: db.prisma, audit, now: FIXED_NOW })

    expect(result).toEqual({
      paidStalled: 1,
      fulfillingStalled: 0,
      creditOverdue: 0,
      creditSuspended: 0,
      creditSuspendSkipped: 0,
    })
    const entry = audit.record.mock.calls[0][0]
    expect(entry).toMatchObject({
      actorType: 'SYSTEM',
      action: 'order.reconcile_alert',
      organizationId: 'org-1',
      target: 'Order:o1',
    })
    expect(entry.diff).toMatchObject({ reason: 'PAID_STALLED', orderId: 'o1' })
    expect(warnSpy).toHaveBeenCalled()
    // 只告警不动状态
    expect(db.store.orders.get('o1')!.status).toBe('PAID')
  })

  it('终审 I2：FULFILLING 停滞 >1h（worker 五连败 / credit.open 后崩溃）→ audit FULFILLING_STALLED + console.warn，不动状态', async () => {
    const db = makeDb({
      order: makeOrder({
        status: 'FULFILLING',
        paymentMethod: 'CONTRACT_CREDIT',
        updatedAt: new Date('2026-10-15T10:00:00.000Z'), // now - 2h > 1h 阈值
      }),
    })
    const audit = { record: vi.fn(async () => {}) }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await runOrderReconcile({ prisma: db.prisma, audit, now: FIXED_NOW })

    expect(result).toEqual({
      paidStalled: 0,
      fulfillingStalled: 1,
      creditOverdue: 0,
      creditSuspended: 0,
      creditSuspendSkipped: 0,
    })
    const entry = audit.record.mock.calls[0][0]
    expect(entry).toMatchObject({
      actorType: 'SYSTEM',
      action: 'order.reconcile_alert',
      organizationId: 'org-1',
      target: 'Order:o1',
    })
    expect(entry.diff).toMatchObject({ reason: 'FULFILLING_STALLED', orderId: 'o1', status: 'FULFILLING' })
    // 纯增查询：状态不动（含 SERVICE 行的订单合法停留 FULFILLING 不受影响）
    expect(db.store.orders.get('o1')!.status).toBe('FULFILLING')
  })

  it('终审 I2：FULFILLING 未超 1h / 恰 1h 边界（不含）→ 不告警；PAID 状态不触发 FULFILLING 扫描', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 恰 1h：updatedAt = now - 1h 整（不满足 >1h）
    const db = makeDb({
      order: makeOrder({ status: 'FULFILLING', updatedAt: new Date('2026-10-15T11:00:00.000Z') }),
    })
    const audit = { record: vi.fn(async () => {}) }
    const result = await runOrderReconcile({ prisma: db.prisma, audit, now: FIXED_NOW })
    expect(result).toEqual({
      paidStalled: 0,
      fulfillingStalled: 0,
      creditOverdue: 0,
      creditSuspended: 0,
      creditSuspendSkipped: 0,
    })
    expect(audit.record).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()

    // 陈旧 updatedAt 但状态非 FULFILLING（PAID 归 PAID 扫描、已取消不在扫描面）
    const db2 = makeDb({
      order: makeOrder({ status: 'CANCELLED', updatedAt: new Date('2026-10-15T10:00:00.000Z') }),
    })
    const audit2 = { record: vi.fn(async () => {}) }
    const result2 = await runOrderReconcile({ prisma: db2.prisma, audit: audit2, now: FIXED_NOW })
    expect(result2.fulfillingStalled).toBe(0)
    expect(result2.paidStalled).toBe(0)
  })

  it('遗留 E1：FULFILLING 停滞豁免——含 SERVICE 行且交付单建全（交付在途）→ 不告警', async () => {
    const db = makeDb({
      order: makeOrder({ status: 'FULFILLING', updatedAt: new Date('2026-10-15T10:00:00.000Z') }),
      items: [
        item({ id: 'item-sub', planSnapshot: snapshot('SUBSCRIPTION') }),
        item({ id: 'item-svc', planId: 'plan-svc', planSnapshot: snapshot('SERVICE') }),
      ],
      // 两张 SERVICE 行的交付单都已建（orderItemId 1:1 锚）——开通已推进、交付在途
      deliveries: [
        {
          id: 'sd-1',
          orderItemId: 'item-svc',
          workspaceId: 'ws-1',
          status: 'PENDING_ASSIGN',
          milestones: [],
          createdAt: new Date('2026-10-15T11:00:00.000Z'),
          updatedAt: new Date('2026-10-15T11:00:00.000Z'),
        },
      ],
    })
    const audit = { record: vi.fn(async () => {}) }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await runOrderReconcile({ prisma: db.prisma, audit, now: FIXED_NOW })

    expect(result).toEqual({
      paidStalled: 0,
      fulfillingStalled: 0,
      creditOverdue: 0,
      creditSuspended: 0,
      creditSuspendSkipped: 0,
    })
    expect(audit.record).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    // 纯告警面：状态不动
    expect(db.store.orders.get('o1')!.status).toBe('FULFILLING')
  })

  it('遗留 E1：FULFILLING 停滞豁免——含 SERVICE 行但缺一张交付单（丢任务实锤）→ 照旧告警', async () => {
    const db = makeDb({
      order: makeOrder({ status: 'FULFILLING', updatedAt: new Date('2026-10-15T10:00:00.000Z') }),
      items: [
        item({ id: 'item-sub', planSnapshot: snapshot('SUBSCRIPTION') }),
        item({ id: 'item-svc', planId: 'plan-svc', planSnapshot: snapshot('SERVICE') }),
      ],
      // SERVICE 行的交付单未建（开通 worker 中途崩溃 / 五连败耗尽）→ 不豁免
      deliveries: [],
    })
    const audit = { record: vi.fn(async () => {}) }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await runOrderReconcile({ prisma: db.prisma, audit, now: FIXED_NOW })

    expect(result).toEqual({
      paidStalled: 0,
      fulfillingStalled: 1,
      creditOverdue: 0,
      creditSuspended: 0,
      creditSuspendSkipped: 0,
    })
    const entry = audit.record.mock.calls[0][0]
    expect(entry.diff).toMatchObject({ reason: 'FULFILLING_STALLED', orderId: 'o1' })
  })

  it('遗留 E5：PAID 停留告警时钟用 paidAt——paidAt 新（备注更新重置 updatedAt）→ 不告警', async () => {
    // 场景：11:30 收款确认（paidAt=11:30），随后客户改备注重置 updatedAt=10:00 旧值
    // ——按旧 updatedAt 口径会误报；按 paidAt 口径停留仅 30 分钟 < 1h 阈值
    const db = makeDb({
      order: makeOrder({
        status: 'PAID',
        paidAt: new Date('2026-10-15T11:30:00.000Z'),
        updatedAt: new Date('2026-10-15T10:00:00.000Z'),
      }),
    })
    const audit = { record: vi.fn(async () => {}) }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await runOrderReconcile({ prisma: db.prisma, audit, now: FIXED_NOW })

    expect(result.paidStalled).toBe(0)
    expect(audit.record).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('order.reconcile：CONTRACT_CREDIT PENDING 且 dueAt 已过 → CREDIT_OVERDUE 告警', async () => {
    const db = makeDb({
      order: makeOrder({
        status: 'FULFILLING',
        paymentMethod: 'CONTRACT_CREDIT',
        dueAt: new Date('2026-10-14T00:00:00.000Z'),
      }),
      payments: [
        {
          id: 'pay-1',
          orderId: 'o1',
          method: 'CONTRACT_CREDIT',
          status: 'PENDING',
          amountCents: 10000,
          currency: 'CNY',
        },
      ],
    })
    const audit = { record: vi.fn(async () => {}) }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await runOrderReconcile({ prisma: db.prisma, audit, now: FIXED_NOW })

    expect(result).toEqual({
      paidStalled: 0,
      fulfillingStalled: 0,
      creditOverdue: 1,
      // dueAt 仅过 1 天（< 7 天阈值）→ 只告警不暂停
      creditSuspended: 0,
      creditSuspendSkipped: 0,
    })
    const entry = audit.record.mock.calls[0][0]
    expect(entry.action).toBe('order.reconcile_alert')
    expect(entry.organizationId).toBe('org-1')
    expect(entry.diff).toMatchObject({ reason: 'CREDIT_OVERDUE', orderId: 'o1', paymentId: 'pay-1' })
  })

  it('终审 I1：账期超期 8 天 → 聚合判定（本单订阅不豁免）后暂停 org 全部 ACTIVE workspace（原因=账期超期）+ audit', async () => {
    const db = makeDb({
      order: makeOrder({
        status: 'FULFILLING',
        paymentMethod: 'CONTRACT_CREDIT',
        dueAt: new Date('2026-10-07T12:00:00.000Z'), // now - 8 天 > 7 天阈值
      }),
      payments: [
        { id: 'pay-1', orderId: 'o1', method: 'CONTRACT_CREDIT', status: 'PENDING', amountCents: 10000, currency: 'CNY' },
      ],
      // 本逾期账期单开通的订阅（ACTIVE 未到期）不构成豁免——聚合判定须排除本单行
      subscriptions: [
        {
          id: 'sub-own',
          organizationId: 'org-1',
          planId: 'plan-1',
          sourceOrderId: 'o1',
          startAt: new Date('2026-10-01T00:00:00.000Z'),
          endAt: new Date('2026-11-01T00:00:00.000Z'),
          status: 'ACTIVE',
          entitlements: { maxWorkspaces: 3 },
          createdAt: new Date('2026-10-01T00:00:00.000Z'),
          updatedAt: new Date('2026-10-01T00:00:00.000Z'),
        },
      ],
      workspaces: [
        makeWorkspace({ id: 'ws-a' }),
        makeWorkspace({ id: 'ws-b', name: '第二个工作区' }),
      ],
    })
    const audit = { record: vi.fn(async () => {}) }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await runOrderReconcile({ prisma: db.prisma, audit, now: FIXED_NOW })

    expect(result).toEqual({
      paidStalled: 0,
      fulfillingStalled: 0,
      creditOverdue: 1,
      creditSuspended: 2,
      creditSuspendSkipped: 0,
    })
    // org 全部 ACTIVE workspace → SUSPENDED（suspendReason=账期超期，单一来源常量）
    for (const ws of db.store.workspaces) {
      expect(ws).toMatchObject({ status: 'SUSPENDED', suspendReason: CREDIT_OVERDUE_SUSPEND_REASON })
    }
    const suspendAudit = audit.record.mock.calls
      .map((c) => c[0])
      .find((a) => a.action === 'order.credit_overdue_suspended')
    expect(suspendAudit).toMatchObject({ actorType: 'SYSTEM', organizationId: 'org-1', target: 'Order:o1' })
    expect(suspendAudit!.diff).toMatchObject({
      orderId: 'o1',
      paymentId: 'pay-1',
      suspendDays: 7,
      workspacesSuspended: 2,
    })
  })

  it('终审 I1：恰 7 天边界不暂停（严格 <）；org 无 ACTIVE workspace 时暂停命中 0 行也不误报', async () => {
    const db = makeDb({
      order: makeOrder({
        status: 'FULFILLING',
        paymentMethod: 'CONTRACT_CREDIT',
        dueAt: new Date('2026-10-08T12:00:00.000Z'), // now - 7 天整 = 边界（不含）
      }),
      payments: [
        { id: 'pay-1', orderId: 'o1', method: 'CONTRACT_CREDIT', status: 'PENDING', amountCents: 10000, currency: 'CNY' },
      ],
      workspaces: [makeWorkspace()],
    })
    const audit = { record: vi.fn(async () => {}) }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await runOrderReconcile({ prisma: db.prisma, audit, now: FIXED_NOW })

    expect(result).toEqual({
      paidStalled: 0,
      fulfillingStalled: 0,
      creditOverdue: 1,
      creditSuspended: 0,
      creditSuspendSkipped: 0,
    })
    expect(db.store.workspaces[0].status).toBe('ACTIVE')
    // 仅有 CREDIT_OVERDUE 告警，无暂停 audit
    expect(audit.record.mock.calls.map((c) => c[0].action)).not.toContain(
      'order.credit_overdue_suspended',
    )
  })

  it('终审 I1：聚合判定——org 仍有他单有效订阅（其他付费服务）→ 只告警跳过暂停', async () => {
    const db = makeDb({
      order: makeOrder({
        status: 'FULFILLING',
        paymentMethod: 'CONTRACT_CREDIT',
        dueAt: new Date('2026-10-07T12:00:00.000Z'), // 超期 8 天
      }),
      payments: [
        { id: 'pay-1', orderId: 'o1', method: 'CONTRACT_CREDIT', status: 'PENDING', amountCents: 10000, currency: 'CNY' },
      ],
      subscriptions: [
        // 本单订阅行 + 他单（其他来源）有效订阅：他单构成"其他有效服务"
        {
          id: 'sub-own',
          organizationId: 'org-1',
          planId: 'plan-1',
          sourceOrderId: 'o1',
          startAt: new Date('2026-10-01T00:00:00.000Z'),
          endAt: new Date('2026-11-01T00:00:00.000Z'),
          status: 'ACTIVE',
          entitlements: { maxWorkspaces: 3 },
          createdAt: new Date('2026-10-01T00:00:00.000Z'),
          updatedAt: new Date('2026-10-01T00:00:00.000Z'),
        },
        {
          id: 'sub-other',
          organizationId: 'org-1',
          planId: 'plan-9',
          sourceOrderId: 'o-other',
          startAt: new Date('2026-09-01T00:00:00.000Z'),
          endAt: new Date('2026-12-01T00:00:00.000Z'),
          status: 'ACTIVE',
          entitlements: { maxWorkspaces: 1 },
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          updatedAt: new Date('2026-09-01T00:00:00.000Z'),
        },
      ],
      workspaces: [makeWorkspace()],
    })
    const audit = { record: vi.fn(async () => {}) }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await runOrderReconcile({ prisma: db.prisma, audit, now: FIXED_NOW })

    expect(result).toEqual({
      paidStalled: 0,
      fulfillingStalled: 0,
      creditOverdue: 1,
      creditSuspended: 0,
      creditSuspendSkipped: 1,
    })
    // 他单付费服务不受本单欠款牵连：workspace 保持 ACTIVE
    expect(db.store.workspaces[0].status).toBe('ACTIVE')
    expect(audit.record.mock.calls.map((c) => c[0].action)).not.toContain(
      'order.credit_overdue_suspended',
    )
  })

  it('遗留 E2：同 org 两张均超期账期单互构成"其他有效服务"→ 双双不再互跳，两者都暂停', async () => {
    const overdue = { status: 'FULFILLING', paymentMethod: 'CONTRACT_CREDIT', dueAt: new Date('2026-10-07T12:00:00.000Z') }
    const db = makeDb({
      order: makeOrder({ id: 'o1', ...overdue }),
      payments: [
        { id: 'pay-1', orderId: 'o1', method: 'CONTRACT_CREDIT', status: 'PENDING', amountCents: 10000, currency: 'CNY' },
      ],
      // 两张超期单各自开通的订阅（均 ACTIVE 未到期）——旧行为互为豁免双双跳过
      subscriptions: [
        {
          id: 'sub-a',
          organizationId: 'org-1',
          planId: 'plan-1',
          sourceOrderId: 'o1',
          startAt: new Date('2026-10-01T00:00:00.000Z'),
          endAt: new Date('2026-11-01T00:00:00.000Z'),
          status: 'ACTIVE',
          entitlements: { maxWorkspaces: 3 },
          createdAt: new Date('2026-10-01T00:00:00.000Z'),
          updatedAt: new Date('2026-10-01T00:00:00.000Z'),
        },
        {
          id: 'sub-b',
          organizationId: 'org-1',
          planId: 'plan-2',
          sourceOrderId: 'o2',
          startAt: new Date('2026-10-01T00:00:00.000Z'),
          endAt: new Date('2026-11-01T00:00:00.000Z'),
          status: 'ACTIVE',
          entitlements: { maxWorkspaces: 1 },
          createdAt: new Date('2026-10-01T00:00:00.000Z'),
          updatedAt: new Date('2026-10-01T00:00:00.000Z'),
        },
      ],
      workspaces: [makeWorkspace({ id: 'ws-a' }), makeWorkspace({ id: 'ws-b', name: '第二个工作区' })],
    })
    db.store.orders.set('o2', makeOrder({ id: 'o2', orderNo: 'GEO261015cd56ef78', ...overdue }))
    db.store.payments.push({ id: 'pay-2', orderId: 'o2', method: 'CONTRACT_CREDIT', status: 'PENDING', amountCents: 8000, currency: 'CNY' })
    const audit = { record: vi.fn(async () => {}) }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await runOrderReconcile({ prisma: db.prisma, audit, now: FIXED_NOW })

    expect(result).toEqual({
      paidStalled: 0,
      fulfillingStalled: 0,
      creditOverdue: 2,
      // 两单都暂停：第一单暂停 2 个 workspace，第二单幂等命中 0（已 SUSPENDED）
      creditSuspended: 2,
      creditSuspendSkipped: 0,
    })
    for (const ws of db.store.workspaces) {
      expect(ws).toMatchObject({ status: 'SUSPENDED', suspendReason: CREDIT_OVERDUE_SUSPEND_REASON })
    }
    // 两单都写了暂停 audit（各自挂各自的订单锚）
    const suspendAudits = audit.record.mock.calls
      .map((c) => c[0])
      .filter((a) => a.action === 'order.credit_overdue_suspended')
    expect(suspendAudits.map((a) => a.diff.orderId).sort()).toEqual(['o1', 'o2'])
  })

  it('终审 I1 闭环：超期自动暂停 → 应收确认（confirmPayment CONTRACT_CREDIT）按原因精确恢复 workspace', async () => {
    const db = makeDb({
      order: makeOrder({
        status: 'FULFILLING',
        paymentMethod: 'CONTRACT_CREDIT',
        dueAt: new Date('2026-10-07T12:00:00.000Z'),
      }),
      payments: [
        { id: 'pay-1', orderId: 'o1', method: 'CONTRACT_CREDIT', status: 'PENDING', amountCents: 10000, currency: 'CNY' },
      ],
      workspaces: [
        makeWorkspace({ id: 'ws-a' }),
        // 其他原因暂停的不受恢复牵连（应收确认只恢复"账期超期"）
        makeWorkspace({ id: 'ws-man', name: '违规暂停', status: 'SUSPENDED', suspendReason: '违规内容' }),
      ],
    })
    const audit = { record: vi.fn(async () => {}) }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    // 暂停侧：reconcile 置 ws-a SUSPENDED（账期超期）
    const reconcile = await runOrderReconcile({ prisma: db.prisma, audit, now: FIXED_NOW })
    expect(reconcile.creditSuspended).toBe(1)
    expect(db.store.workspaces.find((w) => w.id === 'ws-a')).toMatchObject({
      status: 'SUSPENDED',
      suspendReason: CREDIT_OVERDUE_SUSPEND_REASON,
    })

    // 恢复侧：财务应收确认（order-service.confirmPayment）——暂停写入与恢复
    // 匹配共用同一常量来源，闭环不断链
    const orders = createOrderService({ prisma: db.prisma, now: FIXED_NOW })
    const confirm = await orders.confirmPayment('pay-1', 'finance-1')

    expect(confirm).toMatchObject({ paymentMethod: 'CONTRACT_CREDIT', resumedWorkspaces: 1 })
    expect(db.store.payments[0].status).toBe('SUCCEEDED')
    expect(db.store.workspaces.find((w) => w.id === 'ws-a')).toMatchObject({
      status: 'ACTIVE',
      suspendReason: null,
    })
    expect(db.store.workspaces.find((w) => w.id === 'ws-man')!.status).toBe('SUSPENDED')
  })

  it('order.reconcile：时限内/账期未到 → 无告警（含恰 1h 边界不含）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // PAID 但 paidAt 恰好 = now-1h（不满足 >1h；遗留 E5 时钟改用 paidAt）
    const db = makeDb({
      order: makeOrder({
        status: 'PAID',
        paidAt: new Date('2026-10-15T11:00:00.000Z'),
        updatedAt: new Date('2026-10-15T11:00:00.000Z'),
      }),
      payments: [
        {
          id: 'pay-1',
          orderId: 'o1',
          method: 'CONTRACT_CREDIT',
          status: 'PENDING',
          amountCents: 10000,
          currency: 'CNY',
        },
      ],
    })
    // dueAt 未设（null）→ 不满足 dueAt < now
    const audit = { record: vi.fn(async () => {}) }
    const result = await runOrderReconcile({ prisma: db.prisma, audit, now: FIXED_NOW })
    expect(result).toEqual({
      paidStalled: 0,
      fulfillingStalled: 0,
      creditOverdue: 0,
      creditSuspended: 0,
      creditSuspendSkipped: 0,
    })
    expect(audit.record).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('order.expire：PENDING_PAYMENT 超 7 天 → cancel 迁移 + audit order.expire_cancelled + note 落事件', async () => {
    const db = makeDb({
      order: makeOrder({ status: 'PENDING_PAYMENT', createdAt: new Date('2026-10-01T00:00:00.000Z') }),
    })
    const audit = { record: vi.fn(async () => {}) }
    const orders = createOrderService({ prisma: db.prisma, now: FIXED_NOW })

    const result = await runOrderExpire({ prisma: db.prisma, orders, audit, now: FIXED_NOW })

    expect(result).toEqual({ scanned: 1, cancelled: 1, skipped: 0 })
    expect(db.store.orders.get('o1')!.status).toBe('CANCELLED')
    const evt = db.store.events.find((e) => e.event === 'cancel')
    expect(evt?.note).toBe('超时未支付自动取消（7 天）')
    const entry = audit.record.mock.calls[0][0]
    expect(entry).toMatchObject({
      actorType: 'SYSTEM',
      action: 'order.expire_cancelled',
      organizationId: 'org-1',
      target: 'Order:o1',
    })
  })

  it('order.expire：恰 7 天边界不取消（严格 <）；已支付并发忽略且不写 audit', async () => {
    // 恰 7 天：createdAt = now - 7d 整 → 不满足 <
    const dbEdge = makeDb({
      order: makeOrder({ status: 'PENDING_PAYMENT', createdAt: new Date('2026-10-08T12:00:00.000Z') }),
    })
    const auditEdge = { record: vi.fn(async () => {}) }
    const ordersEdge = createOrderService({ prisma: dbEdge.prisma, now: FIXED_NOW })
    const resEdge = await runOrderExpire({ prisma: dbEdge.prisma, orders: ordersEdge, audit: auditEdge, now: FIXED_NOW })
    expect(resEdge).toEqual({ scanned: 0, cancelled: 0, skipped: 0 })
    expect(dbEdge.store.orders.get('o1')!.status).toBe('PENDING_PAYMENT')

    // 扫描后发现已支付（竞态）：transition 被拒 → 忽略、状态不动、不写 audit
    const db = makeDb({
      order: makeOrder({ status: 'PAID' }),
      staleOrders: [
        makeOrder({ status: 'PENDING_PAYMENT', createdAt: new Date('2026-10-01T00:00:00.000Z') }),
      ],
    })
    const audit = { record: vi.fn(async () => {}) }
    const orders = createOrderService({ prisma: db.prisma, now: FIXED_NOW })
    const result = await runOrderExpire({ prisma: db.prisma, orders, audit, now: FIXED_NOW })
    expect(result).toEqual({ scanned: 1, cancelled: 0, skipped: 1 })
    expect(db.store.orders.get('o1')!.status).toBe('PAID')
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('遗留 B5：order.expire 首条抛错（毒订单）不阻断第二条——单条告警继续，无异常上抛', async () => {
    const db = makeDb({
      staleOrders: [
        makeOrder({ id: 'poison', status: 'PENDING_PAYMENT', createdAt: new Date('2026-10-01T00:00:00.000Z') }),
        makeOrder({ id: 'ok', status: 'PENDING_PAYMENT', createdAt: new Date('2026-10-02T00:00:00.000Z') }),
      ],
    })
    const audit = { record: vi.fn(async () => {}) }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const orders = {
      transition: vi.fn(async (orderId: string) => {
        if (orderId === 'poison') throw new Error('poison order exploded')
        return { id: 'evt-x' }
      }),
    }

    const result = await runOrderExpire({ prisma: db.prisma, orders: orders as any, audit, now: FIXED_NOW })

    // 首条失败被吞：第二条照常取消，整批无异常
    expect(result).toEqual({ scanned: 2, cancelled: 1, skipped: 0 })
    expect(orders.transition).toHaveBeenCalledTimes(2)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('poison'), expect.any(Error))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('失败 1'))
  })

  it('遗留 B5：order.reconcile 首条 audit 抛错不阻断第二条——批内逐单隔离，尾汇总日志含失败数', async () => {
    const stalled = new Date('2026-10-15T10:00:00.000Z')
    const db = makeDb({
      order: makeOrder({ id: 'poison', status: 'PAID', paidAt: stalled, updatedAt: stalled }),
    })
    db.store.orders.set(
      'ok',
      makeOrder({ id: 'ok', orderNo: 'GEO261015ok000001', status: 'PAID', paidAt: stalled, updatedAt: stalled }),
    )
    const audit = {
      record: vi.fn(async (entry: { target?: string }) => {
        if (entry.target === 'Order:poison') throw new Error('audit exploded')
      }),
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await runOrderReconcile({ prisma: db.prisma, audit, now: FIXED_NOW })

    // 两条扫描计数不变（告警面）；毒单失败被吞、健康单 audit 照写
    expect(result).toEqual({
      paidStalled: 2,
      fulfillingStalled: 0,
      creditOverdue: 0,
      creditSuspended: 0,
      creditSuspendSkipped: 0,
    })
    expect(audit.record).toHaveBeenCalledTimes(2)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('失败 1'))
  })

  it('遗留 B5：order.reconcile 账期超期段首条暂停写失败不阻断第二条——健康单照常暂停', async () => {
    const overdue = { status: 'FULFILLING', paymentMethod: 'CONTRACT_CREDIT', dueAt: new Date('2026-10-07T12:00:00.000Z') }
    const db = makeDb({
      order: makeOrder({ id: 'poison', ...overdue }),
      payments: [
        { id: 'pay-poison', orderId: 'poison', method: 'CONTRACT_CREDIT', status: 'PENDING', amountCents: 10000, currency: 'CNY' },
      ],
      workspaces: [
        makeWorkspace({ id: 'ws-poison', organizationId: 'org-1' }),
        makeWorkspace({ id: 'ws-ok', organizationId: 'org-2' }),
      ],
    })
    db.store.orders.set('ok', makeOrder({ id: 'ok', organizationId: 'org-2', ...overdue }))
    db.store.payments.push({ id: 'pay-ok', orderId: 'ok', method: 'CONTRACT_CREDIT', status: 'PENDING', amountCents: 10000, currency: 'CNY' })
    const audit = { record: vi.fn(async () => {}) }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const realUpdateMany = db.prisma.workspace.updateMany.getMockImplementation()
    db.prisma.workspace.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (where.organizationId === 'org-1') throw new Error('suspend write exploded')
      return realUpdateMany!({ where, data })
    })

    const result = await runOrderReconcile({ prisma: db.prisma, audit, now: FIXED_NOW })

    expect(result).toMatchObject({ creditOverdue: 2, creditSuspended: 1 })
    expect(db.store.workspaces.find((w) => w.id === 'ws-ok')).toMatchObject({
      status: 'SUSPENDED',
      suspendReason: CREDIT_OVERDUE_SUSPEND_REASON,
    })
    expect(db.store.workspaces.find((w) => w.id === 'ws-poison')!.status).toBe('ACTIVE')
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('pay-poison'), expect.any(Error))
  })

  it('startBillingCrons：order.reconcile/order.expire/subscription.expire-check 按每日 cron 注册，handler 吞错可重入', async () => {
    const db = makeDb()
    const boss = {
      createQueue: vi.fn(async () => ({})),
      schedule: vi.fn(async () => ({})),
      work: vi.fn(async () => ({})),
      send: vi.fn(async () => ({})),
    }
    const orders = createOrderService({ prisma: db.prisma, now: FIXED_NOW })
    const audit = { record: vi.fn(async () => {}) }

    await startBillingCrons({ boss: boss as any, prisma: db.prisma, orders, audit })

    expect(boss.createQueue).toHaveBeenCalledWith(BILLING_CRON_QUEUES.reconcile)
    expect(boss.createQueue).toHaveBeenCalledWith(BILLING_CRON_QUEUES.expire)
    expect(boss.createQueue).toHaveBeenCalledWith(BILLING_CRON_QUEUES.expireCheck)
    expect(boss.schedule).toHaveBeenCalledWith(BILLING_CRON_QUEUES.reconcile, ORDER_RECONCILE_CRON, {})
    expect(boss.schedule).toHaveBeenCalledWith(BILLING_CRON_QUEUES.expire, ORDER_EXPIRE_CRON, {})
    expect(boss.schedule).toHaveBeenCalledWith(BILLING_CRON_QUEUES.expireCheck, SUBSCRIPTION_EXPIRE_CHECK_CRON, {})
    expect(boss.schedule).toHaveBeenCalledWith('order.reconcile', '5 4 * * *', {})
    expect(boss.schedule).toHaveBeenCalledWith('order.expire', '10 4 * * *', {})
    expect(boss.schedule).toHaveBeenCalledWith('subscription.expire-check', '15 4 * * *', {})

    // 三个 work handler 空库执行一轮不抛错
    const reconcileHandler = boss.work.mock.calls.find((c) => c[0] === 'order.reconcile')![1]
    const expireHandler = boss.work.mock.calls.find((c) => c[0] === 'order.expire')![1]
    const expireCheckHandler = boss.work.mock.calls.find((c) => c[0] === 'subscription.expire-check')![1]
    await expect(reconcileHandler()).resolves.toBeUndefined()
    await expect(expireHandler()).resolves.toBeUndefined()
    await expect(expireCheckHandler()).resolves.toBeUndefined()
  })

  it('遗留 B9：注入 logger——runOrderReconcile 告警走注入通道且不打 console；未注入回退 console（测试兼容）', async () => {
    const db = makeDb({
      order: makeOrder({
        status: 'PAID',
        paidAt: new Date('2026-10-15T10:00:00.000Z'),
        updatedAt: new Date('2026-10-15T10:00:00.000Z'),
      }),
    })
    const audit = { record: vi.fn(async () => {}) }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await runOrderReconcile({ prisma: db.prisma, audit, now: FIXED_NOW, logger })

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(warnSpy).not.toHaveBeenCalled()

    // 未注入：缺省回退 console，既有直调用法不变
    const db2 = makeDb({
      order: makeOrder({
        status: 'PAID',
        paidAt: new Date('2026-10-15T10:00:00.000Z'),
        updatedAt: new Date('2026-10-15T10:00:00.000Z'),
      }),
    })
    const audit2 = { record: vi.fn(async () => {}) }
    await runOrderReconcile({ prisma: db2.prisma, audit: audit2, now: FIXED_NOW })
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('遗留 B9：startBillingCrons 接收 logger 并透传 handler（reconcile handler 日志走注入通道）', async () => {
    const db = makeDb({
      order: makeOrder({
        status: 'PAID',
        paidAt: new Date('2026-10-15T10:00:00.000Z'),
        updatedAt: new Date('2026-10-15T10:00:00.000Z'),
      }),
    })
    const boss = {
      createQueue: vi.fn(async () => ({})),
      schedule: vi.fn(async () => ({})),
      work: vi.fn(async () => ({})),
      send: vi.fn(async () => ({})),
    }
    const orders = createOrderService({ prisma: db.prisma, now: FIXED_NOW })
    const audit = { record: vi.fn(async () => {}) }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await startBillingCrons({ boss: boss as any, prisma: db.prisma, orders, audit, logger, now: FIXED_NOW })
    const reconcileHandler = boss.work.mock.calls.find((c) => c[0] === 'order.reconcile')![1]
    await reconcileHandler()

    // 单条告警 warn + 汇总 warn 均走注入 logger
    expect(logger.warn.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
