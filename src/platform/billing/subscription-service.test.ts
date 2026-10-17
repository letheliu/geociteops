import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  EXPIRE_REMINDER_WINDOW_DAYS,
  SUBSCRIPTION_EXPIRED_SUSPEND_REASON,
  runExpireCheck,
} from './subscription-service.js'

// ---------------------------------------------------------------------------
// 订阅到期检查（任务 11，规格 §6.4）：subscription.expire-check 每日 cron 驱动
// runExpireCheck 三段——① 到期前提醒（audit 留痕）② ACTIVE→GRACE ③ 宽限满
// GRACE→EXPIRED + org 全部 ACTIVE workspace 暂停（suspendReason=订阅到期）。
// prisma 内存 mock 照 order-activate.test.ts 模式实现驱动语义子集。
// ---------------------------------------------------------------------------

const FIXED_NOW = () => new Date('2026-10-15T12:00:00.000Z')
const NOW = FIXED_NOW()
const DAY_MS = 86_400_000

function daysFromNow(days: number, driftMs = 0): Date {
  return new Date(NOW.getTime() + days * DAY_MS + driftMs)
}

function makeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    organizationId: 'org-1',
    planId: 'plan-1',
    sourceOrderId: 'o0',
    startAt: new Date('2026-07-01T00:00:00.000Z'),
    endAt: daysFromNow(10),
    status: 'ACTIVE',
    entitlements: { maxWorkspaces: 3 },
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  }
}

function makeWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ws-1',
    name: '客户工作区',
    status: 'ACTIVE',
    suspendReason: null,
    organizationId: 'org-1',
    ...overrides,
  }
}

function makeDb(
  fixtures: {
    subscriptions?: Record<string, any>[]
    workspaces?: Record<string, any>[]
    /** 进行中交付（③ 聚合判定/④ 孤儿恢复的有效服务来源） */
    deliveries?: Record<string, any>[]
    /** subscription.findMany 直接返回的陈旧列表（模拟扫描后状态竞态） */
    staleSubs?: Record<string, any>[]
  } = {},
) {
  const store = {
    subscriptions: (fixtures.subscriptions ?? []).map((s) => ({ ...s })),
    workspaces: (fixtures.workspaces ?? []).map((w) => ({ ...w })),
    deliveries: (fixtures.deliveries ?? []).map((d) => ({ ...d })),
  }
  const prisma: any = {
    subscription: {
      // ③ 聚合判定/④ 孤儿恢复的 org 有效服务探测（organizationId + id.not + OR 形状）
      findFirst: vi.fn(async ({ where }: any) => {
        const rows = store.subscriptions.filter((s) => {
          if (where?.organizationId !== undefined && s.organizationId !== where.organizationId) return false
          if (where?.id?.not !== undefined && s.id === where.id.not) return false
          if (where?.OR) {
            const matched = where.OR.some(
              (alt: any) =>
                (alt.status === undefined || s.status === alt.status) &&
                (alt.endAt?.gt === undefined || s.endAt > alt.endAt.gt),
            )
            if (!matched) return false
          }
          return true
        })
        return rows[0] ? { ...rows[0] } : null
      }),
      findMany: vi.fn(async ({ where, take }: any) => {
        // 陈旧快照（模拟扫描后状态竞态）：快照仍满足当时的 where 条件，
        // 但行本身可能已被并发修改（updateMany 乐观迁移自然丢行）
        const source = fixtures.staleSubs ?? store.subscriptions
        let rows = source.filter((s) => {
          if (where?.status !== undefined && s.status !== where.status) return false
          if (where?.endAt?.gt !== undefined && !(s.endAt > where.endAt.gt)) return false
          if (where?.endAt?.lte !== undefined && !(s.endAt <= where.endAt.lte)) return false
          return true
        })
        rows = [...rows].sort((a, b) => a.endAt.getTime() - b.endAt.getTime())
        if (take !== undefined) rows = rows.slice(0, take)
        return rows.map((r) => ({ ...r }))
      }),
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
    },
    serviceDelivery: {
      // 进行中交付探测（形状复用 service-state：status in + workspace.organizationId 关系）
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
      findMany: vi.fn(async ({ where, take }: any) => {
        let rows = store.workspaces.filter((w) => {
          if (where?.status !== undefined && w.status !== where.status) return false
          if (where?.suspendReason !== undefined && w.suspendReason !== where.suspendReason) return false
          return true
        })
        if (take !== undefined) rows = rows.slice(0, take)
        return rows.map((r) => ({ ...r }))
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0
        for (const w of store.workspaces) {
          if (where?.organizationId !== undefined && w.organizationId !== where.organizationId) continue
          if (where?.status !== undefined && w.status !== where.status) continue
          if (where?.suspendReason !== undefined && w.suspendReason !== where.suspendReason) continue
          Object.assign(w, data, { updatedAt: new Date('2026-10-15T12:00:01.000Z') })
          count += 1
        }
        return { count }
      }),
    },
  }
  return { prisma, store }
}

function actionsOf(audit: { record: ReturnType<typeof vi.fn> }): string[] {
  return audit.record.mock.calls.map((c) => c[0].action)
}

// ---------------------------------------------------------------------------
// ① 提醒：ACTIVE 且 endAt ∈ (now, now+15d] → 每日一条 audit（简化裁定不查重）
// ---------------------------------------------------------------------------

describe('runExpireCheck ① 到期提醒', () => {
  it('15/7/1 天三档均在窗口内 → 各写一条 subscription.expire_reminder（diff.daysLeft 对应档位）', async () => {
    const db = makeDb({
      subscriptions: [
        makeSubscription({ id: 'sub-15', endAt: daysFromNow(15) }),
        makeSubscription({ id: 'sub-7', endAt: daysFromNow(7) }),
        makeSubscription({ id: 'sub-1', endAt: daysFromNow(1) }),
      ],
    })
    const audit = { record: vi.fn(async () => {}) }

    const result = await runExpireCheck({ prisma: db.prisma, audit, now: FIXED_NOW })

    expect(result.reminded).toBe(3)
    expect(actionsOf(audit)).toEqual(
      expect.arrayContaining(['subscription.expire_reminder', 'subscription.expire_reminder', 'subscription.expire_reminder']),
    )
    const byTarget = new Map(
      audit.record.mock.calls.map((c) => [c[0].target, c[0]] as const),
    )
    for (const [subId, days] of [
      ['sub-15', 15],
      ['sub-7', 7],
      ['sub-1', 1],
    ] as const) {
      const entry = byTarget.get(`Subscription:${subId}`)
      expect(entry).toMatchObject({
        actorType: 'SYSTEM',
        action: 'subscription.expire_reminder',
        organizationId: 'org-1',
        target: `Subscription:${subId}`,
      })
      expect(entry!.diff).toMatchObject({ subscriptionId: subId, daysLeft: days })
    }
    // 提醒是留痕，不动状态
    expect(db.store.subscriptions.every((s) => s.status === 'ACTIVE')).toBe(true)
  })

  it(`恰 ${EXPIRE_REMINDER_WINDOW_DAYS} 天（含）提醒；超 1ms / 超一天不提醒；GRACE/已到期(endAt≤now) 不提醒`, async () => {
    const db = makeDb({
      subscriptions: [
        // 恰 15 天：lte 含 → 提醒
        makeSubscription({ id: 'sub-edge', endAt: daysFromNow(15) }),
        // 超 1ms：不提醒
        makeSubscription({ id: 'sub-over', endAt: daysFromNow(15, 1) }),
        // 16 天整：不提醒
        makeSubscription({ id: 'sub-16', endAt: daysFromNow(16) }),
        // 已到期：走 ② GRACE，不提醒
        makeSubscription({ id: 'sub-due', endAt: NOW }),
        // GRACE（不该收到提醒）
        makeSubscription({ id: 'sub-grace', status: 'GRACE', endAt: daysFromNow(-1) }),
      ],
    })
    const audit = { record: vi.fn(async () => {}) }

    const result = await runExpireCheck({ prisma: db.prisma, audit, now: FIXED_NOW })

    const reminders = audit.record.mock.calls.filter((c) => c[0].action === 'subscription.expire_reminder')
    expect(reminders).toHaveLength(1)
    expect(reminders[0][0].target).toBe('Subscription:sub-edge')
    expect(result.reminded).toBe(1)
    // sub-due：endAt=now → ② 迁移 GRACE
    expect(db.store.subscriptions.find((s) => s.id === 'sub-due')!.status).toBe('GRACE')
  })
})

// ---------------------------------------------------------------------------
// ② 到期：ACTIVE 且 endAt ≤ now → GRACE（逐条乐观迁移，并发丢行跳过）
// ---------------------------------------------------------------------------

describe('runExpireCheck ② ACTIVE→GRACE', () => {
  it('endAt ≤ now（边界含 now）→ GRACE + audit subscription.grace；未到期不动', async () => {
    const db = makeDb({
      subscriptions: [
        makeSubscription({ id: 'sub-due', endAt: daysFromNow(-1) }),
        makeSubscription({ id: 'sub-edge', endAt: NOW }),
        makeSubscription({ id: 'sub-future', endAt: daysFromNow(5) }),
      ],
    })
    const audit = { record: vi.fn(async () => {}) }

    const result = await runExpireCheck({ prisma: db.prisma, audit, now: FIXED_NOW })

    expect(result.enteredGrace).toBe(2)
    expect(result.graceSkipped).toBe(0)
    expect(db.store.subscriptions.find((s) => s.id === 'sub-due')!.status).toBe('GRACE')
    expect(db.store.subscriptions.find((s) => s.id === 'sub-edge')!.status).toBe('GRACE')
    expect(db.store.subscriptions.find((s) => s.id === 'sub-future')!.status).toBe('ACTIVE')
    const graceAudits = audit.record.mock.calls.filter((c) => c[0].action === 'subscription.grace')
    expect(graceAudits).toHaveLength(2)
    expect(graceAudits[0][0]).toMatchObject({
      actorType: 'SYSTEM',
      organizationId: 'org-1',
      target: 'Subscription:sub-due',
    })
    expect(graceAudits[0][0].diff).toMatchObject({ subscriptionId: 'sub-due' })
  })

  it('同跑双迁：逾期超宽限的 ACTIVE 行一 run 内 ACTIVE→GRACE→EXPIRED（② 完成后 ③ 扫描）', async () => {
    const db = makeDb({
      subscriptions: [makeSubscription({ id: 'sub-old', endAt: daysFromNow(-30) })],
      workspaces: [makeWorkspace()],
    })
    const audit = { record: vi.fn(async () => {}) }

    const result = await runExpireCheck({ prisma: db.prisma, audit, now: FIXED_NOW })

    expect(result).toMatchObject({ enteredGrace: 1, expired: 1 })
    expect(db.store.subscriptions[0].status).toBe('EXPIRED')
    expect(db.store.workspaces[0]).toMatchObject({
      status: 'SUSPENDED',
      suspendReason: SUBSCRIPTION_EXPIRED_SUSPEND_REASON,
    })
  })
})

// ---------------------------------------------------------------------------
// ③ 宽限满：GRACE 且 endAt+宽限 ≤ now → EXPIRED + org 全部 ACTIVE workspace 暂停
// ---------------------------------------------------------------------------

describe('runExpireCheck ③ GRACE→EXPIRED + workspace 暂停', () => {
  it('宽限届满 → EXPIRED + org 全部 ACTIVE workspace → SUSPENDED（订阅到期）；已暂停的不动 + audit workspaceSuspended', async () => {
    const db = makeDb({
      subscriptions: [
        makeSubscription({ id: 'sub-x', status: 'GRACE', endAt: daysFromNow(-8) }),
      ],
      workspaces: [
        makeWorkspace({ id: 'ws-a' }),
        makeWorkspace({ id: 'ws-b', name: '第二个活跃区' }),
        // 已手动暂停（suspendReason=null）：保持原样，不重写暂停原因
        makeWorkspace({ id: 'ws-manual', status: 'SUSPENDED', suspendReason: null }),
        // 其他原因暂停：同样不动
        makeWorkspace({ id: 'ws-other', status: 'SUSPENDED', suspendReason: '违规内容' }),
        // 其他企业的 workspace：不受影响
        makeWorkspace({ id: 'ws-else', organizationId: 'org-2' }),
      ],
    })
    const audit = { record: vi.fn(async () => {}) }
    const entitlements = { recompute: vi.fn(async () => ({})) }

    const result = await runExpireCheck({
      prisma: db.prisma,
      audit,
      now: FIXED_NOW,
      entitlements,
    })

    expect(result.expired).toBe(1)
    expect(db.store.subscriptions.find((s) => s.id === 'sub-x')!.status).toBe('EXPIRED')
    expect(db.store.workspaces.find((w) => w.id === 'ws-a')).toMatchObject({
      status: 'SUSPENDED',
      suspendReason: SUBSCRIPTION_EXPIRED_SUSPEND_REASON,
    })
    expect(db.store.workspaces.find((w) => w.id === 'ws-b')).toMatchObject({
      status: 'SUSPENDED',
      suspendReason: SUBSCRIPTION_EXPIRED_SUSPEND_REASON,
    })
    expect(db.store.workspaces.find((w) => w.id === 'ws-manual')).toMatchObject({
      status: 'SUSPENDED',
      suspendReason: null,
    })
    expect(db.store.workspaces.find((w) => w.id === 'ws-other')).toMatchObject({
      status: 'SUSPENDED',
      suspendReason: '违规内容',
    })
    expect(db.store.workspaces.find((w) => w.id === 'ws-else')!.status).toBe('ACTIVE')
    const expiredAudit = audit.record.mock.calls.find((c) => c[0].action === 'subscription.expired')
    expect(expiredAudit![0]).toMatchObject({
      actorType: 'SYSTEM',
      organizationId: 'org-1',
      target: 'Subscription:sub-x',
    })
    expect(expiredAudit![0].diff).toMatchObject({ subscriptionId: 'sub-x', workspaceSuspended: 2 })
    // Minor-3：过期后重算配额（暂停路径）
    expect(entitlements.recompute).toHaveBeenCalledWith('org-1')
  })

  it('聚合判定（Important-1）：add-on 行届满 + 基础订阅仍 ACTIVE → 订阅 EXPIRED 但 workspace 不动（skippedReason=org_still_active）', async () => {
    const db = makeDb({
      subscriptions: [
        // 基础订阅仍在付费（ADDON 独立建行独立到期，任务 8 标准交付物）
        makeSubscription({ id: 'sub-base', planId: 'plan-base', endAt: daysFromNow(20) }),
        // add-on 行宽限届满
        makeSubscription({ id: 'sub-addon', planId: 'plan-addon', status: 'GRACE', endAt: daysFromNow(-8) }),
      ],
      workspaces: [makeWorkspace()],
    })
    const audit = { record: vi.fn(async () => {}) }
    const entitlements = { recompute: vi.fn(async () => ({})) }

    const result = await runExpireCheck({ prisma: db.prisma, audit, now: FIXED_NOW, entitlements })

    expect(result).toMatchObject({ expired: 1, expiredOrgStillActive: 1, orphanRestored: 0 })
    expect(db.store.subscriptions.find((s) => s.id === 'sub-addon')!.status).toBe('EXPIRED')
    expect(db.store.subscriptions.find((s) => s.id === 'sub-base')!.status).toBe('ACTIVE')
    // org 仍有有效服务：不暂停任何 workspace
    expect(db.store.workspaces[0]).toMatchObject({ status: 'ACTIVE', suspendReason: null })
    const expiredAudit = audit.record.mock.calls.find((c) => c[0].action === 'subscription.expired')
    expect(expiredAudit![0].diff).toMatchObject({
      subscriptionId: 'sub-addon',
      workspaceSuspended: 0,
      skippedReason: 'org_still_active',
    })
    // Minor-3：跳过路径同样重算（订阅行状态变了，配额口径随之变化）
    expect(entitlements.recompute).toHaveBeenCalledWith('org-1')
  })

  it('聚合判定（Important-1）：进行中交付（PENDING_ASSIGN）也构成有效服务 → 只过期不暂停', async () => {
    const db = makeDb({
      subscriptions: [makeSubscription({ id: 'sub-x', status: 'GRACE', endAt: daysFromNow(-8) })],
      workspaces: [makeWorkspace({ id: 'ws-1' })],
      deliveries: [{ id: 'sd-1', orderItemId: 'item-1', workspaceId: 'ws-1', status: 'PENDING_ASSIGN' }],
    })
    const audit = { record: vi.fn(async () => {}) }

    const result = await runExpireCheck({ prisma: db.prisma, audit, now: FIXED_NOW })

    expect(result).toMatchObject({ expired: 1, expiredOrgStillActive: 1 })
    expect(db.store.subscriptions[0].status).toBe('EXPIRED')
    expect(db.store.workspaces[0]).toMatchObject({ status: 'ACTIVE', suspendReason: null })
    const expiredAudit = audit.record.mock.calls.find((c) => c[0].action === 'subscription.expired')
    expect(expiredAudit![0].diff).toMatchObject({ skippedReason: 'org_still_active', workspaceSuspended: 0 })
  })

  it('宽限未满不动：endAt+7d > now 保持 GRACE 且其 org workspace 不暂停；恰 endAt=now-7d（边界含）→ EXPIRED', async () => {
    const db = makeDb({
      subscriptions: [
        // 独立 org：宽限未满的订阅，其 workspace 必须不受牵连
        makeSubscription({ id: 'sub-in-grace', organizationId: 'org-g', status: 'GRACE', endAt: daysFromNow(-6) }),
        makeSubscription({ id: 'sub-edge', status: 'GRACE', endAt: daysFromNow(-7) }),
      ],
      workspaces: [
        makeWorkspace({ id: 'ws-grace', organizationId: 'org-g' }),
        makeWorkspace({ id: 'ws-1' }),
      ],
    })
    const audit = { record: vi.fn(async () => {}) }

    const result = await runExpireCheck({ prisma: db.prisma, audit, now: FIXED_NOW })

    expect(result.expired).toBe(1)
    expect(db.store.subscriptions.find((s) => s.id === 'sub-in-grace')!.status).toBe('GRACE')
    expect(db.store.subscriptions.find((s) => s.id === 'sub-edge')!.status).toBe('EXPIRED')
    // 宽限内的订阅：其 org 的 workspace 不被暂停；届满的才暂停
    expect(db.store.workspaces.find((w) => w.id === 'ws-grace')).toMatchObject({
      status: 'ACTIVE',
      suspendReason: null,
    })
    expect(db.store.workspaces.find((w) => w.id === 'ws-1')).toMatchObject({
      status: 'SUSPENDED',
      suspendReason: SUBSCRIPTION_EXPIRED_SUSPEND_REASON,
    })
  })

  it('宽限天数可注入（graceDays=3）：endAt=now-3d 届满、now-2d 未满', async () => {
    const db = makeDb({
      subscriptions: [
        makeSubscription({ id: 'sub-a', status: 'GRACE', endAt: daysFromNow(-3) }),
        makeSubscription({ id: 'sub-b', status: 'GRACE', endAt: daysFromNow(-2) }),
      ],
    })
    const audit = { record: vi.fn(async () => {}) }

    const result = await runExpireCheck({ prisma: db.prisma, audit, now: FIXED_NOW, graceDays: 3 })

    expect(result.expired).toBe(1)
    expect(db.store.subscriptions.find((s) => s.id === 'sub-a')!.status).toBe('EXPIRED')
    expect(db.store.subscriptions.find((s) => s.id === 'sub-b')!.status).toBe('GRACE')
  })

  it('并发竞态：扫描后订阅已被续费（updateMany 命中 0）→ 跳过、不写 audit、不暂停 workspace', async () => {
    // findMany 返回陈旧 GRACE 快照，但库里行已被续费为 ACTIVE（endAt 未来）
    const db = makeDb({
      subscriptions: [
        makeSubscription({ id: 'sub-renewed', status: 'ACTIVE', endAt: daysFromNow(30) }),
      ],
      workspaces: [makeWorkspace()],
      staleSubs: [makeSubscription({ id: 'sub-renewed', status: 'GRACE', endAt: daysFromNow(-8) })],
    })
    const audit = { record: vi.fn(async () => {}) }

    const result = await runExpireCheck({ prisma: db.prisma, audit, now: FIXED_NOW })

    expect(result.expiredSkipped).toBe(1)
    expect(db.store.subscriptions[0].status).toBe('ACTIVE')
    expect(db.store.workspaces[0].status).toBe('ACTIVE')
    expect(audit.record).not.toHaveBeenCalled()
  })

  describe('遗留 B5：批内逐单隔离（毒数据不阻塞整批）', () => {
    afterEach(() => vi.restoreAllMocks())

    it('③ 宽限满过期首条迁移抛错 → 第二条照常 EXPIRED + 暂停，无异常上抛', async () => {
      const db = makeDb({
        subscriptions: [
          makeSubscription({ id: 'sub-poison', status: 'GRACE', endAt: daysFromNow(-20) }),
          makeSubscription({ id: 'sub-ok', organizationId: 'org-2', status: 'GRACE', endAt: daysFromNow(-20) }),
        ],
        workspaces: [makeWorkspace({ id: 'ws-2', organizationId: 'org-2' })],
      })
      const audit = { record: vi.fn(async () => {}) }
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const realUpdateMany = db.prisma.subscription.updateMany.getMockImplementation()
      db.prisma.subscription.updateMany.mockImplementation(async ({ where, data }: any) => {
        if (where?.id === 'sub-poison') throw new Error('poison sub exploded')
        return realUpdateMany!({ where, data })
      })

      const result = await runExpireCheck({ prisma: db.prisma, audit, now: FIXED_NOW })

      expect(result.expired).toBe(1)
      expect(db.store.subscriptions.find((s) => s.id === 'sub-ok')!.status).toBe('EXPIRED')
      expect(db.store.subscriptions.find((s) => s.id === 'sub-poison')!.status).toBe('GRACE')
      expect(db.store.workspaces.find((w) => w.id === 'ws-2')).toMatchObject({
        status: 'SUSPENDED',
        suspendReason: SUBSCRIPTION_EXPIRED_SUSPEND_REASON,
      })
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('sub-poison'),
        expect.any(Error),
      )
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('失败 1'))
    })

    it('② 入宽限首条抛错 → 第二条照常入宽限，无异常上抛', async () => {
      const db = makeDb({
        subscriptions: [
          makeSubscription({ id: 'sub-poison', status: 'ACTIVE', endAt: daysFromNow(-1) }),
          makeSubscription({ id: 'sub-ok', status: 'ACTIVE', endAt: daysFromNow(-2) }),
        ],
      })
      const audit = { record: vi.fn(async () => {}) }
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const realUpdateMany = db.prisma.subscription.updateMany.getMockImplementation()
      db.prisma.subscription.updateMany.mockImplementation(async ({ where, data }: any) => {
        if (where?.id === 'sub-poison') throw new Error('poison sub exploded')
        return realUpdateMany!({ where, data })
      })

      const result = await runExpireCheck({ prisma: db.prisma, audit, now: FIXED_NOW })

      expect(result.enteredGrace).toBe(1)
      expect(db.store.subscriptions.find((s) => s.id === 'sub-ok')!.status).toBe('GRACE')
      expect(db.store.subscriptions.find((s) => s.id === 'sub-poison')!.status).toBe('ACTIVE')
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('sub-poison'),
        expect.any(Error),
      )
    })
  })
})

// ---------------------------------------------------------------------------
// ④ 孤儿恢复：因"订阅到期"暂停的 workspace，其 org 已重新有有效服务 → 恢复
// ---------------------------------------------------------------------------

describe('runExpireCheck ④ 孤儿恢复', () => {
  it('SUSPENDED(订阅到期) 且 org 已有 ACTIVE/GRACE 订阅 → 恢复 ACTIVE + audit subscription.orphan_restore；无有效服务的 org 不恢复', async () => {
    const db = makeDb({
      subscriptions: [
        // org-1：续费后已有 ACTIVE 订阅，但 workspace 因历史误伤仍暂停
        makeSubscription({ id: 'sub-ok', endAt: daysFromNow(30) }),
        // org-3：仅 GRACE（宽限中同样构成有效服务，不该被暂停）
        makeSubscription({ id: 'sub-g', organizationId: 'org-3', status: 'GRACE', endAt: daysFromNow(-2) }),
      ],
      workspaces: [
        makeWorkspace({ id: 'ws-1', status: 'SUSPENDED', suspendReason: SUBSCRIPTION_EXPIRED_SUSPEND_REASON }),
        // org-2 无任何有效服务：保持暂停
        makeWorkspace({ id: 'ws-2', organizationId: 'org-2', status: 'SUSPENDED', suspendReason: SUBSCRIPTION_EXPIRED_SUSPEND_REASON }),
        makeWorkspace({ id: 'ws-3', organizationId: 'org-3', status: 'SUSPENDED', suspendReason: SUBSCRIPTION_EXPIRED_SUSPEND_REASON }),
        // 手动暂停（suspendReason=null）与其他原因暂停：不在恢复范围
        makeWorkspace({ id: 'ws-manual', status: 'SUSPENDED', suspendReason: null }),
        makeWorkspace({ id: 'ws-other', status: 'SUSPENDED', suspendReason: '违规内容' }),
      ],
    })
    const audit = { record: vi.fn(async () => {}) }

    const result = await runExpireCheck({ prisma: db.prisma, audit, now: FIXED_NOW })

    expect(result.orphanRestored).toBe(2)
    expect(db.store.workspaces.find((w) => w.id === 'ws-1')).toMatchObject({
      status: 'ACTIVE',
      suspendReason: null,
    })
    expect(db.store.workspaces.find((w) => w.id === 'ws-3')).toMatchObject({
      status: 'ACTIVE',
      suspendReason: null,
    })
    expect(db.store.workspaces.find((w) => w.id === 'ws-2')).toMatchObject({
      status: 'SUSPENDED',
      suspendReason: SUBSCRIPTION_EXPIRED_SUSPEND_REASON,
    })
    expect(db.store.workspaces.find((w) => w.id === 'ws-manual')!.status).toBe('SUSPENDED')
    expect(db.store.workspaces.find((w) => w.id === 'ws-other')!.status).toBe('SUSPENDED')
    // audit 按 org 各一条，diff 含恢复 count
    const restores = audit.record.mock.calls
      .map((c) => c[0])
      .filter((a) => a.action === 'subscription.orphan_restore')
    expect(restores).toHaveLength(2)
    expect(restores.find((a) => a.organizationId === 'org-1')!.diff).toMatchObject({ workspacesRestored: 1 })
    expect(restores.find((a) => a.organizationId === 'org-3')!.diff).toMatchObject({ workspacesRestored: 1 })
  })

  it('org 进行中交付同样触发孤儿恢复；全无有效服务的空 org 不产生 audit', async () => {
    const db = makeDb({
      workspaces: [
        makeWorkspace({ id: 'ws-1', status: 'SUSPENDED', suspendReason: SUBSCRIPTION_EXPIRED_SUSPEND_REASON }),
      ],
      deliveries: [{ id: 'sd-1', orderItemId: 'item-1', workspaceId: 'ws-1', status: 'IN_PROGRESS' }],
    })
    const audit = { record: vi.fn(async () => {}) }

    const result = await runExpireCheck({ prisma: db.prisma, audit, now: FIXED_NOW })

    expect(result.orphanRestored).toBe(1)
    expect(db.store.workspaces[0]).toMatchObject({ status: 'ACTIVE', suspendReason: null })
    expect(audit.record.mock.calls.filter((c) => c[0].action === 'subscription.orphan_restore')).toHaveLength(1)

    // 对照：无有效服务 → 不恢复、零 audit
    const db2 = makeDb({
      workspaces: [
        makeWorkspace({ id: 'ws-x', status: 'SUSPENDED', suspendReason: SUBSCRIPTION_EXPIRED_SUSPEND_REASON }),
      ],
    })
    const audit2 = { record: vi.fn(async () => {}) }
    const result2 = await runExpireCheck({ prisma: db2.prisma, audit: audit2, now: FIXED_NOW })
    expect(result2.orphanRestored).toBe(0)
    expect(db2.store.workspaces[0].status).toBe('SUSPENDED')
    expect(audit2.record).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 汇总与批量上限
// ---------------------------------------------------------------------------

describe('runExpireCheck 批量上限', () => {
  it('findMany 三段均带 take=EXPIRE_CHECK_BATCH_LIMIT（防单次扫全表，余量次日继续）', async () => {
    const db = makeDb({ subscriptions: [makeSubscription({ endAt: daysFromNow(5) })] })
    const audit = { record: vi.fn(async () => {}) }

    await runExpireCheck({ prisma: db.prisma, audit, now: FIXED_NOW })

    const takes = db.prisma.subscription.findMany.mock.calls.map((c) => c[0].take)
    expect(takes).toHaveLength(3)
    expect(takes.every((t) => t === 500)).toBe(true)
  })
})
