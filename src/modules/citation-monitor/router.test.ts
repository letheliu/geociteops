import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { citationRouter } from './router.js'

function createCaller(ctx: any) {
  return citationRouter.createCaller(ctx)
}

/**
 * 内存库：只实现读路径端点触达的方法。
 * where 过滤按端点实际用的字段实现（workspaceId/runId/status/capturedAt/platform/queryId），
 * 这样"含 FAILED 行的库中失败不计"这类断言才是真的在验证过滤，而不是验证 mock。
 */
function makeDb(seed: {
  runs?: any[]
  events?: any[]
  queries?: any[]
} = {}) {
  const runs = (seed.runs ?? []).map((r) => ({ ...r }))
  const events = (seed.events ?? []).map((e) => ({
    id: 'ev' + Math.random().toString(36).slice(2, 8),
    brandMentioned: false,
    brandSourceCited: false,
    rankInAnswer: null,
    sovScore: null,
    sampleIndex: 1,
    status: 'OK',
    ...e,
  }))
  const queries = (seed.queries ?? []).map((q) => ({ ...q }))

  function matchEvent(e: any, where: any) {
    if (where.workspaceId && e.workspaceId !== where.workspaceId) return false
    if (where.status && e.status !== where.status) return false
    if (where.runId !== undefined && e.runId !== where.runId) return false
    if (where.queryId && e.queryId !== where.queryId) return false
    if (where.platform && e.platform !== where.platform) return false
    if (where.capturedAt?.gte && !(e.capturedAt >= where.capturedAt.gte)) return false
    if (where.capturedAt?.lte && !(e.capturedAt <= where.capturedAt.lte)) return false
    if (where.capturedAt?.lt && !(e.capturedAt < where.capturedAt.lt)) return false
    if (where.OR) {
      const ok = where.OR.some((clause: any) => {
        if (clause.runId === null) return e.runId === null
        if (clause.runId?.in) return clause.runId.in.includes(e.runId)
        return false
      })
      if (!ok) return false
    }
    return true
  }

  const db: any = {
    runs,
    events,
    queries,
    citationRun: {
      findMany: vi.fn(async ({ where }: any) => {
        let list = runs.slice()
        if (where.id?.in) list = list.filter((r) => where.id.in.includes(r.id))
        if (where.workspaceId) list = list.filter((r) => r.workspaceId === where.workspaceId)
        if (where.startedAt?.gte) list = list.filter((r) => r.startedAt >= where.startedAt.gte)
        if (where.startedAt?.lt) list = list.filter((r) => r.startedAt < where.startedAt.lt)
        list.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))
        return list.map((r) => ({ ...r }))
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const hit = runs.find((r) => (where.id ? r.id === where.id : true) && (!where.workspaceId || r.workspaceId === where.workspaceId))
        return hit ? { ...hit } : null
      }),
    },
    citationEvent: {
      findMany: vi.fn(async ({ where }: any) => {
        let list = events.filter((e) => matchEvent(e, where))
        list.sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1))
        return list.map((e) => ({ ...e, query: { queryText: e.queryText ?? 'Q' } }))
      }),
    },
    citationQuery: {
      findMany: vi.fn(async ({ where }: any) => {
        let list = queries.slice()
        if (where.workspaceId) list = list.filter((q) => q.workspaceId === where.workspaceId)
        if (where.status) list = list.filter((q) => q.status === where.status)
        if (where.id?.in) list = list.filter((q) => where.id.in.includes(q.id))
        return list
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const hit = queries.find((q) => q.id === where.id && (!where.workspaceId || q.workspaceId === where.workspaceId))
        return hit ? { ...hit } : null
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const hit = queries.find((q) => q.id === where.id)
        if (hit) Object.assign(hit, data)
        return hit ? { ...hit } : null
      }),
    },
  }
  return db
}

const RUN_DATE = { start: '2026-10-01', end: '2026-10-31' }

describe('citation router', () => {
  let db: any
  let mockMonitor: any
  let mockQueryLibrary: any
  let ctx: any

  beforeEach(() => {
    db = makeDb()
    mockMonitor = {
      runOnce: vi.fn().mockResolvedValue([{ id: 'ev1' }]),
      createManualRun: vi.fn().mockResolvedValue({ runId: 'run-new', skipped: false, resumed: false, status: 'RUNNING' }),
      executeRunById: vi.fn().mockResolvedValue({ runId: 'run-new', status: 'COMPLETED', completedUnits: 4, failedUnits: 0 }),
      startScheduledRun: vi.fn(),
      resumeRun: vi.fn(),
    }
    mockQueryLibrary = {
      listActive: vi.fn().mockResolvedValue([{ id: 'q1' }]),
      addQuery: vi.fn().mockResolvedValue({ id: 'q2' }),
      generateQueries: vi.fn().mockResolvedValue([{ id: 'q3' }]),
      findSimilarQueries: vi.fn().mockResolvedValue([]),
      pauseQuery: vi.fn(),
      resumeQuery: vi.fn(),
      deleteQuery: vi.fn(),
    }
    ctx = {
      workspace: { id: 'w1', defaultBrandName: 'zoomer AI', status: 'ACTIVE' },
      actor: { kind: 'apiKey', credential: { id: 'cred-1', workspaceId: 'w1' } },
      requestMeta: { ip: '127.0.0.1', requestId: 'req-1', headers: { 'x-geo-csrf': 'test' } },
      services: { monitor: mockMonitor, queryLibrary: mockQueryLibrary, prisma: db },
    } as any
  })

  // ===== ① 聚合口径 + FAILED 不计 =====
  describe('聚合口径（getSovScore / getEffectComparison）', () => {
    it('getSovScore 走聚合：返回 macro 期间级指标而非事件池化', async () => {
      db = makeDb({
        runs: [{ id: 'r1', workspaceId: 'w1', trigger: 'SCHEDULED', sampleCount: 2, slotKey: 'k1', status: 'COMPLETED', startedAt: new Date('2026-10-10T02:00:00+08:00') }],
        events: [
          { workspaceId: 'w1', runId: 'r1', queryId: 'q1', platform: 'openai', sovScore: 1, brandMentioned: true, capturedAt: new Date('2026-10-10T02:00:00+08:00') },
          { workspaceId: 'w1', runId: 'r1', queryId: 'q2', platform: 'anthropic', sovScore: 0, brandMentioned: false, capturedAt: new Date('2026-10-10T02:00:00+08:00') },
        ],
      })
      ctx.services.prisma = db

      const result = await createCaller(ctx).getSovScore({ competitors: [], dateRange: RUN_DATE })

      expect(result.sovMean).toBeCloseTo(0.5, 10) // 两个组各 0.5 的 macro
      expect(result.brandMentionRate).toBeCloseTo(0.5, 10)
      expect(result.validSamples).toBe(2)
      expect(result.pointCount).toBe(1)
    })

    it('含 FAILED 行的库：失败不计入任何指标（单点过滤回归）', async () => {
      db = makeDb({
        runs: [{ id: 'r1', workspaceId: 'w1', trigger: 'SCHEDULED', sampleCount: 3, slotKey: 'k1', status: 'PARTIAL', startedAt: new Date('2026-10-10T02:00:00+08:00') }],
        events: [
          { workspaceId: 'w1', runId: 'r1', queryId: 'q1', platform: 'openai', sovScore: 1, brandMentioned: true, capturedAt: new Date('2026-10-10T02:00:00+08:00') },
          { workspaceId: 'w1', runId: 'r1', queryId: 'q1', platform: 'openai', sampleIndex: 2, status: 'FAILED', sovScore: null, brandMentioned: false, capturedAt: new Date('2026-10-10T02:00:00+08:00') },
          { workspaceId: 'w1', runId: 'r1', queryId: 'q1', platform: 'openai', sampleIndex: 3, status: 'FAILED', sovScore: null, brandMentioned: false, capturedAt: new Date('2026-10-10T02:00:00+08:00') },
        ],
      })
      ctx.services.prisma = db

      const sov = await createCaller(ctx).getSovScore({ competitors: [], dateRange: RUN_DATE })
      // 3 格里只有 1 格 OK：提及率是 1/1 而不是 1/3
      expect(sov.validSamples).toBe(1)
      expect(sov.brandMentionRate).toBe(1)
      expect(sov.sovMean).toBe(1)

      const report = await createCaller(ctx).getReport({ dateRange: { start: '2026-10-01', end: '2026-10-31T23:59:59Z' } })
      expect(report.events).toHaveLength(1)
      expect(report.events[0].status).toBe('OK')
    })

    it('getReport 强制 okEventsWhere（查询条件含 status=OK）', async () => {
      const caller = createCaller(ctx)
      await caller.getReport({ dateRange: { start: '2026-10-01', end: '2026-10-31' } })
      expect(db.citationEvent.findMany.mock.calls[0][0].where).toMatchObject({ status: 'OK', workspaceId: 'w1' })
    })

    it('getReport 返回行自带 runId / sampleIndex / status 元数据', async () => {
      db = makeDb({
        runs: [{ id: 'r9', workspaceId: 'w1', trigger: 'MANUAL', sampleCount: 1, slotKey: null, status: 'COMPLETED', startedAt: new Date('2026-10-10T02:00:00+08:00') }],
        events: [{ workspaceId: 'w1', runId: 'r9', queryId: 'q1', platform: 'openai', sampleIndex: 2, sovScore: 0.5, capturedAt: new Date('2026-10-10T02:00:00+08:00') }],
      })
      ctx.services.prisma = db
      const result = await createCaller(ctx).getReport({ dateRange: { start: '2026-10-01', end: '2026-10-31' } })
      expect(result.events[0]).toMatchObject({ runId: 'r9', sampleIndex: 2, status: 'OK' })
    })

    it('getEffectComparison before/after 用同一套期间级口径', async () => {
      db = makeDb({
        runs: [
          { id: 'r1', workspaceId: 'w1', trigger: 'SCHEDULED', sampleCount: 1, slotKey: null, status: 'COMPLETED', startedAt: new Date('2026-10-05T02:00:00+08:00') },
          { id: 'r2', workspaceId: 'w1', trigger: 'SCHEDULED', sampleCount: 1, slotKey: null, status: 'COMPLETED', startedAt: new Date('2026-10-20T02:00:00+08:00') },
        ],
        events: [
          { workspaceId: 'w1', runId: 'r1', queryId: 'q1', platform: 'openai', sovScore: 0, brandMentioned: false, capturedAt: new Date('2026-10-05T02:00:00+08:00') },
          { workspaceId: 'w1', runId: 'r2', queryId: 'q1', platform: 'openai', sovScore: 1, brandMentioned: true, capturedAt: new Date('2026-10-20T02:00:00+08:00') },
        ],
      })
      ctx.services.prisma = db

      const result = await createCaller(ctx).getEffectComparison({
        before: { start: '2026-10-01', end: '2026-10-10' },
        after: { start: '2026-10-15', end: '2026-10-31' },
      })

      expect(result.before.sovMean).toBe(0)
      expect(result.after.sovMean).toBe(1)
      expect(result.delta.sovMean).toBe(1)
      expect(result.delta.brandMentionRate).toBe(1)
    })
  })

  // ===== ③ runs.create =====
  describe('citation.runs.create', () => {
    it('返回 runId 并把执行丢到后台（异步语义）', async () => {
      const result = await createCaller(ctx).runs.create({ platforms: ['openai'] })
      expect(result).toEqual({ runId: 'run-new', status: 'RUNNING' })
      expect(mockMonitor.createManualRun).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'w1', platforms: ['openai'] }),
      )
      expect(mockMonitor.executeRunById).toHaveBeenCalledWith('run-new')
    })

    it('queryIds 跨工作区被拒（不建 Run）', async () => {
      db.queries.push({ id: 'qx', workspaceId: 'other', status: 'ACTIVE' })
      ctx.services.prisma = db

      await expect(createCaller(ctx).runs.create({ platforms: ['openai'], queryIds: ['qx'] })).rejects.toThrow(
        /不属于当前工作区/,
      )
      expect(mockMonitor.createManualRun).not.toHaveBeenCalled()
    })

    it('queryIds 含 PAUSED 被拒', async () => {
      db.queries.push({ id: 'qp', workspaceId: 'w1', status: 'PAUSED' })
      ctx.services.prisma = db

      await expect(createCaller(ctx).runs.create({ platforms: ['openai'], queryIds: ['qp'] })).rejects.toThrow(
        /非 ACTIVE/,
      )
    })

    it('sampleCount 钳到 1..10 后传给 monitor', async () => {
      await createCaller(ctx).runs.create({ platforms: ['openai'], sampleCount: 99 })
      expect(mockMonitor.createManualRun.mock.calls[0][0].sampleCount).toBe(10)

      vi.clearAllMocks()
      await createCaller(ctx).runs.create({ platforms: ['openai'], sampleCount: 0 })
      expect(mockMonitor.createManualRun.mock.calls[0][0].sampleCount).toBe(1)
    })

    it('0 查询时返回 SKIPPED 且不执行', async () => {
      mockMonitor.createManualRun.mockResolvedValue({ runId: null, skipped: true, resumed: false, status: 'SKIPPED' })
      const result = await createCaller(ctx).runs.create({ platforms: ['openai'] })
      expect(result).toEqual({ runId: null, status: 'SKIPPED' })
      expect(mockMonitor.executeRunById).not.toHaveBeenCalled()
    })

    it('monitor 抛错时映射为 BAD_REQUEST', async () => {
      mockMonitor.createManualRun.mockRejectedValue(new Error('queryIds 含非 ACTIVE 查询'))
      await expect(createCaller(ctx).runs.create({ platforms: ['openai'] })).rejects.toThrow(/非 ACTIVE/)
    })
  })

  // ===== ④ runs.list =====
  describe('citation.runs.list', () => {
    it('物理 Run 与 legacy:<date> 合成行同形状返回（倒序）', async () => {
      db = makeDb({
        runs: [{ id: 'r2', workspaceId: 'w1', trigger: 'SCHEDULED', sampleCount: 2, slotKey: 'w1:2026-10-20', status: 'COMPLETED', failureReason: null, startedAt: new Date('2026-10-20T02:00:00+08:00') }],
        events: [
          { workspaceId: 'w1', runId: 'r2', queryId: 'q1', platform: 'openai', sovScore: 1, brandMentioned: true, capturedAt: new Date('2026-10-20T02:00:00+08:00') },
          // legacy：runId=null，落在 10-05
          { workspaceId: 'w1', runId: null, queryId: 'q1', platform: 'openai', sovScore: 0.5, brandMentioned: true, capturedAt: new Date('2026-10-05T03:00:00+08:00') },
        ],
      })
      ctx.services.prisma = db

      const { runs } = await createCaller(ctx).runs.list({ dateRange: RUN_DATE })

      expect(runs).toHaveLength(2)
      expect(runs[0].id).toBe('r2')
      expect(runs[0].legacy).toBe(false)
      expect(runs[0].validSamples).toBe(1)
      expect(runs[0].sampleCount).toBe(2)
      expect(runs[1].id).toBe('legacy:2026-10-05')
      expect(runs[1].legacy).toBe(true)
      expect(runs[1].trigger).toBe('LEGACY')
      expect(runs[1].slotKey).toBeNull()
    })

    it('当日已有物理 Run 时不合成 legacy 行', async () => {
      db = makeDb({
        runs: [{ id: 'r1', workspaceId: 'w1', trigger: 'SCHEDULED', sampleCount: 1, slotKey: null, status: 'COMPLETED', failureReason: null, startedAt: new Date('2026-10-05T02:00:00+08:00') }],
        events: [
          { workspaceId: 'w1', runId: 'r1', queryId: 'q1', platform: 'openai', sovScore: 1, capturedAt: new Date('2026-10-05T02:00:00+08:00') },
          { workspaceId: 'w1', runId: null, queryId: 'q1', platform: 'openai', sovScore: 0.5, capturedAt: new Date('2026-10-05T03:00:00+08:00') },
        ],
      })
      ctx.services.prisma = db

      const { runs } = await createCaller(ctx).runs.list({ dateRange: RUN_DATE })
      expect(runs).toHaveLength(1)
      expect(runs[0].id).toBe('r1')
    })

    it('failureReason 从 Run 行补挂到列表行', async () => {
      db = makeDb({
        runs: [{ id: 'r1', workspaceId: 'w1', trigger: 'SCHEDULED', sampleCount: 10, slotKey: null, status: 'PARTIAL', failureReason: 'N clamped 10→4: unit cap 400', startedAt: new Date('2026-10-05T02:00:00+08:00') }],
        events: [{ workspaceId: 'w1', runId: 'r1', queryId: 'q1', platform: 'openai', sovScore: 1, capturedAt: new Date('2026-10-05T02:00:00+08:00') }],
      })
      ctx.services.prisma = db

      const { runs } = await createCaller(ctx).runs.list({ dateRange: RUN_DATE })
      expect(runs[0].failureReason).toBe('N clamped 10→4: unit cap 400')
    })
  })

  // ===== ⑤ runs.samples =====
  describe('citation.runs.samples', () => {
    it('runId 形态：返回该 Run 的全部样本（含 rawAnswer 与失败原因）', async () => {
      db = makeDb({
        runs: [{ id: 'r1', workspaceId: 'w1', trigger: 'SCHEDULED', sampleCount: 2, slotKey: 'k', status: 'PARTIAL', startedAt: new Date('2026-10-10T02:00:00+08:00') }],
        events: [
          { workspaceId: 'w1', runId: 'r1', queryId: 'q1', platform: 'openai', sampleIndex: 1, status: 'OK', rawAnswer: '答案一', sovScore: 1, capturedAt: new Date('2026-10-10T02:00:00+08:00') },
          { workspaceId: 'w1', runId: 'r1', queryId: 'q1', platform: 'openai', sampleIndex: 2, status: 'FAILED', rawAnswer: '', failureReason: '上游超时', capturedAt: new Date('2026-10-10T02:00:00+08:00') },
        ],
      })
      ctx.services.prisma = db

      const result = await createCaller(ctx).runs.samples({ runId: 'r1' })
      expect(result.events).toHaveLength(2)
      expect(result.events.find((e: any) => e.status === 'OK')?.rawAnswer).toBe('答案一')
      expect(result.events.find((e: any) => e.status === 'FAILED')?.failureReason).toBe('上游超时')
    })

    it('legacyDay 形态：按上海日界取当日 legacy 样本', async () => {
      db = makeDb({
        events: [
          { workspaceId: 'w1', runId: null, queryId: 'q1', platform: 'openai', sovScore: 1, rawAnswer: 'legacy 答案', capturedAt: new Date('2026-10-05T03:00:00+08:00') },
          { workspaceId: 'w1', runId: null, queryId: 'q1', platform: 'openai', sovScore: 1, rawAnswer: '别的日', capturedAt: new Date('2026-10-06T03:00:00+08:00') },
        ],
      })
      ctx.services.prisma = db

      const result = await createCaller(ctx).runs.samples({ legacyDay: '2026-10-05' })
      expect(result.run.id).toBe('legacy:2026-10-05')
      expect(result.run.trigger).toBe('LEGACY')
      expect(result.events).toHaveLength(1)
      expect(result.events[0].rawAnswer).toBe('legacy 答案')
    })

    it('跨工作区 runId → NOT_FOUND（IDOR 钉子）', async () => {
      db = makeDb({
        runs: [{ id: 'r-other', workspaceId: 'w2', trigger: 'MANUAL', sampleCount: 1, slotKey: null, status: 'COMPLETED', startedAt: new Date() }],
      })
      ctx.services.prisma = db

      await expect(createCaller(ctx).runs.samples({ runId: 'r-other' })).rejects.toThrow(/不存在/)
      // 关键：查询条件必须带上 workspaceId，否则就成了裸 id 查询
      expect(db.citationRun.findFirst.mock.calls[0][0].where).toEqual({ id: 'r-other', workspaceId: 'w1' })
    })

    it('legacyDay 格式非法 → BAD_REQUEST', async () => {
      await expect(createCaller(ctx).runs.samples({ legacyDay: '2026/10/05' })).rejects.toThrow(/YYYY-MM-DD/)
    })

    it('两个参数都不传 / 同时传都拒', async () => {
      await expect(createCaller(ctx).runs.samples({})).rejects.toThrow(/需要 runId 或 legacyDay/)
      await expect(createCaller(ctx).runs.samples({ runId: 'r1', legacyDay: '2026-10-05' })).rejects.toThrow(
        /只能传一个/,
      )
    })
  })

  // ===== ⑥ runStatus =====
  describe('citation.runStatus', () => {
    it('返回 Run 进度与终态', async () => {
      db = makeDb({
        runs: [{ id: 'r1', workspaceId: 'w1', trigger: 'MANUAL', sampleCount: 5, plannedUnits: 5, completedUnits: 4, failedUnits: 1, status: 'PARTIAL', failureReason: null, startedAt: new Date(), finishedAt: new Date() }],
      })
      ctx.services.prisma = db

      const result = await createCaller(ctx).runStatus({ runId: 'r1' })
      expect(result).toMatchObject({ status: 'PARTIAL', completedUnits: 4, failedUnits: 1, plannedUnits: 5 })
    })

    it('他工作区 runId → NOT_FOUND（IDOR 钉子）', async () => {
      db = makeDb({
        runs: [{ id: 'r-other', workspaceId: 'w2', trigger: 'MANUAL', sampleCount: 1, plannedUnits: 1, completedUnits: 1, failedUnits: 0, status: 'COMPLETED', startedAt: new Date() }],
      })
      ctx.services.prisma = db

      await expect(createCaller(ctx).runStatus({ runId: 'r-other' })).rejects.toThrow(/不存在/)
      expect(db.citationRun.findFirst.mock.calls[0][0].where).toEqual({ id: 'r-other', workspaceId: 'w1' })
    })
  })

  // ===== ⑦ trend =====
  describe('citation.trend', () => {
    it('返回趋势点（含 legacy 虚线点标记）与期间级汇总', async () => {
      db = makeDb({
        runs: [{ id: 'r1', workspaceId: 'w1', trigger: 'SCHEDULED', sampleCount: 2, slotKey: 'w1:2026-10-10', status: 'COMPLETED', startedAt: new Date('2026-10-10T02:00:00+08:00') }],
        events: [
          { workspaceId: 'w1', runId: 'r1', queryId: 'q1', platform: 'openai', sampleIndex: 1, sovScore: 1, brandMentioned: true, rankInAnswer: 2, capturedAt: new Date('2026-10-10T02:00:00+08:00') },
          { workspaceId: 'w1', runId: 'r1', queryId: 'q1', platform: 'openai', sampleIndex: 2, sovScore: 0, brandMentioned: false, capturedAt: new Date('2026-10-10T02:00:00+08:00') },
          { workspaceId: 'w1', runId: null, queryId: 'q1', platform: 'openai', sovScore: 0.4, brandMentioned: true, capturedAt: new Date('2026-10-05T03:00:00+08:00') },
        ],
      })
      ctx.services.prisma = db

      const result = await createCaller(ctx).trend({ dateRange: RUN_DATE })

      expect(result.points).toHaveLength(2)
      const legacyPoint = result.points.find((p: any) => p.legacy)!
      expect(legacyPoint.id).toBe('legacy:2026-10-05')
      expect(legacyPoint.slotKey).toBeNull()
      const physical = result.points.find((p: any) => !p.legacy)!
      expect(physical.slotKey).toBe('w1:2026-10-10')
      expect(physical.rankMedian).toBe(2)
      // 期间级 = 两个数据点等权：(物理 0.5 + legacy 0.4) / 2
      expect(result.period.sovMean).toBeCloseTo(0.45, 10)
      expect(result.period.pointCount).toBe(2)
    })

    it('范围超过 366 天 → BAD_REQUEST', async () => {
      await expect(
        createCaller(ctx).trend({ dateRange: { start: '2025-01-01', end: '2026-10-01' } }),
      ).rejects.toThrow(/366/)
    })

    it('end 早于 start → BAD_REQUEST', async () => {
      await expect(
        createCaller(ctx).trend({ dateRange: { start: '2026-10-10', end: '2026-10-01' } }),
      ).rejects.toThrow(/不能早于/)
    })

    it('桶日相交判定：跨日的 Run 只要桶日命中就计入', async () => {
      db = makeDb({
        runs: [{ id: 'r1', workspaceId: 'w1', trigger: 'SCHEDULED', sampleCount: 1, slotKey: null, status: 'COMPLETED', startedAt: new Date('2026-10-10T23:30:00+08:00') }],
        events: [{ workspaceId: 'w1', runId: 'r1', queryId: 'q1', platform: 'openai', sovScore: 1, capturedAt: new Date('2026-10-10T23:30:00+08:00') }],
      })
      ctx.services.prisma = db

      const hit = await createCaller(ctx).trend({ dateRange: { start: '2026-10-10', end: '2026-10-10' } })
      expect(hit.points).toHaveLength(1)

      const miss = await createCaller(ctx).trend({ dateRange: { start: '2026-10-11', end: '2026-10-12' } })
      expect(miss.points).toHaveLength(0)
    })

    it('platform / queryId 过滤下推到查询层', async () => {
      await createCaller(ctx).trend({ dateRange: RUN_DATE, platform: 'openai', queryId: 'q9' })
      const where = db.citationEvent.findMany.mock.calls[0][0].where
      expect(where.platform).toBe('openai')
      expect(where.queryId).toBe('q9')
    })
  })

  // ===== ⑧ 旧端点已移除 =====
  it('trackQuery / batchTrack 已移除（breaking）', () => {
    const router = citationRouter as any
    expect(router._def.procedures.trackQuery).toBeUndefined()
    expect(router._def.procedures.batchTrack).toBeUndefined()
    expect(router._def.procedures['runs.create']).toBeDefined()
    expect(router._def.procedures['runs.list']).toBeDefined()
    expect(router._def.procedures['runs.samples']).toBeDefined()
    expect(router._def.procedures.runStatus).toBeDefined()
    expect(router._def.procedures.trend).toBeDefined()
  })

  // ===== queries 家族 =====
  it('queries.add 添加 query', async () => {
    await createCaller(ctx).queries.add({ queryText: '新 query', source: 'manual' })
    expect(mockQueryLibrary.addQuery).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w1', queryText: '新 query' }),
    )
  })

  it('queries.setScheduled 切换定时开关', async () => {
    db.queries.push({ id: 'q1', workspaceId: 'w1', status: 'ACTIVE', scheduled: true })
    ctx.services.prisma = db
    const result = await createCaller(ctx).queries.setScheduled({ id: 'q1', scheduled: false })
    expect(result.scheduled).toBe(false)
  })

  it('queries.setScheduled 跨工作区 → NOT_FOUND', async () => {
    db.queries.push({ id: 'qx', workspaceId: 'other', status: 'ACTIVE' })
    ctx.services.prisma = db
    await expect(createCaller(ctx).queries.setScheduled({ id: 'qx', scheduled: false })).rejects.toThrow(/不存在/)
    expect(db.citationQuery.update).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// M2 §3.0 TTL 到期后的真实行为（规格 §5）：ACTIVE 到期 → GRACE、宽限满 → EXPIRED
// + workspace SUSPENDED——**两种状态都是只读保留**（数据永不删），区别只在 UI 文案。
// 本组把这两种只读形态在 citation 模块上钉死：query（trend）放行、mutation
// （runs.create）被拒，且服务层未被触达。
// ---------------------------------------------------------------------------

describe('citation 模块 × 试用到期两态（只读保留）', () => {
  function makeStateCtx(opts: {
    serviceState: 'GRACE' | 'NONE'
    workspaceStatus: 'ACTIVE' | 'SUSPENDED'
  }) {
    const stateDb = makeDb({
      runs: [
        { id: 'r1', workspaceId: 'w1', trigger: 'SCHEDULED', sampleCount: 2, status: 'COMPLETED', startedAt: new Date('2026-10-10T02:00:00+08:00') },
      ],
      events: [
        { workspaceId: 'w1', runId: 'r1', queryId: 'q1', platform: 'openai', sovScore: 1, brandMentioned: true, capturedAt: new Date('2026-10-10T02:00:00+08:00') },
      ],
    })
    const monitor = { createManualRun: vi.fn(), runOnce: vi.fn() }
    const stateCtx: any = {
      workspace: { id: 'w1', organizationId: 'org-1', defaultBrandName: 'zoomer AI', status: opts.workspaceStatus },
      actor: { kind: 'apiKey', credential: { id: 'cred-1', workspaceId: 'w1' } },
      requestMeta: { ip: '127.0.0.1', requestId: 'req-1', headers: { 'x-geo-csrf': 'test' } },
      services: {
        prisma: stateDb,
        monitor,
        queryLibrary: { listActive: vi.fn(), generateQueries: vi.fn() },
        serviceState: { resolve: vi.fn(async () => opts.serviceState) },
      },
    }
    return { stateCtx, monitor }
  }

  beforeEach(() => {
    // enforcement 打开才走服务状态矩阵（requireWorkspace 的闸门条件）
    vi.stubEnv('BILLING_ENFORCEMENT', 'on')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('GRACE（订阅到期、workspace 仍 ACTIVE）：trend ✓ / runs.create ✗「宽限期只读，请续费」', async () => {
    const { stateCtx, monitor } = makeStateCtx({ serviceState: 'GRACE', workspaceStatus: 'ACTIVE' })

    await expect(createCaller(stateCtx).trend({ dateRange: RUN_DATE })).resolves.toMatchObject({ points: expect.any(Array) })
    await expect(createCaller(stateCtx).runs.create({ platforms: ['openai'] })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('宽限期只读'),
    })
    expect(monitor.createManualRun).not.toHaveBeenCalled()
  })

  it('EXPIRED + workspace SUSPENDED：trend ✓（历史数据只读）/ runs.create ✗「工作区已暂停」', async () => {
    const { stateCtx, monitor } = makeStateCtx({ serviceState: 'NONE', workspaceStatus: 'SUSPENDED' })

    await expect(createCaller(stateCtx).trend({ dateRange: RUN_DATE })).resolves.toMatchObject({ points: expect.any(Array) })
    await expect(createCaller(stateCtx).runs.create({ platforms: ['openai'] })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('SUSPENDED'),
    })
    expect(monitor.createManualRun).not.toHaveBeenCalled()
  })
})
