import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ApiCredential, Session, User, Workspace } from '@prisma/client'
import { appRouter } from '../src/router.js'
import { createOrderService, ORDER_ACTIVATION_QUEUE, ORDER_ACTIVATION_SEND_OPTIONS } from '../src/platform/commerce/order-service.js'
import { createMockChannel } from '../src/platform/commerce/payment/channel.js'
import { handlePaymentCallback } from '../src/platform/commerce/payment/webhook.js'
import { createRefundService, RefundAlreadyExecutedError } from '../src/platform/commerce/refund-service.js'
import { createEntitlementService } from '../src/platform/billing/entitlement-service.js'
import { createEntitlementGuard, QuotaExceededError } from '../src/platform/billing/entitlement-guard.js'
import { createServiceStateResolver } from '../src/platform/billing/service-state.js'
import { runExpireCheck } from '../src/platform/billing/subscription-service.js'
import { createOrderActivateWorker, SUBSCRIPTION_EXTEND_MARKER_EVENT } from '../src/workers/order-activate.js'

// ---------------------------------------------------------------------------
// 任务 17：计费矩阵集成测试（P2 §9.3 集成清单 + 审查重点五项）。
//
// 深度口径与 tests/org-authz.test.ts / tests/sdk-compat.test.ts 同级：
// **真实服务叠内存 mock prisma**——order-service / refund-service / 开通 worker /
// entitlement service / service-state resolver / expire-check / EntitlementGuard /
// entitlement-guard 的全部业务逻辑真实执行，只有数据库是有状态内存实现
// （条件更新真实生效、$transaction 直通、唯一约束抛 P2002、$queryRaw FOR
// UPDATE 按表回显行）。API 级用例走真实 appRouter.createCaller（完整中间件链：
// csrfGuard → requireUser/requireWorkspace → orgProcedure/platformProcedure）。
//
// 七组（每组断言穿透到状态/数据形状，而非 mock 调用计数）：
// ① 回调幂等端到端：createPayment → handlePaymentCallback 同 channelTxnNo 两次；
// ② 退款幂等：approve 后重复 approve → RefundAlreadyExecutedError、渠道不双发；
// ③ 开通 worker 重试幂等：confirmPayment 真实 enqueue → activateOrder 两遍；
// ④ maxWorkspaces 行锁并发语义：顺序事务序列化（第二个事务 count 看到第一个
//    事务已提交的行 → 拒；照任务 9 的串行化论证用例加深到组合场景）；
// ⑤ §3.3 服务状态矩阵（BILLING_ENFORCEMENT=on + 真实 resolver）：GRACE /
//    ACTIVE+NONE / EXPIRED+SUSPENDED × user / apiKey 双通道；
// ⑥ API 级全链路：下单（快照断言）→ 财务确认 → 开通 → 配额生效 → 到期暂停
//    → 续费恢复；
// ⑦ 跨租户越权：org A 对 org B 订单四端点 NOT_FOUND + 权限分治对照。
// ---------------------------------------------------------------------------

const T0 = new Date('2026-10-15T12:00:00.000Z')
const DAY_MS = 86_400_000
/** 合法回单 base64（小文件，png 扩展名） */
const VOUCHER_B64 = Buffer.from('银行回单-集成测试内容').toString('base64')

// ---------------------------------------------------------------------------
// 可控时钟（所有真实服务共享同一注入实例）
// ---------------------------------------------------------------------------

interface Clock {
  now(): Date
  advance(ms: number): void
}

function makeClock(start: Date): Clock {
  let current = new Date(start.getTime())
  return {
    now: () => new Date(current.getTime()),
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms)
    },
  }
}

// ---------------------------------------------------------------------------
// 内存态 store + mock prisma（有状态、条件更新真实生效、$transaction 直通）
// ---------------------------------------------------------------------------

interface Store {
  products: Map<string, Record<string, any>>
  plans: Map<string, Record<string, any>> // plan 行内嵌 product（include: { product: true } 同构）
  orders: Map<string, Record<string, any>>
  items: Map<string, Record<string, any>>
  events: Record<string, any>[] // 追加型（createdAt 取时钟）
  payments: Map<string, Record<string, any>>
  refunds: Map<string, Record<string, any>>
  subscriptions: Map<string, Record<string, any>>
  deliveries: Map<string, Record<string, any>>
  workspaces: Map<string, Record<string, any>>
  orgs: Map<string, Record<string, any>>
  oe: Map<string, Record<string, any>> // OrganizationEntitlement（organizationId 为主键）
  usageRecords: Record<string, any>[]
}

function makeStore(): Store {
  return {
    products: new Map(),
    plans: new Map(),
    orders: new Map(),
    items: new Map(),
    events: [],
    payments: new Map(),
    refunds: new Map(),
    subscriptions: new Map(),
    deliveries: new Map(),
    workspaces: new Map(),
    orgs: new Map(),
    oe: new Map(),
    usageRecords: [],
  }
}

function p2002(target: string[]) {
  return Object.assign(new Error(`Unique constraint failed on the fields: (${target.join(',')})`), {
    code: 'P2002',
    meta: { target },
  })
}

const OPERATORS = ['in', 'not', 'gt', 'lt', 'gte', 'lte', 'contains']

/** 通用 where 匹配：等值 / {in,not,gt,lt,gte,lte,contains} / OR / AND / 关系嵌套（workspace/plan/order） */
function makeMatches(store: Store) {
  return function matches(row: Record<string, any>, where: any): boolean {
    if (!where || typeof where !== 'object') return true
    for (const [key, cond] of Object.entries(where)) {
      if (key === 'OR') {
        if (!Array.isArray(cond) || !cond.some((alt) => matches(row, alt))) return false
        continue
      }
      if (key === 'AND') {
        if (!Array.isArray(cond) || !cond.every((alt) => matches(row, alt))) return false
        continue
      }
      const isOperatorObject =
        cond !== null &&
        typeof cond === 'object' &&
        !Array.isArray(cond) &&
        Object.keys(cond).some((k) => OPERATORS.includes(k))
      if (
        cond !== null &&
        typeof cond === 'object' &&
        !Array.isArray(cond) &&
        !isOperatorObject
      ) {
        // 关系过滤（嵌套 where）：本矩阵触达 workspace / plan / order 三种关系
        let related: Record<string, any> | null = null
        if (key === 'workspace' && row.workspaceId) related = store.workspaces.get(row.workspaceId) ?? null
        else if (key === 'plan' && row.planId) related = store.plans.get(row.planId) ?? null
        else if (key === 'order' && row.orderId) related = store.orders.get(row.orderId) ?? null
        if (!related || !matches(related, cond)) return false
        continue
      }
      const value = row[key]
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        if ('in' in cond && !(cond.in as unknown[]).includes(value)) return false
        if ('not' in cond && value === cond.not) return false
        if ('gt' in cond && !(compareValues(value, cond.gt) > 0)) return false
        if ('lt' in cond && !(compareValues(value, cond.lt) < 0)) return false
        if ('lte' in cond && !(compareValues(value, cond.lte) <= 0)) return false
        if ('gte' in cond && !(compareValues(value, cond.gte) >= 0)) return false
        if ('contains' in cond && !String(value ?? '').includes(String(cond.contains))) return false
      } else if (value !== cond) {
        return false
      }
    }
    return true
  }
}

function compareValues(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const na = typeof a === 'string' ? /(\d+)$/.exec(a)?.[1] : undefined
  const nb = typeof b === 'string' ? /(\d+)$/.exec(b)?.[1] : undefined
  if (na !== undefined && nb !== undefined) return Number(na) - Number(nb)
  return String(a).localeCompare(String(b))
}

/** orderBy 支持：单对象或数组（createdAt/id tiebreak 用数值后缀比较，evt-9 < evt-10） */
function applyOrderBy(rows: Record<string, any>[], orderBy: any): Record<string, any>[] {
  if (!orderBy) return rows
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy]
  return [...rows].sort((ra, rb) => {
    for (const spec of specs) {
      for (const [field, dir] of Object.entries(spec)) {
        const cmp = compareValues(ra[field], rb[field])
        if (cmp !== 0) return dir === 'desc' ? -cmp : cmp
      }
    }
    return 0
  })
}

function pick(row: Record<string, any>, select: any): Record<string, any> {
  if (!select || typeof select !== 'object') return { ...row }
  const out: Record<string, any> = {}
  for (const key of Object.keys(select)) out[key] = row[key]
  return out
}

function makePrisma(store: Store, clock: Clock) {
  const matches = makeMatches(store)
  let seq = 0
  const nextId = (prefix: string) => `${prefix}-${++seq}`
  const applyUpdate = (row: Record<string, any>, data: any) => {
    for (const [k, v] of Object.entries(data ?? {})) {
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as any).increment === 'number') {
        row[k] = (typeof row[k] === 'number' ? row[k] : 0) + (v as any).increment
      } else {
        row[k] = v
      }
    }
    row.updatedAt = clock.now()
    return row
  }
  const values = (m: Map<string, Record<string, any>>) => [...m.values()]

  /** include 关系装配（消费方读到的字段是超集投影，断言按需取用） */
  function withIncludes(model: string, row: Record<string, any>, include: any) {
    if (!include) return { ...row }
    const out: Record<string, any> = { ...row }
    if (model === 'order') {
      if (include.items) {
        const rows = values(store.items).filter((i) => i.orderId === row.id)
        out.items = applyOrderBy(rows, include.items.orderBy).map((i) => (include.items.select ? pick(i, include.items.select) : { ...i }))
      }
      if (include.payments) {
        const rows = values(store.payments).filter((p) => p.orderId === row.id)
        out.payments = applyOrderBy(rows, include.payments.orderBy).map((p) => ({ ...p }))
      }
      if (include.events) {
        const rows = store.events.filter((e) => e.orderId === row.id)
        out.events = applyOrderBy(rows, include.events.orderBy).map((e) => ({ ...e }))
      }
    }
    if (model === 'paymentTransaction' && include.order) {
      out.order = store.orders.get(row.orderId) ? { ...store.orders.get(row.orderId)! } : null
    }
    if (model === 'refundTransaction') {
      if (include.order) out.order = store.orders.get(row.orderId) ? { ...store.orders.get(row.orderId)! } : null
      if (include.payment) out.payment = store.payments.get(row.paymentId) ? { ...store.payments.get(row.paymentId)! } : null
    }
    if (model === 'subscription' && include.plan) {
      const plan = store.plans.get(row.planId)
      out.plan = plan ? { ...plan } : null // plan 行内嵌 product，include.plan.include.product 同构满足
    }
    return out
  }

  const prisma: any = {
    product: {
      findUnique: vi.fn(async ({ where }: any) => store.products.get(where.id) ?? null),
    },
    productPlan: {
      findMany: vi.fn(async ({ where, include }: any) => {
        void include // product 内嵌于 plan 行（create 时固化）
        return values(store.plans).filter((p) => matches(p, where)).map((p) => ({ ...p }))
      }),
    },
    order: {
      findUnique: vi.fn(async ({ where, select, include }: any) => {
        const row = store.orders.get(where.id) ?? null
        if (!row) return null
        const full = withIncludes('order', row, include)
        return select ? pick(full, select) : full
      }),
      findMany: vi.fn(async ({ where, orderBy, skip, take, include }: any) => {
        let rows = values(store.orders).filter((o) => matches(o, where))
        rows = applyOrderBy(rows, orderBy)
        if (skip) rows = rows.slice(skip)
        if (take !== undefined) rows = rows.slice(0, take)
        return rows.map((o) => withIncludes('order', o, include))
      }),
      count: vi.fn(async ({ where }: any) => values(store.orders).filter((o) => matches(o, where)).length),
      create: vi.fn(async ({ data }: any) => {
        if (values(store.orders).some((o) => o.orderNo === data.orderNo)) throw p2002(['orderNo'])
        const row = {
          id: nextId('order'),
          currency: 'CNY',
          discountCents: 0,
          refundedCents: 0,
          paymentMethod: null,
          dueAt: null,
          paidAt: null,
          remark: null,
          createdAt: clock.now(),
          updatedAt: clock.now(),
          ...data,
        }
        store.orders.set(row.id, row)
        return { ...row }
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = store.orders.get(where.id)
        if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' })
        return { ...applyUpdate(row, data) }
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0
        for (const row of values(store.orders)) {
          if (!matches(row, where)) continue
          applyUpdate(row, data)
          count += 1
        }
        return { count }
      }),
    },
    orderItem: {
      findMany: vi.fn(async ({ where, select }: any) =>
        values(store.items)
          .filter((i) => matches(i, where))
          .map((i) => (select ? pick(i, select) : { ...i })),
      ),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: nextId('item'), createdAt: clock.now(), updatedAt: clock.now(), ...data }
        store.items.set(row.id, row)
        return { ...row }
      }),
    },
    orderEvent: {
      findFirst: vi.fn(async ({ where, orderBy, select }: any) => {
        const rows = applyOrderBy(store.events.filter((e) => matches(e, where)), orderBy ?? [{ createdAt: 'desc' }, { id: 'desc' }])
        const first = rows[0]
        return first ? (select ? pick(first, select) : { ...first }) : null
      }),
      findMany: vi.fn(async ({ where, orderBy, take }: any) => {
        let rows = applyOrderBy(store.events.filter((e) => matches(e, where)), orderBy)
        if (take !== undefined) rows = rows.slice(0, take)
        return rows.map((e) => ({ ...e }))
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: nextId('evt'), createdAt: clock.now(), ...data }
        store.events.push(row)
        return { ...row }
      }),
    },
    paymentTransaction: {
      findUnique: vi.fn(async ({ where, include }: any) => {
        let row: Record<string, any> | null = null
        if (where.id !== undefined) row = store.payments.get(where.id) ?? null
        else if (where.channelTxnNo !== undefined)
          row = values(store.payments).find((p) => p.channelTxnNo === where.channelTxnNo) ?? null
        else if (where.channelOrderNo !== undefined)
          row = values(store.payments).find((p) => p.channelOrderNo === where.channelOrderNo) ?? null
        if (!row) return null
        return withIncludes('paymentTransaction', row, include)
      }),
      findFirst: vi.fn(async ({ where, orderBy }: any) => {
        const rows = applyOrderBy(values(store.payments).filter((p) => matches(p, where)), orderBy ?? [{ createdAt: 'desc' }])
        return rows[0] ? { ...rows[0] } : null
      }),
      findMany: vi.fn(async ({ where, orderBy, skip, take, include }: any) => {
        let rows = applyOrderBy(values(store.payments).filter((p) => matches(p, where)), orderBy)
        if (skip) rows = rows.slice(skip)
        if (take !== undefined) rows = rows.slice(0, take)
        return rows.map((p) => withIncludes('paymentTransaction', p, include))
      }),
      count: vi.fn(async ({ where }: any) => values(store.payments).filter((p) => matches(p, where)).length),
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: nextId('pay'),
          currency: 'CNY',
          channelTxnNo: null,
          channelOrderNo: null,
          voucherFileKey: null,
          confirmedById: null,
          rawPayload: null,
          createdAt: clock.now(),
          ...data,
        }
        store.payments.set(row.id, row)
        return { ...row }
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0
        for (const row of values(store.payments)) {
          if (!matches(row, where)) continue
          applyUpdate(row, data)
          count += 1
        }
        return { count }
      }),
    },
    refundTransaction: {
      findUnique: vi.fn(async ({ where, include }: any) => {
        const row = store.refunds.get(where.id) ?? null
        if (!row) return null
        return withIncludes('refundTransaction', row, include)
      }),
      findMany: vi.fn(async ({ where, orderBy }: any) =>
        applyOrderBy(values(store.refunds).filter((r) => matches(r, where)), orderBy).map((r) => ({ ...r })),
      ),
      count: vi.fn(async ({ where }: any) => values(store.refunds).filter((r) => matches(r, where)).length),
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: nextId('rf'),
          currency: 'CNY',
          reason: null,
          approvedById: null,
          channelRefundNo: null,
          executedAt: null,
          createdAt: clock.now(),
          ...data,
        }
        store.refunds.set(row.id, row)
        return { ...row }
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0
        for (const row of values(store.refunds)) {
          if (!matches(row, where)) continue
          applyUpdate(row, data)
          count += 1
        }
        return { count }
      }),
    },
    subscription: {
      findFirst: vi.fn(async ({ where, orderBy }: any) => {
        const rows = applyOrderBy(values(store.subscriptions).filter((s) => matches(s, where)), orderBy)
        return rows[0] ? { ...rows[0] } : null
      }),
      findMany: vi.fn(async ({ where, orderBy, take, include }: any) => {
        let rows = applyOrderBy(values(store.subscriptions).filter((s) => matches(s, where)), orderBy)
        if (take !== undefined) rows = rows.slice(0, take)
        return rows.map((s) => withIncludes('subscription', s, include))
      }),
      create: vi.fn(async ({ data }: any) => {
        // @@unique([sourceOrderId, planId])：开通 worker 幂等锚
        if (values(store.subscriptions).some((s) => s.sourceOrderId === data.sourceOrderId && s.planId === data.planId)) {
          throw p2002(['sourceOrderId', 'planId'])
        }
        const row = {
          id: nextId('sub'),
          createdAt: clock.now(),
          updatedAt: clock.now(),
          ...data,
        }
        store.subscriptions.set(row.id, row)
        return { ...row }
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = store.subscriptions.get(where.id)
        if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' })
        return { ...applyUpdate(row, data) }
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0
        for (const row of values(store.subscriptions)) {
          if (!matches(row, where)) continue
          applyUpdate(row, data)
          count += 1
        }
        return { count }
      }),
    },
    serviceDelivery: {
      findFirst: vi.fn(async ({ where }: any) => {
        const row = values(store.deliveries).find((d) => matches(d, where))
        return row ? { ...row } : null
      }),
      findMany: vi.fn(async ({ where }: any) =>
        values(store.deliveries).filter((d) => matches(d, where)).map((d) => ({ ...d })),
      ),
      create: vi.fn(async ({ data }: any) => {
        // orderItemId @unique：交付单幂等锚
        if (values(store.deliveries).some((d) => d.orderItemId === data.orderItemId)) {
          throw p2002(['orderItemId'])
        }
        const row = {
          id: nextId('sd'),
          assigneeId: null,
          acceptedAt: null,
          createdAt: clock.now(),
          updatedAt: clock.now(),
          ...data,
        }
        store.deliveries.set(row.id, row)
        return { ...row }
      }),
    },
    workspace: {
      findUnique: vi.fn(async ({ where }: any) => store.workspaces.get(where.id) ?? null),
      findFirst: vi.fn(async ({ where, orderBy, select }: any) => {
        const rows = applyOrderBy(values(store.workspaces).filter((w) => matches(w, where)), orderBy)
        return rows[0] ? (select ? pick(rows[0], select) : { ...rows[0] }) : null
      }),
      findMany: vi.fn(async ({ where, take }: any) => {
        let rows = values(store.workspaces).filter((w) => matches(w, where))
        if (take !== undefined) rows = rows.slice(0, take)
        return rows.map((w) => ({ ...w }))
      }),
      count: vi.fn(async ({ where }: any) => values(store.workspaces).filter((w) => matches(w, where)).length),
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
          createdAt: clock.now(),
          updatedAt: clock.now(),
          ...data,
        }
        store.workspaces.set(row.id, row)
        return { ...row }
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = store.workspaces.get(where.id)
        if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' })
        return { ...applyUpdate(row, data) }
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0
        for (const row of values(store.workspaces)) {
          if (!matches(row, where)) continue
          applyUpdate(row, data)
          count += 1
        }
        return { count }
      }),
    },
    organization: {
      findUnique: vi.fn(async ({ where, select }: any) => {
        const row = store.orgs.get(where.id) ?? null
        return row ? (select ? pick(row, select) : { ...row }) : null
      }),
    },
    organizationEntitlement: {
      findUnique: vi.fn(async ({ where }: any) => (store.oe.get(where.organizationId) ? { ...store.oe.get(where.organizationId)! } : null)),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const existing = store.oe.get(where.organizationId)
        if (existing) return { ...applyUpdate(existing, update) }
        const row = { updatedAt: clock.now(), ...create }
        store.oe.set(row.organizationId, row)
        return { ...row }
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = store.oe.get(where.organizationId)
        if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' })
        return { ...applyUpdate(row, data) }
      }),
    },
    usageRecord: {
      aggregate: vi.fn(async ({ where }: any) => ({
        _sum: { quantity: store.usageRecords.filter((r) => matches(r, where)).reduce((sum, r) => sum + (r.quantity ?? 0), 0) },
      })),
      findMany: vi.fn(async ({ where }: any) => store.usageRecords.filter((r) => matches(r, where)).map((r) => ({ ...r }))),
    },
    // FOR UPDATE 行锁：按表名回显 store 行（锁语义由单线程顺序执行天然满足）
    $queryRaw: vi.fn(async (strings: TemplateStringsArray | string, ...vals: unknown[]) => {
      const parts = typeof strings === 'string' ? [strings] : (strings as unknown as string[])
      const sql = parts.reduce((acc, part, i) => acc + part + (i < vals.length ? `«${String(vals[i])}»` : ''), '')
      if (sql.includes('"RefundTransaction"')) {
        const row = store.refunds.get(String(vals[0]))
        return row ? [{ id: row.id, status: row.status }] : []
      }
      if (sql.includes('"OrganizationEntitlement"')) {
        const row = store.oe.get(String(vals[0]))
        return row
          ? [{ organizationId: row.organizationId, limits: row.limits, periodStart: row.periodStart, periodEnd: row.periodEnd }]
          : []
      }
      throw new Error(`mock prisma $queryRaw 未实现的 SQL：${sql}`)
    }),
    // 交互式事务直通（条件更新的 count 闸门位于两次写之间——真实语义）
    // 警示（遗留 C14）：本 mock $transaction 直通无回滚持久性——回滚事务内的写会残留，
    // 勿在依赖回滚语义的用例中使用（断言"回滚后无残留"类语义在此 mock 上恒假）。
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>, _opts?: unknown) => fn(prisma)),
  }
  return prisma
}

// ---------------------------------------------------------------------------
// 装配世界：真实服务 + 注入时钟/boss/channel/files/audit，API caller 工厂
// ---------------------------------------------------------------------------

function makeUser(overrides: Record<string, unknown> = {}): User {
  return {
    id: 'u-x',
    username: 'userx',
    displayName: 'User X',
    email: null,
    phone: null,
    passwordHash: 'x',
    userType: 'CUSTOMER',
    platformRole: null,
    organizationId: null,
    orgRole: null,
    status: 'ACTIVE',
    mustChangePassword: false,
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  } as unknown as User
}

const PRO_ENTITLEMENTS = {
  maxWorkspaces: 3,
  maxQueries: 1000,
  allowedPlatforms: ['deepseek', 'qwen'],
}
/** 专业版套餐经 normalize 后的完整 limits 形状（缺失数值字段补 0） */
const PRO_LIMITS = {
  maxWorkspaces: 3,
  maxQueries: 1000,
  maxPages: 0,
  diagnosticRunsPerMonth: 0,
  samplesPerRun: 0,
  optimizationsPerMonth: 0,
  allowedPlatforms: ['deepseek', 'qwen'],
}

function makeWorld() {
  const clock = makeClock(T0)
  const store = makeStore()
  const prisma = makePrisma(store, clock)
  const audit = { record: vi.fn(async () => ({})) }
  const meter = { getMonthlyUsage: vi.fn(async () => 0), record: vi.fn(async () => ({})) }
  let fileSeq = 0
  const files = {
    put: vi.fn(async (_buffer: Buffer, ext: string) => `voucher-${String(++fileSeq).padStart(4, '0')}.${ext}`),
    resolvePath: vi.fn(),
  }
  const boss = { createQueue: vi.fn(async () => ({})), send: vi.fn(async () => ({})) }
  const channel = createMockChannel({ method: 'WECHAT', secret: 'integration-secret' })
  let orderSeq = 0
  const orders = createOrderService({
    prisma,
    now: clock.now,
    randomSuffix: () => `fx${String(++orderSeq).padStart(6, '0')}`,
    files,
    boss,
    channelFactory: () => channel,
  })
  const entitlements = createEntitlementService({ prisma, now: clock.now })
  let refundSeq = 0
  const channelRefund = vi.fn(async () => ({
    channelRefundNo: `mock-rf-${String(++refundSeq).padStart(4, '0')}`,
    status: 'EXECUTED' as const,
  }))
  const refunds = createRefundService({
    prisma,
    orders,
    channelResolver: (() => ({ refund: channelRefund })) as never,
    entitlements,
    audit: audit as never,
    now: clock.now,
  })
  const worker = createOrderActivateWorker({ prisma, orders, entitlements, audit: audit as never, now: clock.now })
  const serviceState = createServiceStateResolver({ prisma, now: clock.now })
  const guard = createEntitlementGuard({ prisma, meter, audit: audit as never, enforcement: () => true, now: clock.now })

  /** 路由层 ctx.services：prisma/服务注入 + §3.3 resolver + 业务探针 */
  const services = {
    prisma,
    orders,
    refunds,
    entitlements,
    audit,
    serviceState,
    getWorkspaceSummary: vi.fn(async () => ({ competitors: ['figma.com'], platforms: {} })),
    taskService: { review: vi.fn(async (id: string, approved: boolean) => ({ id, approved })) },
  }

  let reqSeq = 0
  /** 控制台通道 caller（完整中间件链：csrf → requireUser → org/platformProcedure → requireWorkspace） */
  function userCaller(user: User, workspace?: Workspace) {
    return appRouter.createCaller({
      actor: { kind: 'user', user, session: { id: `sess-${user.id}`, userId: user.id } as unknown as Session },
      ...(workspace ? { workspace } : {}),
      services,
      requestMeta: {
        ip: '127.0.0.1',
        requestId: `req-${++reqSeq}`,
        method: 'POST',
        headers: { 'x-geo-csrf': '1' },
      },
    } as any)
  }
  /** SDK 通道 caller（apiKey actor + 绑定 workspace，判定矩阵同构） */
  function sdkCaller(workspace: Workspace) {
    return appRouter.createCaller({
      actor: {
        kind: 'apiKey',
        credential: { id: `cred-${workspace.id}`, workspaceId: workspace.id } as unknown as ApiCredential,
      },
      workspace,
      services,
      requestMeta: {
        ip: '203.0.113.10',
        requestId: `req-${++reqSeq}`,
        method: 'POST',
        headers: { 'x-geo-csrf': '1' },
      },
    } as any)
  }

  // ----- 种子（直接落内存 store；数据形状与真实行同构） -----
  function seedOrg(input: { id: string; name: string }) {
    store.orgs.set(input.id, { id: input.id, name: input.name, createdAt: T0, updatedAt: T0 })
  }
  function seedPlan(input: {
    id: string
    productId?: string
    code?: string
    name: string
    kind: 'SUBSCRIPTION' | 'ADDON' | 'SERVICE'
    priceCents: number
    billingPeriod?: 'MONTH' | 'YEAR' | null
    entitlements?: Record<string, unknown>
    deliverables?: unknown[]
  }) {
    const productId = input.productId ?? `prod-${input.id}`
    const product = {
      id: productId,
      code: input.code ?? input.id,
      name: input.name,
      kind: input.kind,
      description: '',
      active: true,
      createdAt: T0,
      updatedAt: T0,
    }
    store.products.set(productId, product)
    store.plans.set(input.id, {
      id: input.id,
      productId,
      name: input.name,
      priceCents: input.priceCents,
      billingPeriod: input.billingPeriod ?? null,
      entitlements: input.entitlements ?? {},
      deliverables: input.deliverables ?? [],
      active: true,
      createdAt: T0,
      updatedAt: T0,
      product: { ...product },
    })
  }
  function seedWorkspace(input: {
    id: string
    organizationId: string
    status?: string
    suspendReason?: string | null
    createdAt?: Date
  }) {
    store.workspaces.set(input.id, {
      id: input.id,
      name: `工作区-${input.id}`,
      domain: null,
      llmsTxtUrl: null,
      defaultBrandName: 'Acme',
      platformConfig: {},
      publicationConfig: {},
      status: input.status ?? 'ACTIVE',
      suspendReason: input.suspendReason ?? null,
      organizationId: input.organizationId,
      archivedAt: null,
      createdAt: input.createdAt ?? T0,
      updatedAt: T0,
    })
  }
  function seedSubscription(input: {
    id: string
    organizationId: string
    planId: string
    sourceOrderId: string
    status: string
    startAt?: Date
    endAt: Date
    entitlements?: Record<string, unknown>
  }) {
    store.subscriptions.set(input.id, {
      id: input.id,
      organizationId: input.organizationId,
      planId: input.planId,
      sourceOrderId: input.sourceOrderId,
      startAt: input.startAt ?? T0,
      endAt: input.endAt,
      status: input.status,
      entitlements: input.entitlements ?? {},
      createdAt: T0,
      updatedAt: T0,
    })
  }
  function seedEntitlementRow(organizationId: string, limits: Record<string, unknown>) {
    store.oe.set(organizationId, {
      organizationId,
      limits,
      periodStart: T0,
      periodEnd: new Date(T0.getTime() + 31 * DAY_MS),
      updatedAt: T0,
    })
  }
  function seedOrderRow(input: Record<string, any>) {
    const row = {
      id: input.id,
      orderNo: input.orderNo ?? `GEO-seed-${input.id}`,
      currency: 'CNY',
      discountCents: 0,
      refundedCents: 0,
      paymentMethod: null,
      dueAt: null,
      paidAt: null,
      remark: null,
      createdAt: T0,
      updatedAt: T0,
      ...input,
    }
    store.orders.set(row.id, row)
    return row
  }
  function seedPaymentRow(input: Record<string, any>) {
    const row = {
      currency: 'CNY',
      channelTxnNo: null,
      channelOrderNo: null,
      voucherFileKey: null,
      confirmedById: null,
      rawPayload: null,
      createdAt: T0,
      ...input,
    }
    store.payments.set(row.id, row)
    return row
  }
  function seedItemRow(input: Record<string, any>) {
    const row = { createdAt: T0, updatedAt: T0, ...input }
    store.items.set(row.id, row)
    return row
  }
  const eventsByAction = (action: string) =>
    audit.record.mock.calls.filter(([entry]: [Record<string, any>]) => entry?.action === action)

  return {
    clock,
    store,
    prisma,
    orders,
    refunds,
    entitlements,
    worker,
    serviceState,
    guard,
    boss,
    channel,
    channelRefund,
    audit,
    services,
    userCaller,
    sdkCaller,
    seedOrg,
    seedPlan,
    seedWorkspace,
    seedSubscription,
    seedEntitlementRow,
    seedOrderRow,
    seedPaymentRow,
    seedItemRow,
    eventsByAction,
  }
}

// ---------------------------------------------------------------------------
// ① 回调幂等端到端（§6.3：channelTxnNo 幂等锚贯穿 webhook → service → 队列）
// ---------------------------------------------------------------------------

describe('① 回调幂等端到端：createPayment → handlePaymentCallback 同 channelTxnNo 两次', () => {
  async function paidViaCallback() {
    const w = makeWorld()
    w.seedOrg({ id: 'org-1', name: 'Acme 公司' })
    w.seedPlan({ id: 'plan-pro', name: '专业版', kind: 'SUBSCRIPTION', priceCents: 10000, billingPeriod: 'MONTH', entitlements: PRO_ENTITLEMENTS })
    const created = await w.orders.create({
      organizationId: 'org-1',
      items: [{ planId: 'plan-pro', quantity: 1 }],
      actorId: 'u-owner',
    })
    const { channelOrderNo, payUrl } = await w.orders.createPayment(created.order.id, 'WECHAT')
    return { w, orderId: created.order.id, channelOrderNo, payUrl }
  }

  it('首次回调（验签通过）：流水一条 SUCCEEDED、订单 PAID、boss.send 恰一次、事件恰一条', async () => {
    const { w, orderId, channelOrderNo, payUrl } = await paidViaCallback()
    expect(payUrl).toContain(channelOrderNo) // mock 收银台地址以渠道单号为锚

    const cb = w.channel.buildCallback({ channelOrderNo, channelTxnNo: 'mock-txn-abc' })
    const result = await handlePaymentCallback(w.channel, cb.rawBody, cb.headers, { prisma: w.prisma, orders: w.orders })
    expect(result).toEqual({ duplicate: false })

    // 流水：一条（PENDING → SUCCEEDED），channelTxnNo/channelOrderNo 回填、rawPayload 留痕
    const payments = [...w.store.payments.values()]
    expect(payments).toHaveLength(1)
    expect(payments[0]).toMatchObject({
      orderId,
      method: 'WECHAT',
      status: 'SUCCEEDED',
      channelTxnNo: 'mock-txn-abc',
      channelOrderNo,
    })
    expect(payments[0].rawPayload).toMatchObject({ callbackBody: cb.rawBody })

    // 订单：PAID + paidAt/paymentMethod 回填（与时钟一致）
    const order = w.store.orders.get(orderId)!
    expect(order.status).toBe('PAID')
    expect(order.paymentMethod).toBe('WECHAT')
    expect(order.paidAt).toEqual(w.clock.now())

    // 迁移事件恰一条；开通任务投递恰一次（事务提交后）
    expect(w.store.events.filter((e) => e.orderId === orderId && e.event === 'payment.confirmed')).toHaveLength(1)
    expect(w.boss.send).toHaveBeenCalledTimes(1)
    expect(w.boss.send).toHaveBeenCalledWith(ORDER_ACTIVATION_QUEUE, { orderId }, ORDER_ACTIVATION_SEND_OPTIONS)
  })

  it('同 channelTxnNo 二次回调：duplicate:true、不重复投递、不重复流水/事件，订单仍 PAID', async () => {
    const { w, orderId, channelOrderNo } = await paidViaCallback()
    const cb = w.channel.buildCallback({ channelOrderNo, channelTxnNo: 'mock-txn-abc' })
    await handlePaymentCallback(w.channel, cb.rawBody, cb.headers, { prisma: w.prisma, orders: w.orders })

    const second = await handlePaymentCallback(w.channel, cb.rawBody, cb.headers, { prisma: w.prisma, orders: w.orders })
    expect(second).toEqual({ duplicate: true })

    // 状态形状：全链无第二笔副作用
    expect([...w.store.payments.values()]).toHaveLength(1)
    expect(w.store.payments.get([...w.store.payments.keys()][0])!.status).toBe('SUCCEEDED')
    expect(w.store.events.filter((e) => e.orderId === orderId && e.event === 'payment.confirmed')).toHaveLength(1)
    expect(w.boss.send).toHaveBeenCalledTimes(1)
    expect(w.store.orders.get(orderId)!.status).toBe('PAID')
  })
})

// ---------------------------------------------------------------------------
// ② 退款幂等（行锁串行化：重复 approve → RefundAlreadyExecutedError、渠道不双发）
// ---------------------------------------------------------------------------

describe('② 退款幂等：approve 后重复 approve 被拒，channel.refund 不再调', () => {
  function refundWorld() {
    const w = makeWorld()
    w.seedOrg({ id: 'org-1', name: 'Acme 公司' })
    w.seedPlan({ id: 'plan-pro', name: '专业版', kind: 'SUBSCRIPTION', priceCents: 30000, billingPeriod: 'MONTH' })
    w.seedOrderRow({
      id: 'o1',
      organizationId: 'org-1',
      status: 'COMPLETED',
      totalCents: 30000,
      payableCents: 30000,
      paymentMethod: 'WECHAT',
      paidAt: new Date('2026-10-05T12:00:00.000Z'),
    })
    w.seedItemRow({
      id: 'item-1',
      orderId: 'o1',
      planId: 'plan-pro',
      workspaceId: null,
      quantity: 1,
      unitPriceCents: 30000,
      planSnapshot: { name: '专业版', kind: 'SUBSCRIPTION', priceCents: 30000, billingPeriod: 'MONTH', entitlements: {}, deliverables: [] },
    })
    w.seedPaymentRow({
      id: 'pay-1',
      orderId: 'o1',
      method: 'WECHAT',
      amountCents: 30000,
      status: 'SUCCEEDED',
      channelTxnNo: 'mock-txn-1',
      channelOrderNo: 'mock-co-1',
      confirmedById: 'u-fin',
    })
    // 30 天周期、刚开通即退款：proration = 全额
    w.seedSubscription({
      id: 'sub-1',
      organizationId: 'org-1',
      planId: 'plan-pro',
      sourceOrderId: 'o1',
      status: 'ACTIVE',
      startAt: T0,
      endAt: new Date(T0.getTime() + 30 * DAY_MS),
      entitlements: { maxWorkspaces: 5 },
    })
    w.seedWorkspace({ id: 'ws-1', organizationId: 'org-1' })
    return w
  }

  it('request → approve 全额：渠道退款一次、订单 REFUNDED、订阅 EXPIRED、workspace 暂停、配额清零', async () => {
    const w = refundWorld()
    const req = await w.refunds.request('o1', { reason: '产品不满意' }, 'u-owner')
    expect(w.store.orders.get('o1')!.status).toBe('REFUNDING')
    expect(w.store.refunds.get(req.refund.id)).toMatchObject({ status: 'PENDING', amountCents: 30000 })

    const approved = await w.refunds.approve(req.refund.id, undefined, 'u-fin')
    expect(approved).toMatchObject({ executeAmountCents: 30000, full: true, online: true, workspaceSuspended: 1 })

    // 数据形状穿透：退款流水 EXECUTED + 渠道退款号；订单 REFUNDED + refundedCents 累加；
    // 原支付冲抵 REFUNDED；订阅 EXPIRED；workspace 因无其他有效服务被暂停；OE 重算清零
    expect(w.channelRefund).toHaveBeenCalledTimes(1)
    const refundRow = w.store.refunds.get(req.refund.id)!
    expect(refundRow.status).toBe('EXECUTED')
    expect(refundRow.channelRefundNo).toMatch(/^mock-rf-\d{4}$/)
    expect(w.store.orders.get('o1')).toMatchObject({ status: 'REFUNDED', refundedCents: 30000 })
    expect(w.store.payments.get('pay-1')!.status).toBe('REFUNDED')
    expect(w.store.subscriptions.get('sub-1')!.status).toBe('EXPIRED')
    expect(w.store.workspaces.get('ws-1')).toMatchObject({ status: 'SUSPENDED', suspendReason: '订阅到期' })
    expect((await w.entitlements.getLimits('org-1')).limits).toEqual({
      maxWorkspaces: 0,
      maxQueries: 0,
      maxPages: 0,
      diagnosticRunsPerMonth: 0,
      samplesPerRun: 0,
      optimizationsPerMonth: 0,
      allowedPlatforms: [],
    })
  })

  it('重复 approve：RefundAlreadyExecutedError，渠道退款不再调、流水/订单状态不变', async () => {
    const w = refundWorld()
    const req = await w.refunds.request('o1', { reason: '产品不满意' }, 'u-owner')
    await w.refunds.approve(req.refund.id, undefined, 'u-fin')
    const executedAtFirst = w.store.refunds.get(req.refund.id)!.executedAt
    const channelRefundNoFirst = w.store.refunds.get(req.refund.id)!.channelRefundNo

    await expect(w.refunds.approve(req.refund.id, undefined, 'u-fin')).rejects.toBeInstanceOf(RefundAlreadyExecutedError)

    expect(w.channelRefund).toHaveBeenCalledTimes(1) // 渠道退款不双发（外部副作用幂等）
    const row = w.store.refunds.get(req.refund.id)!
    expect(row.status).toBe('EXECUTED')
    expect(row.channelRefundNo).toBe(channelRefundNoFirst) // 幂等锚不被改写
    expect(row.executedAt).toEqual(executedAtFirst)
    expect(w.store.orders.get('o1')).toMatchObject({ status: 'REFUNDED', refundedCents: 30000 }) // 不二次累加
  })
})

// ---------------------------------------------------------------------------
// ③ 开通 worker 重试幂等（入口状态闸 + 数据幂等锚，pg-boss 重试无重复副作用）
// ---------------------------------------------------------------------------

describe('③ 开通 worker 重试幂等：confirmPayment 真实 enqueue → activateOrder 两遍', () => {
  async function activatedOnce() {
    const w = makeWorld()
    w.seedOrg({ id: 'org-1', name: 'Acme 公司' })
    w.seedPlan({ id: 'plan-pro', name: '专业版', kind: 'SUBSCRIPTION', priceCents: 10000, billingPeriod: 'MONTH', entitlements: { maxWorkspaces: 3 } })
    w.seedPlan({
      id: 'plan-svc',
      name: 'SEO 优化服务',
      kind: 'SERVICE',
      priceCents: 20000,
      deliverables: [{ name: '站群诊断', days: 7 }],
    })
    const created = await w.orders.create({
      organizationId: 'org-1',
      items: [
        { planId: 'plan-pro', quantity: 1 },
        { planId: 'plan-svc', quantity: 1 },
      ],
      actorId: 'u-owner',
    })
    expect(created.order.payableCents).toBe(30000)
    await w.orders.uploadVoucher(created.order.id, { fileName: 'receipt.png', contentBase64: VOUCHER_B64 }, 'u-owner')
    const pending = [...w.store.payments.values()].find((p) => p.orderId === created.order.id)!
    await w.orders.confirmPayment(pending.id, 'u-fin')
    return { w, orderId: created.order.id }
  }

  it('第一遍：boss 收到真实投递载荷；Subscription/ServiceDelivery 各一条、含 SERVICE 行停留 FULFILLING、配额生效', async () => {
    const { w, orderId } = await activatedOnce()

    // 真实 enqueue：从 mock boss 的投递载荷驱动 worker（模拟消费者）
    expect(w.boss.send).toHaveBeenCalledTimes(1)
    const [queue, payload, options] = w.boss.send.mock.calls[0]
    expect(queue).toBe(ORDER_ACTIVATION_QUEUE)
    expect(payload).toEqual({ orderId })
    expect(options).toEqual(ORDER_ACTIVATION_SEND_OPTIONS)

    expect(await w.worker.activateOrder(orderId)).toEqual({ activated: true })

    const subs = [...w.store.subscriptions.values()]
    expect(subs).toHaveLength(1)
    expect(subs[0]).toMatchObject({ organizationId: 'org-1', planId: 'plan-pro', status: 'ACTIVE' })
    expect(subs[0].startAt).toEqual(w.clock.now())
    expect(subs[0].endAt).toEqual(new Date('2026-11-15T12:00:00.000Z')) // MONTH 周期（月末钳制）

    const deliveries = [...w.store.deliveries.values()]
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].status).toBe('PENDING_ASSIGN')
    expect(deliveries[0].milestones).toEqual([{ name: '站群诊断', days: 7, status: 'PENDING' }])
    // 首个 workspace 自动创建，SERVICE 交付单归属解析到它
    const workspaces = [...w.store.workspaces.values()]
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0]).toMatchObject({ organizationId: 'org-1', name: 'Acme 公司' })
    expect(deliveries[0].workspaceId).toBe(workspaces[0].id)

    // 含 SERVICE 行 → 订单停留 FULFILLING（P4 里程碑验收后 complete）
    expect(w.store.orders.get(orderId)!.status).toBe('FULFILLING')
    // 配额重算已生效 + 交付通知 audit 恰一次
    expect((await w.entitlements.getLimits('org-1')).limits.maxWorkspaces).toBe(3)
    expect(w.eventsByAction('delivery.pending_assignment')).toHaveLength(1)
  })

  it('第二遍（重试重放）：订阅/交付单仍各一条、endAt 不变、OE 不变、无 subscription.extend 标记', async () => {
    const { w, orderId } = await activatedOnce()
    await w.worker.activateOrder(orderId)

    const subBefore = [...w.store.subscriptions.values()][0]
    const endAtBefore = subBefore.endAt
    const oeBefore = (await w.entitlements.getLimits('org-1')).limits

    const second = await w.worker.activateOrder(orderId)
    expect(second).toEqual({ activated: true })

    // 幂等锚穿透：不重复建行、不重复延长、不重复通知
    expect([...w.store.subscriptions.values()]).toHaveLength(1)
    expect([...w.store.subscriptions.values()][0].endAt).toBe(endAtBefore) // 引用未变 = 未被写
    expect([...w.store.deliveries.values()]).toHaveLength(1)
    expect(w.store.events.filter((e) => e.event === SUBSCRIPTION_EXTEND_MARKER_EVENT)).toHaveLength(0)
    expect(w.eventsByAction('delivery.pending_assignment')).toHaveLength(1)
    expect(w.boss.send).toHaveBeenCalledTimes(1) // 确认只投递一次，重放不补投
    expect(await w.entitlements.getLimits('org-1')).toMatchObject({ limits: oeBefore })
    expect(w.store.orders.get(orderId)!.status).toBe('FULFILLING')
  })
})

// ---------------------------------------------------------------------------
// ④ maxWorkspaces 行锁并发语义（FOR UPDATE 串行化：第二个事务的 count 能看到
//    第一个事务已提交的行 → 拒。真实 PG 并发在单测不可达，用有状态内存 mock
//    顺序执行两个事务模拟——照任务 9 的串行化论证用例加深到 acquire+create 组合）
// ---------------------------------------------------------------------------

describe('④ maxWorkspaces 行锁并发：hardCheck 事务序列化（acquire → create → commit → 下一个 acquire 拒）', () => {
  function quotaWorld(limit = 2) {
    const w = makeWorld()
    w.seedOrg({ id: 'org-w', name: '配额企业' })
    w.seedEntitlementRow('org-w', { maxWorkspaces: limit })
    w.seedWorkspace({ id: 'ws-w1', organizationId: 'org-w' })
    return w
  }

  it('事务 1 持锁创建提交后，事务 2 的 count 看到新行 → QuotaExceededError（不超卖）', async () => {
    const w = quotaWorld(2)

    // 事务 1：acquire（count=1 < 2 通过）→ 业务在锁窗口内创建第 2 个 workspace → commit
    const slot1 = await w.guard.acquireWorkspaceQuotaSlot('org-w')
    await w.prisma.workspace.create({ data: { name: '第二个工作区', organizationId: 'org-w' } })
    await slot1.commit()

    // 事务 2（顺序开始于事务 1 提交之后）：count=2 ≥ limit=2 → 拒
    await expect(w.guard.acquireWorkspaceQuotaSlot('org-w')).rejects.toMatchObject({
      name: 'QUOTA_EXCEEDED',
      field: 'maxWorkspaces',
      limit: 2,
      current: 2,
    })
    expect([...w.store.workspaces.values()].filter((ws) => ws.organizationId === 'org-w')).toHaveLength(2)
  })

  it('rollback 不占位（count 不变，下次 acquire 通过）；hardCheck 达限直拒；enforcement off 全放行', async () => {
    const w = quotaWorld(2)

    // rollback：检查事务回滚，未创建的槽位不占用
    const slot = await w.guard.acquireWorkspaceQuotaSlot('org-w')
    await slot.rollback()
    const slot2 = await w.guard.acquireWorkspaceQuotaSlot('org-w')
    await slot2.commit()

    // 达到上限后 hardCheck 直拒（错误携带 field/limit/current 数据形状）
    w.seedWorkspace({ id: 'ws-w2', organizationId: 'org-w' })
    await expect(w.guard.hardCheck('org-w', 'maxWorkspaces')).rejects.toBeInstanceOf(QuotaExceededError)
    await expect(w.guard.hardCheck('org-w', 'maxWorkspaces')).rejects.toMatchObject({
      name: 'QUOTA_EXCEEDED',
      limit: 2,
      current: 2,
    })

    // 对照：enforcement off → 零查询全放行（Ruling 1；prisma 共享同一内存世界）
    const offGuard = createEntitlementGuard({
      prisma: w.prisma,
      meter: { getMonthlyUsage: vi.fn(async () => 0), record: vi.fn(async () => ({})) },
      audit: { record: vi.fn(async () => ({})) } as never,
      enforcement: () => false,
      now: w.clock.now,
    })
    await expect(offGuard.hardCheck('org-w', 'maxWorkspaces')).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// ⑤ §3.3 服务状态矩阵（BILLING_ENFORCEMENT=on + 真实 resolver 注入 requireWorkspace）
// ---------------------------------------------------------------------------

describe('⑤ §3.3 服务状态矩阵（BILLING_ENFORCEMENT=on，真实 service-state resolver）', () => {
  const prevEnv = process.env.BILLING_ENFORCEMENT
  beforeEach(() => {
    process.env.BILLING_ENFORCEMENT = 'on'
  })
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.BILLING_ENFORCEMENT
    else process.env.BILLING_ENFORCEMENT = prevEnv
  })

  function matrixWorld() {
    const w = makeWorld()
    w.seedPlan({ id: 'plan-x', name: '标准版', kind: 'SUBSCRIPTION', priceCents: 10000, billingPeriod: 'MONTH' })
    // ACTIVE：有效订阅（endAt > now）
    w.seedOrg({ id: 'org-ok', name: '正常企业' })
    w.seedSubscription({ id: 'sub-ok', organizationId: 'org-ok', planId: 'plan-x', sourceOrderId: 'o-ok', status: 'ACTIVE', endAt: new Date(T0.getTime() + 30 * DAY_MS) })
    w.seedWorkspace({ id: 'ws-ok', organizationId: 'org-ok' })
    // GRACE：订阅已迁宽限（workspace 仍 ACTIVE）
    w.seedOrg({ id: 'org-grace', name: '宽限企业' })
    w.seedSubscription({ id: 'sub-grace', organizationId: 'org-grace', planId: 'plan-x', sourceOrderId: 'o-grace', status: 'GRACE', endAt: new Date(T0.getTime() - DAY_MS) })
    w.seedWorkspace({ id: 'ws-grace', organizationId: 'org-grace' })
    // NONE × ACTIVE workspace：订阅已过期、暂停尚未发生（"ACTIVE+NONE"全拒行）
    w.seedOrg({ id: 'org-none', name: '无服务企业' })
    w.seedSubscription({ id: 'sub-none', organizationId: 'org-none', planId: 'plan-x', sourceOrderId: 'o-none', status: 'EXPIRED', endAt: new Date(T0.getTime() - DAY_MS) })
    w.seedWorkspace({ id: 'ws-none', organizationId: 'org-none' })
    // NONE × SUSPENDED workspace（expire-check 已暂停）：历史数据只读开放
    w.seedOrg({ id: 'org-hist', name: '历史企业' })
    w.seedSubscription({ id: 'sub-hist', organizationId: 'org-hist', planId: 'plan-x', sourceOrderId: 'o-hist', status: 'EXPIRED', endAt: new Date(T0.getTime() - DAY_MS) })
    w.seedWorkspace({ id: 'ws-hist', organizationId: 'org-hist', status: 'SUSPENDED', suspendReason: '订阅到期' })
    return w
  }
  const ownerOf = (organizationId: string) =>
    makeUser({ id: `u-owner-${organizationId}`, username: `owner-${organizationId}`, userType: 'CUSTOMER', orgRole: 'ORG_OWNER', organizationId })

  it('GRACE：业务 query ✓（读不受限）/ mutation FORBIDDEN「宽限期只读，请续费」，业务服务未被触达', async () => {
    const w = matrixWorld()
    const caller = w.userCaller(ownerOf('org-grace'), w.store.workspaces.get('ws-grace') as unknown as Workspace)

    const projection = await caller.workspace.get()
    expect(projection).toMatchObject({ id: 'ws-grace', status: 'ACTIVE' })
    expect(w.services.getWorkspaceSummary).toHaveBeenCalledWith('ws-grace')

    await expect(caller.tasks.review({ id: 't-1', approved: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('宽限期只读，请续费'),
    })
    expect(w.services.taskService.review).not.toHaveBeenCalled()
  })

  it('EXPIRED×ACTIVE workspace（NONE）：query 与 mutation 全拒「无有效服务」；EXPIRED×SUSPENDED：历史数据只读（query ✓ / mutation 拒且文案为工作区"只读"）', async () => {
    const w = matrixWorld()

    // "ACTIVE+NONE"行：读写均拒，服务未被触达
    const noneCaller = w.userCaller(ownerOf('org-none'), w.store.workspaces.get('ws-none') as unknown as Workspace)
    await expect(noneCaller.workspace.get()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('无有效服务'),
    })
    await expect(noneCaller.tasks.review({ id: 't-1', approved: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('无有效服务'),
    })
    expect(w.services.getWorkspaceSummary).not.toHaveBeenCalled()
    expect(w.services.taskService.review).not.toHaveBeenCalled()

    // 历史数据只读（§5.2）：SUSPENDED × NONE → query ✓（含摘要），mutation 拒于工作区只读（非"无有效服务"）
    const histCaller = w.userCaller(ownerOf('org-hist'), w.store.workspaces.get('ws-hist') as unknown as Workspace)
    const histProjection = await histCaller.workspace.get()
    expect(histProjection).toMatchObject({ id: 'ws-hist', status: 'SUSPENDED' })
    await expect(histCaller.tasks.review({ id: 't-1', approved: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('只读'),
    })
    // 文案来自 workspace.status 分支（已暂停），不是服务状态分支
    await expect(histCaller.tasks.review({ id: 't-1', approved: true })).rejects.toMatchObject({
      message: expect.not.stringContaining('无有效服务'),
    })
  })

  it('apiKey（SDK）通道同矩阵：GRACE 写拒、ACTIVE 服务状态读写放行（服务被真实触达）', async () => {
    const w = matrixWorld()

    const graceSdk = w.sdkCaller(w.store.workspaces.get('ws-grace') as unknown as Workspace)
    await expect(graceSdk.workspace.get()).resolves.toMatchObject({ id: 'ws-grace' })
    await expect(graceSdk.tasks.review({ id: 't-1', approved: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('宽限期只读，请续费'),
    })

    const okSdk = w.sdkCaller(w.store.workspaces.get('ws-ok') as unknown as Workspace)
    await expect(okSdk.workspace.get()).resolves.toMatchObject({ id: 'ws-ok', status: 'ACTIVE' })
    await expect(okSdk.tasks.review({ id: 't-1', approved: true })).resolves.toMatchObject({ id: 't-1', approved: true })
    expect(w.services.taskService.review).toHaveBeenCalledWith('t-1', true, undefined)
  })

  it('apiKey（SDK）通道 × EXPIRED+SUSPENDED（遗留 C8 矩阵补格）：query ✓ / mutation 拒，文案来自工作区分支非服务状态分支', async () => {
    const w = matrixWorld()

    // 历史数据只读（§5.2）在 SDK 通道同样成立：query 放行（含摘要触达）
    const histSdk = w.sdkCaller(w.store.workspaces.get('ws-hist') as unknown as Workspace)
    await expect(histSdk.workspace.get()).resolves.toMatchObject({ id: 'ws-hist', status: 'SUSPENDED' })
    expect(w.services.getWorkspaceSummary).toHaveBeenCalledWith('ws-hist')

    // mutation 拒于 workspace.status 只读检查（照同文件既有矩阵断言模式：含「只读」且不含「无有效服务」）
    await expect(histSdk.tasks.review({ id: 't-1', approved: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('只读'),
    })
    await expect(histSdk.tasks.review({ id: 't-1', approved: true })).rejects.toMatchObject({
      message: expect.not.stringContaining('无有效服务'),
    })
    expect(w.services.taskService.review).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// ⑥ API 级全链路：下单 → 财务确认 → 开通 → 配额生效 → 到期暂停 → 续费恢复
// ---------------------------------------------------------------------------

describe('⑥ API 级全链路（真实 appRouter.createCaller + FINANCE 平台角色）', () => {
  const ownerUser = makeUser({ id: 'u-owner', username: 'owner1', userType: 'CUSTOMER', orgRole: 'ORG_OWNER', organizationId: 'org-1' })
  const financeUser = makeUser({ id: 'u-fin', username: 'fin1', userType: 'PLATFORM', platformRole: 'FINANCE' })

  function fullWorld() {
    const w = makeWorld()
    w.seedOrg({ id: 'org-1', name: 'Acme 公司' })
    w.seedPlan({ id: 'plan-pro', name: '专业版', kind: 'SUBSCRIPTION', priceCents: 10000, billingPeriod: 'MONTH', entitlements: PRO_ENTITLEMENTS })
    return w
  }
  /** 走到「开通完成」为止的公共链路（API 级） */
  async function activatedWorld() {
    const w = fullWorld()
    const owner = w.userCaller(ownerUser)
    const fin = w.userCaller(financeUser)
    const created = await owner.orders.create({ items: [{ planId: 'plan-pro', quantity: 1 }] })
    const orderId = created.order.id
    await owner.orders.uploadVoucher({ orderId, fileName: 'receipt.png', contentBase64: VOUCHER_B64 })
    const queue = await fin.admin.payments.list({ view: 'VOUCHER' })
    await fin.admin.payments.confirm({ paymentId: queue.items[0].id })
    await w.worker.activateOrder(orderId)
    return { w, owner, fin, orderId }
  }

  it('下单（快照金额固化）→ 回单 → FINANCE 确认 → 开通：Subscription/workspace 落库、配额经 API 读路径生效', async () => {
    const w = fullWorld()
    const owner = w.userCaller(ownerUser)
    const fin = w.userCaller(financeUser)

    // 下单：金额与快照固化（priceCents/kind/周期/配额声明进 planSnapshot）
    const created = await owner.orders.create({ items: [{ planId: 'plan-pro', quantity: 1 }] })
    expect(created.order).toMatchObject({ status: 'PENDING_PAYMENT', totalCents: 10000, payableCents: 10000, currency: 'CNY' })
    expect(created.order.orderNo).toMatch(/^GEO261015fx\d{6}$/)
    expect(created.items[0].planSnapshot).toEqual({
      name: '专业版',
      kind: 'SUBSCRIPTION',
      priceCents: 10000,
      billingPeriod: 'MONTH',
      entitlements: PRO_ENTITLEMENTS,
      deliverables: [],
    })

    // 客户上传回单 → 财务工作台待确认队列可见 → FINANCE 确认（P2 §2.2 权限点经真实 platformProcedure）
    const orderId = created.order.id
    await owner.orders.uploadVoucher({ orderId, fileName: 'receipt.png', contentBase64: VOUCHER_B64 })
    expect(w.store.orders.get(orderId)!.status).toBe('PENDING_CONFIRMATION')
    const queue = await fin.admin.payments.list({ view: 'VOUCHER' })
    expect(queue.total).toBe(1)
    expect(queue.items[0]).toMatchObject({ orderId, method: 'BANK_TRANSFER', status: 'PENDING', amountCents: 10000 })
    expect(queue.items[0].order).toMatchObject({ orderNo: created.order.orderNo, organizationId: 'org-1' })

    await fin.admin.payments.confirm({ paymentId: queue.items[0].id })
    expect(w.store.orders.get(orderId)!.status).toBe('PAID')
    expect(w.boss.send).toHaveBeenCalledTimes(1)

    // 开通：订单 COMPLETED（无 SERVICE 行）、Subscription ACTIVE、首个 workspace 自动创建
    await w.worker.activateOrder(orderId)
    expect(w.store.orders.get(orderId)!.status).toBe('COMPLETED')
    const sub = [...w.store.subscriptions.values()][0]
    expect(sub).toMatchObject({ organizationId: 'org-1', planId: 'plan-pro', status: 'ACTIVE', sourceOrderId: orderId })
    expect(sub.endAt).toEqual(new Date('2026-11-15T12:00:00.000Z'))
    const ws = [...w.store.workspaces.values()][0]
    expect(ws).toMatchObject({ organizationId: 'org-1', name: 'Acme 公司', status: 'ACTIVE' })

    // 配额生效：客户侧 billing 读路径（getLimits 不重算，读到的即 recompute 落库值）
    const entitlements = await owner.billing.entitlements()
    expect(entitlements.limits).toEqual(PRO_LIMITS)
    expect(entitlements.usage.maxWorkspaces).toBe(1) // 自动创建的 workspace 计入用量
    const subs = await owner.billing.subscriptions()
    expect(subs.items).toHaveLength(1)
    expect(subs.items[0]).toMatchObject({ planId: 'plan-pro', status: 'ACTIVE', planName: '专业版' })
  })

  it('到期：宽限 → 宽限满过期 + workspace 暂停 + 配额清零；续费：activateOrder 复用延长 + 精确恢复', async () => {
    const { w, owner, fin } = await activatedWorld()
    const wsId = [...w.store.workspaces.keys()][0]

    // 推进 31 天：endAt（+1 月）已过 → ACTIVE→GRACE
    w.clock.advance(31 * DAY_MS)
    const first = await runExpireCheck({ prisma: w.prisma, audit: w.audit as never, now: w.clock.now, graceDays: 7, entitlements: w.entitlements })
    expect(first.enteredGrace).toBe(1)
    expect(first.expired).toBe(0)
    expect([...w.store.subscriptions.values()][0].status).toBe('GRACE')
    w.serviceState.invalidate('org-1')
    await expect(w.serviceState.resolve('org-1')).resolves.toBe('GRACE')

    // 再推进 8 天（> 宽限 7 天）：GRACE→EXPIRED + 暂停 workspace（无其他有效服务）+ 配额重算清零
    w.clock.advance(8 * DAY_MS)
    const second = await runExpireCheck({ prisma: w.prisma, audit: w.audit as never, now: w.clock.now, graceDays: 7, entitlements: w.entitlements })
    expect(second.expired).toBe(1)
    expect(second.orphanRestored).toBe(0)
    expect([...w.store.subscriptions.values()][0].status).toBe('EXPIRED')
    expect(w.store.workspaces.get(wsId)).toMatchObject({ status: 'SUSPENDED', suspendReason: '订阅到期' })
    w.serviceState.invalidate('org-1')
    await expect(w.serviceState.resolve('org-1')).resolves.toBe('NONE')
    const zeroed = await owner.billing.entitlements()
    expect(zeroed.limits).toEqual({
      maxWorkspaces: 0,
      maxQueries: 0,
      maxPages: 0,
      diagnosticRunsPerMonth: 0,
      samplesPerRun: 0,
      optimizationsPerMonth: 0,
      allowedPlatforms: [],
    })

    // 续费：同套餐再下一单 → 确认 → 开通（复用延长 + 精确恢复）
    const renewal = await owner.orders.create({ items: [{ planId: 'plan-pro', quantity: 1 }] })
    await owner.orders.uploadVoucher({ orderId: renewal.order.id, fileName: 'receipt.png', contentBase64: VOUCHER_B64 })
    const queue = await fin.admin.payments.list({ view: 'VOUCHER' })
    await fin.admin.payments.confirm({ paymentId: queue.items[0].id })
    expect(w.boss.send).toHaveBeenCalledTimes(2)
    await w.worker.activateOrder(renewal.order.id)

    // 订阅复用（仍一行）：EXPIRED→ACTIVE，endAt = 续费时刻 + 1 月（2026-11-23 + 1mo）
    const subs = [...w.store.subscriptions.values()]
    expect(subs).toHaveLength(1)
    expect(subs[0].status).toBe('ACTIVE')
    expect(subs[0].endAt).toEqual(new Date('2026-12-23T12:00:00.000Z'))
    // workspace 按 suspendReason 精确恢复
    expect(w.store.workspaces.get(wsId)).toMatchObject({ status: 'ACTIVE', suspendReason: null })
    // 延长幂等标记恰一条（本单）；配额恢复；服务状态回 ACTIVE
    expect(w.store.events.filter((e) => e.orderId === renewal.order.id && e.event === SUBSCRIPTION_EXTEND_MARKER_EVENT)).toHaveLength(1)
    const restored = await owner.billing.entitlements()
    expect(restored.limits).toEqual(PRO_LIMITS)
    w.serviceState.invalidate('org-1')
    await expect(w.serviceState.resolve('org-1')).resolves.toBe('ACTIVE')
  })
})

// ---------------------------------------------------------------------------
// ⑦ 跨租户越权（真实 orderRouter createCaller + orgProcedure 权限分治）
// ---------------------------------------------------------------------------

describe('⑦ 跨租户：org A 成员对 org B 订单 get/cancel/uploadVoucher/refundRequest', () => {
  function tenantWorld() {
    const w = makeWorld()
    w.seedOrg({ id: 'org-1', name: '甲公司' })
    w.seedOrg({ id: 'org-2', name: '乙公司' })
    w.seedPlan({ id: 'plan-pro', name: '专业版', kind: 'SUBSCRIPTION', priceCents: 10000, billingPeriod: 'MONTH' })
    const ownerA = w.userCaller(makeUser({ id: 'u-a', username: 'ownerA', userType: 'CUSTOMER', orgRole: 'ORG_OWNER', organizationId: 'org-1' }))
    const ownerB = w.userCaller(makeUser({ id: 'u-b', username: 'ownerB', userType: 'CUSTOMER', orgRole: 'ORG_OWNER', organizationId: 'org-2' }))
    const memberA = w.userCaller(makeUser({ id: 'u-ma', username: 'memberA', userType: 'CUSTOMER', orgRole: 'ORG_MEMBER', organizationId: 'org-1' }))
    const viewerA = w.userCaller(makeUser({ id: 'u-va', username: 'viewerA', userType: 'CUSTOMER', orgRole: 'ORG_VIEWER', organizationId: 'org-1' }))
    return { w, ownerA, ownerB, memberA, viewerA }
  }
  async function twoOrders() {
    const { w, ownerA, ownerB, memberA, viewerA } = tenantWorld()
    const orderB = await ownerB.orders.create({ items: [{ planId: 'plan-pro', quantity: 1 }] })
    const orderA = await ownerA.orders.create({ items: [{ planId: 'plan-pro', quantity: 1 }] })
    return { w, ownerA, ownerB, memberA, viewerA, orderB, orderA }
  }

  it.each([
    {
      label: 'orders.get',
      run: (caller: any, orderId: string) => caller.orders.get({ orderId }),
    },
    {
      label: 'orders.cancel',
      run: (caller: any, orderId: string) => caller.orders.cancel({ orderId, reason: '越权取消' }),
    },
    {
      label: 'orders.uploadVoucher',
      run: (caller: any, orderId: string) =>
        caller.orders.uploadVoucher({ orderId, fileName: 'v.png', contentBase64: VOUCHER_B64 }),
    },
    {
      label: 'orders.refundRequest',
      run: (caller: any, orderId: string) => caller.orders.refundRequest({ orderId, reason: '越权退款' }),
    },
  ])('$label：org-1 OWNER 指向 org-2 订单 → NOT_FOUND，订单状态不变', async ({ run }) => {
    const { w, ownerA, orderB } = await twoOrders()
    await expect(run(ownerA, orderB.order.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('订单不存在'),
    })
    // 不泄露存在性也不产生副作用：org-2 订单保持原状、无流水无队列投递
    expect(w.store.orders.get(orderB.order.id)!.status).toBe('PENDING_PAYMENT')
    expect(w.store.payments.size).toBe(0)
    expect(w.boss.send).not.toHaveBeenCalled()
  })

  it('对照：org-2 OWNER get 本企业订单 ✓；org-1 VIEWER get（无 order.view 权限点）FORBIDDEN；org-1 MEMBER get（order.view）✓', async () => {
    const { w, ownerB, memberA, viewerA, orderB, orderA } = await twoOrders()

    const own = await ownerB.orders.get({ orderId: orderB.order.id })
    expect(own.order).toMatchObject({ id: orderB.order.id, organizationId: 'org-2', status: 'PENDING_PAYMENT' })
    expect(own.items).toHaveLength(1)
    expect(own.items[0]).toMatchObject({ planId: 'plan-pro', unitPriceCents: 10000 })

    // 权限分治（orgProcedure 权限点）：ORG_VIEWER 空表 → FORBIDDEN（企业角色层级拦截）
    await expect(viewerA.orders.get({ orderId: orderA.order.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('ORG_VIEWER'),
    })

    // ORG_MEMBER 持 order.view（Ruling 14）：本企业订单可读
    const asMember = await memberA.orders.get({ orderId: orderA.order.id })
    expect(asMember.order.organizationId).toBe('org-1')
    void w
  })
})
