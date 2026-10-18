import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMonitor,
  SlotConflictError,
  MAX_RUN_UNITS,
  MISSING_SAMPLE,
  DEFAULT_PLATFORM_CONCURRENCY,
} from './monitor.js'
import type { PlatformResult } from './platform-adapters/types.js'

const OK_RESULT: PlatformResult = {
  answer: '推荐 zoomer AI，详见 https://zoomer.top',
  sourceCitations: [],
  groundingSources: [],
  answerMentions: [],
}

interface SeedEvent {
  runId: string | null
  queryId: string
  platform: string
  sampleIndex: number
  status?: 'OK' | 'FAILED'
  sovScore?: number | null
  rawAnswer?: string
  failureReason?: string | null
}

/**
 * 内存版 Prisma：只实现 Monitor 触达的方法。
 * 唯一约束（slotKey、runId×query×platform×sampleIndex）在 mock 层真实生效——
 * 否则 upsert/幂等测试会因为约束"不存在"而假绿。
 */
function makePrisma(opts: {
  workspace?: Partial<any>
  queries?: Array<Partial<any> & { id: string }>
  events?: SeedEvent[]
} = {}) {
  const workspace = {
    id: 'w1',
    name: '测试工作区',
    defaultBrandName: 'zoomer AI',
    domain: 'zoomer.top',
    platformConfig: { openai: { OPENAI_API_KEY: 'sk-test' }, anthropic: { ANTHROPIC_API_KEY: 'an-test' } },
    monitorSampleCount: 5,
    ...opts.workspace,
  }
  const queries = (opts.queries ?? [
    { id: 'q1', workspaceId: 'w1', queryText: 'AI设计工具', status: 'ACTIVE', scheduled: true, priority: 3 },
  ]).map((q) => ({ workspaceId: 'w1', status: 'ACTIVE', scheduled: true, priority: 3, ...q }))

  const runs: Array<any> = []
  const events: Array<any> = []
  let eventSeq = 0
  let runSeq = 0

  for (const e of opts.events ?? []) {
    events.push({
      id: `seed-${eventSeq++}`,
      workspaceId: 'w1',
      brandMentioned: false,
      brandSourceCited: false,
      rankInAnswer: null,
      sourceRank: null,
      analysis: {},
      competitors: [],
      capturedAt: new Date(),
      ...e,
      status: e.status ?? 'OK',
      sovScore: e.sovScore ?? null,
    })
  }

  const callLog = { runUpdateMany: [] as any[] }

  const prisma: any = {
    workspace: {
      findUnique: vi.fn(async ({ where }: any) => (where.id === workspace.id ? { ...workspace } : null)),
    },
    citationQuery: {
      findMany: vi.fn(async ({ where }: any) => {
        let list = queries.filter((q) => q.workspaceId === where.workspaceId)
        if (where.status) list = list.filter((q) => q.status === where.status)
        if (where.scheduled !== undefined) list = list.filter((q) => q.scheduled === where.scheduled)
        if (where.id?.in) list = list.filter((q) => where.id.in.includes(q.id))
        return [...list].sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3))
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const hit = queries.filter((q) => where.id?.in?.includes(q.id))
        for (const q of hit) Object.assign(q, data)
        return { count: hit.length }
      }),
    },
    citationRun: {
      findUnique: vi.fn(async ({ where }: any) => {
        const run = where.id ? runs.find((r) => r.id === where.id) : runs.find((r) => r.slotKey === where.slotKey)
        return run ? { ...run } : null
      }),
      create: vi.fn(async ({ data }: any) => {
        // slotKey 唯一约束
        if (data.slotKey && runs.some((r) => r.slotKey === data.slotKey)) {
          const err: any = new Error('Unique constraint failed on the fields: (`slotKey`)')
          err.code = 'P2002'
          throw err
        }
        const run = {
          completedUnits: 0,
          failedUnits: 0,
          startedAt: new Date(),
          finishedAt: null,
          ...data,
          id: `run-${++runSeq}`,
        }
        runs.push(run)
        return { ...run }
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        callLog.runUpdateMany.push({ where, data })
        const hit = runs.filter((r) => r.id === where.id && (where.status === undefined || r.status === where.status))
        for (const r of hit) Object.assign(r, data)
        return { count: hit.length }
      }),
    },
    citationEvent: {
      findMany: vi.fn(async ({ where }: any) => {
        let list = events.slice()
        if (where.runId !== undefined) list = list.filter((e) => e.runId === where.runId)
        if (where.status !== undefined) list = list.filter((e) => e.status === where.status)
        return list.map((e) => ({ ...e }))
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const k = where.runId_queryId_platform_sampleIndex
        const existing = events.find(
          (e) => e.runId === k.runId && e.queryId === k.queryId && e.platform === k.platform && e.sampleIndex === k.sampleIndex,
        )
        if (existing) {
          Object.assign(existing, update)
          return { ...existing }
        }
        const row = { id: `ev-${++eventSeq}`, ...create }
        events.push(row)
        return { ...row }
      }),
    },
  }

  return { prisma, runs, events, queries, callLog }
}

function stubQueryLibrary() {
  return { listActive: vi.fn(), addQuery: vi.fn(), pauseQuery: vi.fn(), deleteQuery: vi.fn(), generateQueries: vi.fn() } as any
}

/** 默认成功的 adapter；query 可注入失败/挂起序列 */
function okAdapter(overrides: Partial<Record<string, any>> = {}) {
  return { name: 'openai', query: vi.fn().mockResolvedValue(OK_RESULT), ...overrides } as any
}

function registryOf(adapters: Record<string, any>) {
  return {
    get: vi.fn((name: string) => adapters[name]),
    list: vi.fn(() => Object.keys(adapters)),
  } as any
}

const SLOT = 'w1:2026-10-18'

describe('monitor — Run 编排', () => {
  let db: ReturnType<typeof makePrisma>
  let adapter: any
  let registry: any

  beforeEach(() => {
    db = makePrisma()
    adapter = okAdapter()
    registry = registryOf({ openai: adapter })
  })

  function monitorWith(deps: Partial<Parameters<typeof createMonitor>[0]> = {}) {
    return createMonitor({
      prisma: db.prisma,
      registry,
      queryLibrary: stubQueryLibrary(),
      competitors: [],
      ...deps,
    })
  }

  // ① 建 Run
  it('① 建 Run：落 trigger/sampleCount/platforms/querySnapshot/plannedUnits 与调用方给的 slotKey', async () => {
    const monitor = monitorWith()
    const result = await monitor.startScheduledRun({ workspaceId: 'w1', platforms: ['openai'], slotKey: SLOT })

    expect(result.runId).not.toBeNull()
    expect(db.runs).toHaveLength(1)
    const run = db.runs[0]
    expect(run.trigger).toBe('SCHEDULED')
    expect(run.sampleCount).toBe(5)
    expect(run.platforms).toEqual(['openai'])
    expect(run.querySnapshot).toEqual([{ id: 'q1', text: 'AI设计工具' }])
    // 1 query × 1 platform × 5 samples
    expect(run.plannedUnits).toBe(5)
    expect(run.slotKey).toBe(SLOT)
    expect(run.status).toBe('COMPLETED')
  })

  // ② N × 查询 × 平台
  it('② N×查询×平台落行，sampleIndex 从 1 连续到 N', async () => {
    db = makePrisma({
      queries: [
        { id: 'q1', workspaceId: 'w1', queryText: 'Q1' },
        { id: 'q2', workspaceId: 'w1', queryText: 'Q2' },
      ],
    })
    registry = registryOf({ openai: adapter, anthropic: okAdapter({ name: 'anthropic' }) })
    const monitor = monitorWith({ workspace: undefined } as any)

    await monitor.startScheduledRun({ workspaceId: 'w1', platforms: ['openai', 'anthropic'], slotKey: SLOT })

    expect(db.events).toHaveLength(2 * 2 * 5)
    for (const q of ['q1', 'q2']) {
      for (const p of ['openai', 'anthropic']) {
        const idx = db.events.filter((e) => e.queryId === q && e.platform === p).map((e) => e.sampleIndex).sort()
        expect(idx).toEqual([1, 2, 3, 4, 5])
      }
    }
    expect(db.runs[0].completedUnits).toBe(20)
    expect(db.runs[0].failedUnits).toBe(0)
  })

  // ③ 失败隔离
  it('③ 采样失败落 FAILED 行：占位值齐全且 failureReason/analysis.error 均已脱敏', async () => {
    const failing = okAdapter({
      query: vi.fn().mockRejectedValue(new Error('upstream down sk-abcdefghijklmnopqrstuvwxyz')),
    })
    registry = registryOf({ openai: failing })
    const monitor = monitorWith()

    const result = await monitor.startScheduledRun({ workspaceId: 'w1', platforms: ['openai'], slotKey: SLOT })

    // 全部 5 格都失败 = 0 OK → Run 终态是 FAILED（不进趋势），不是 PARTIAL
    expect(result.status).toBe('FAILED')
    expect(db.events).toHaveLength(5)
    for (const e of db.events) {
      expect(e.status).toBe('FAILED')
      // 规格 §4/D2 占位值
      expect(e.rawAnswer).toBe('')
      expect(e.brandMentioned).toBe(false)
      expect(e.sovScore).toBeNull()
      expect(e.rankInAnswer).toBeNull()
      // 脱敏：长令牌被遮蔽，且错误对象整体经 sanitizeMessage
      expect(e.failureReason).toBe('upstream down [REDACTED]')
      expect(e.analysis).toEqual({ error: 'upstream down [REDACTED]' })
    }
    expect(db.runs[0].failedUnits).toBe(5)
    expect(db.runs[0].completedUnits).toBe(0)
  })

  // ④ per-platform 并发 2
  it('④ run 内单平台并发上限为 2（跨平台各自独立）', async () => {
    let inFlight = 0
    let maxInFlight = 0
    let release!: () => void
    const gate = new Promise<void>((res) => { release = res })

    const gated = {
      name: 'openai',
      query: vi.fn(async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await gate
        inFlight--
        return OK_RESULT
      }),
    }
    registry = registryOf({ openai: gated })
    const monitor = monitorWith()

    expect(DEFAULT_PLATFORM_CONCURRENCY).toBe(2)
    const promise = monitor.startScheduledRun({ workspaceId: 'w1', platforms: ['openai'], slotKey: SLOT })

    // 让并发池铺满
    await new Promise((r) => setTimeout(r, 20))
    expect(inFlight).toBe(2)

    release()
    await promise
    expect(gated.query).toHaveBeenCalledTimes(5)
    expect(maxInFlight).toBe(2)
  })

  // ⑤ deadline
  it('⑤ deadline 后不再发起新采样；已有 OK 时收尾为 PARTIAL', async () => {
    // 可控时钟：第一次采样后时间跳到 deadline 之后
    // 起点取真实 now，与 Run.startedAt 对齐（mock 用 new Date() 建行）
    let current = new Date()
    const clock = () => current

    db = makePrisma({ workspace: { monitorSampleCount: 5 } })
    db.runs.length = 0
    const slow = {
      name: 'openai',
      query: vi.fn(async () => {
        current = new Date(current.getTime() + 10_000) // 每次采样耗时 10s
        return OK_RESULT
      }),
    }
    registry = registryOf({ openai: slow })
    const monitor = monitorWith({ now: clock, deadlineMs: 15_000 })

    const result = await monitor.startScheduledRun({ workspaceId: 'w1', platforms: ['openai'], slotKey: SLOT })

    // deadline=15s，每采样 +10s → 只有第 1 个采样在期限内发起，第 2 个发起时已超期
    expect(slow.query.mock.calls.length).toBeLessThan(5)
    expect(result.status).toBe('PARTIAL')
    // 超期采样以 MISSING_SAMPLE 补齐，Run 仍可进趋势
    expect(db.events).toHaveLength(5)
    const okRows = db.events.filter((e) => e.status === 'OK')
    const missing = db.events.filter((e) => e.failureReason === MISSING_SAMPLE)
    expect(okRows.length).toBeGreaterThan(0)
    expect(okRows.length + missing.length).toBe(5)
    expect(db.runs[0].failureReason).toContain('deadline exceeded')
  })

  // ⑥ 缺样 + 终态幂等
  it('⑥ 收尾把未发起的采样补记 MISSING_SAMPLE，终态更新带 status=RUNNING 条件', async () => {
    // deadline=0 → 一个采样都不发起，全靠收尾补齐
    const monitor = monitorWith({ deadlineMs: 0 })

    const result = await monitor.startScheduledRun({ workspaceId: 'w1', platforms: ['openai'], slotKey: SLOT })

    expect(adapter.query).not.toHaveBeenCalled()
    expect(result.status).toBe('FAILED')
    expect(db.events).toHaveLength(5)
    expect(db.events.every((e) => e.failureReason === MISSING_SAMPLE)).toBe(true)

    const terminal = db.callLog.runUpdateMany.filter((c) => c.data.status && c.data.status !== 'RUNNING')
    expect(terminal.length).toBeGreaterThan(0)
    expect(terminal[0].where).toEqual({ id: db.runs[0].id, status: 'RUNNING' })
  })

  it('⑥ 重复收尾无副作用（终态 Run 不再被改）', async () => {
    const monitor = monitorWith()
    await monitor.startScheduledRun({ workspaceId: 'w1', platforms: ['openai'], slotKey: SLOT })

    const before = db.callLog.runUpdateMany.length
    const finishedAt = db.runs[0].finishedAt
    // 再调一次 resumeRun：Run 已 COMPLETED，直接返回 null
    const again = await monitor.resumeRun(db.runs[0].id)

    expect(again).toBeNull()
    expect(db.callLog.runUpdateMany.length).toBe(before)
    expect(db.runs[0].finishedAt).toBe(finishedAt)
    expect(db.events).toHaveLength(5)
  })

  // ⑦ 续跑补缺不重不漏
  it('⑦ resumeRun 按唯一键补缺：已有样本不重写，缺失样本补齐', async () => {
    db = makePrisma({
      events: [
        { runId: 'run-seed', queryId: 'q1', platform: 'openai', sampleIndex: 1, status: 'OK', sovScore: 0.9, rawAnswer: '第一份答案' },
      ],
    })
    db.runs.push({
      id: 'run-seed',
      workspaceId: 'w1',
      trigger: 'SCHEDULED',
      sampleCount: 3,
      platforms: ['openai'],
      querySnapshot: [{ id: 'q1', text: 'AI设计工具' }],
      plannedUnits: 3,
      completedUnits: 0,
      failedUnits: 0,
      status: 'FAILED',
      failureReason: null,
      startedAt: new Date(),
      finishedAt: new Date(),
      slotKey: SLOT,
    })

    const monitor = monitorWith()
    const outcome = await monitor.resumeRun('run-seed')

    expect(outcome?.status).toBe('COMPLETED')
    // 只补 2 个缺失样本，不重跑第 1 个
    expect(adapter.query).toHaveBeenCalledTimes(2)
    expect(db.events).toHaveLength(3)
    expect(db.events.filter((e) => e.sampleIndex === 1)).toHaveLength(1)
    // 已有样本未被覆盖
    expect(db.events.find((e) => e.sampleIndex === 1)?.rawAnswer).toBe('第一份答案')
    expect(db.runs[0].status).toBe('COMPLETED')
  })

  // ⑧ MAX_RUN_UNITS 钳制
  it('⑧ MAX_RUN_UNITS=400，且有效 N 被钳制时 Run 记录钳制后值与说明', async () => {
    expect(MAX_RUN_UNITS).toBe(400)

    db = makePrisma({ workspace: { monitorSampleCount: 10 } })
    const monitor = monitorWith({ maxRunUnits: 8 }) // 1 query × 2 platform → cap=4

    await monitor.startScheduledRun({ workspaceId: 'w1', platforms: ['openai', 'anthropic'], slotKey: SLOT })

    expect(db.runs[0].sampleCount).toBe(4)
    expect(db.runs[0].failureReason).toBe('N clamped 10→4: unit cap 8')
    expect(db.events).toHaveLength(4 * 2)
  })

  it('⑧ 钳制不静默：未超上限时 failureReason 为 null', async () => {
    const monitor = monitorWith()
    await monitor.startScheduledRun({ workspaceId: 'w1', platforms: ['openai'], slotKey: SLOT })
    expect(db.runs[0].failureReason).toBeNull()
  })

  // ⑨ lastRunAt
  it('⑨ 收尾对每个参与查询（以 querySnapshot 为锚）更新 lastRunAt', async () => {
    db = makePrisma({
      queries: [
        { id: 'q1', workspaceId: 'w1', queryText: 'Q1' },
        { id: 'q2', workspaceId: 'w1', queryText: 'Q2' },
      ],
    })
    const monitor = monitorWith()
    await monitor.startScheduledRun({ workspaceId: 'w1', platforms: ['openai'], slotKey: SLOT })

    expect(db.prisma.citationQuery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['q1', 'q2'] } }, data: { lastRunAt: expect.any(Date) } }),
    )
  })

  // 幂等：slotKey
  it('slotKey 幂等：同 slot 再次投递不新建 Run（已 COMPLETED 时跳过）', async () => {
    const monitor = monitorWith()
    await monitor.startScheduledRun({ workspaceId: 'w1', platforms: ['openai'], slotKey: SLOT })
    const second = await monitor.startScheduledRun({ workspaceId: 'w1', platforms: ['openai'], slotKey: SLOT })

    expect(second.skipped).toBe(true)
    expect(db.runs).toHaveLength(1)
    expect(db.events).toHaveLength(5)
  })

  it('slotKey 幂等：并发投递（同 slot）只建一个 Run，另一个走续跑或跳过', async () => {
    const monitor = monitorWith()
    const [a, b] = await Promise.all([
      monitor.startScheduledRun({ workspaceId: 'w1', platforms: ['openai'], slotKey: SLOT }),
      monitor.startScheduledRun({ workspaceId: 'w1', platforms: ['openai'], slotKey: SLOT }),
    ])

    expect(db.runs).toHaveLength(1)
    const created = [a, b].filter((r) => !r.skipped)
    expect(created.length).toBeGreaterThanOrEqual(1)
    // 采样不因并发投递而翻倍
    expect(db.events).toHaveLength(5)
  })

  it('FAILED 后同日重触发 = 原地续跑，不新建 Run', async () => {
    const monitor = monitorWith({ deadlineMs: 0 })
    await monitor.startScheduledRun({ workspaceId: 'w1', platforms: ['openai'], slotKey: SLOT })
    expect(db.runs[0].status).toBe('FAILED')

    // 换成正常 adapter 再触发：应续跑同一个 Run
    registry = registryOf({ openai: okAdapter() })
    const monitor2 = monitorWith({ deadlineMs: 0 })
    const second = await monitor2.startScheduledRun({ workspaceId: 'w1', platforms: ['openai'], slotKey: SLOT })

    expect(second.resumed).toBe(true)
    expect(db.runs).toHaveLength(1)
  })

  // 参与范围
  it('scheduled=false 的查询被排除在定时运行之外', async () => {
    db = makePrisma({
      queries: [
        { id: 'q1', workspaceId: 'w1', queryText: 'Q1', scheduled: false },
        { id: 'q2', workspaceId: 'w1', queryText: 'Q2', scheduled: true },
      ],
    })
    const monitor = monitorWith()
    await monitor.startScheduledRun({ workspaceId: 'w1', platforms: ['openai'], slotKey: SLOT })

    expect(db.runs[0].querySnapshot).toEqual([{ id: 'q2', text: 'Q2' }])
  })

  it('0 查询或 0 平台直接跳过，不建 Run', async () => {
    db = makePrisma({ queries: [{ id: 'q1', workspaceId: 'w1', scheduled: false }] })
    const monitor = monitorWith()

    const noQueries = await monitor.startScheduledRun({ workspaceId: 'w1', platforms: ['openai'], slotKey: SLOT })
    expect(noQueries.runId).toBeNull()
    expect(noQueries.status).toBe('SKIPPED')

    const noPlatforms = await monitor.startManualRun({ workspaceId: 'w1', platforms: [] })
    expect(noPlatforms.runId).toBeNull()
    expect(db.runs).toHaveLength(0)
  })

  // 手动触发
  it('startManualRun 不占 slotKey，trigger=MANUAL', async () => {
    const monitor = monitorWith()
    const result = await monitor.startManualRun({ workspaceId: 'w1', platforms: ['openai'], sampleCount: 2 })

    expect(result.runId).not.toBeNull()
    expect(db.runs[0].trigger).toBe('MANUAL')
    expect(db.runs[0].slotKey).toBeNull()
    expect(db.runs[0].sampleCount).toBe(2)
    expect(db.events).toHaveLength(2)
  })

  it('startManualRun 拒绝跨工作区查询', async () => {
    db = makePrisma({
      queries: [
        { id: 'q1', workspaceId: 'w1', queryText: 'Q1' },
        { id: 'qx', workspaceId: 'other', queryText: '别的空间的查询' },
      ],
    })
    const monitor = monitorWith()

    await expect(
      monitor.startManualRun({ workspaceId: 'w1', platforms: ['openai'], queryIds: ['q1', 'qx'] }),
    ).rejects.toThrow(/不属于当前工作区/)
    expect(db.runs).toHaveLength(0)
  })

  it('startManualRun 拒绝 PAUSED 查询（PAUSED 不参与任何运行，含手动）', async () => {
    db = makePrisma({ queries: [{ id: 'q1', workspaceId: 'w1', status: 'PAUSED', queryText: 'Q1' }] })
    const monitor = monitorWith()

    await expect(
      monitor.startManualRun({ workspaceId: 'w1', platforms: ['openai'], queryIds: ['q1'] }),
    ).rejects.toThrow(/非 ACTIVE/)
  })

  it('startManualRun 把 sampleCount 钳在 1..10', async () => {
    const monitor = monitorWith()
    await monitor.startManualRun({ workspaceId: 'w1', platforms: ['openai'], sampleCount: 99 })
    expect(db.runs[0].sampleCount).toBe(10)

    db.runs.length = 0
    db.events.length = 0
    const monitor2 = monitorWith()
    await monitor2.startManualRun({ workspaceId: 'w1', platforms: ['openai'], sampleCount: 0 })
    expect(db.runs[0].sampleCount).toBe(1)
  })

  // 未注册 adapter
  it('平台未注册时该格记 FAILED，不影响其他平台', async () => {
    registry = registryOf({ openai: adapter })
    const monitor = monitorWith()
    await monitor.startScheduledRun({ workspaceId: 'w1', platforms: ['openai', 'ghost'], slotKey: SLOT })

    const ghost = db.events.filter((e) => e.platform === 'ghost')
    expect(ghost).toHaveLength(5)
    expect(ghost.every((e) => e.status === 'FAILED')).toBe(true)
    expect(db.events.filter((e) => e.platform === 'openai').every((e) => e.status === 'OK')).toBe(true)
    expect(db.runs[0].status).toBe('PARTIAL')
  })

  // SlotConflictError 仍对外可见（调度层用）
  it('SlotConflictError 携带 slotKey 与既有 Run id', async () => {
    const monitor = monitorWith()
    await monitor.startScheduledRun({ workspaceId: 'w1', platforms: ['openai'], slotKey: SLOT })
    // 手动构造冲突场景：Run 已存在且状态为 RUNNING（不会被续跑分支吞掉）
    db.runs[0].status = 'RUNNING'
    const conflict = new SlotConflictError(SLOT, db.runs[0].id)
    expect(conflict.slotKey).toBe(SLOT)
    expect(conflict.existingRunId).toBe(db.runs[0].id)
  })

  // 兼容旧路径
  it('runOnce 仍可用：回传本次 Run 的 OK 采样行', async () => {
    const monitor = monitorWith()
    const events = await monitor.runOnce({ workspaceId: 'w1', platforms: ['openai'] })
    expect(events).toHaveLength(5)
    expect(events.every((e) => e.status === 'OK')).toBe(true)
  })

  it('凭证来自 resolveConfig 时 adapter 用解密后的配置', async () => {
    const resolveConfig = vi.fn().mockResolvedValue({ openai: { OPENAI_API_KEY: 'sk-decrypted' }, competitors: ['figma'] })
    const monitor = monitorWith({ resolveConfig })

    await monitor.startScheduledRun({ workspaceId: 'w1', platforms: ['openai'], slotKey: SLOT })

    expect(resolveConfig).toHaveBeenCalledWith('w1')
    expect(adapter.query).toHaveBeenCalledWith('AI设计工具', { OPENAI_API_KEY: 'sk-decrypted' })
  })

  it('workspace.competitors 参与分析（写入事件 competitors）', async () => {
    registry = registryOf({
      openai: okAdapter({
        query: vi.fn().mockResolvedValue({
          answer: 'zoomer AI 与 Figma 都可选',
          sourceCitations: [{ url: 'https://zoomer.top/x', position: 1, sourceType: 'api_citation' }],
          groundingSources: [],
          answerMentions: [],
        } as PlatformResult),
      }),
    })
    const monitor = monitorWith({ competitors: ['Figma'] })
    await monitor.startScheduledRun({ workspaceId: 'w1', platforms: ['openai'], slotKey: SLOT })

    const row = db.events[0]
    expect(row.brandMentioned).toBe(true)
    expect(row.brandSourceCited).toBe(true)
    expect(row.competitors).toEqual(expect.arrayContaining([expect.objectContaining({ brand: 'Figma' })]))
    expect(row.sovScore).toBeGreaterThan(0)
  })
})
