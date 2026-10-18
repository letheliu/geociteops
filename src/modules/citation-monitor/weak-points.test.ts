import { describe, it, expect, vi } from 'vitest'
import { loadWeakPoints, queryLevelAggregate, pickTopCompetitor, WEAK_BRAND_MENTION_RATE } from './weak-points.js'
import { groupAggregate, type AggregateEvent } from './aggregate.js'

/** 事件工厂：显式给出竞品提及，便于断言查询级竞品率 */
function ev(over: Partial<AggregateEvent> & { queryId: string }): AggregateEvent {
  return {
    id: 'e-' + Math.random().toString(36).slice(2, 8),
    platform: 'openai',
    runId: 'run-1',
    sampleIndex: 1,
    status: 'OK',
    brandMentioned: false,
    brandSourceCited: false,
    rankInAnswer: null,
    sovScore: 0.1,
    capturedAt: new Date('2026-10-18T04:00:00.000Z'),
    ...over,
  } as AggregateEvent
}

const comp = (brand: string, mentioned: boolean) => ({ brand, mentioned, rank: null })

const RANGE = { fromDay: '2026-10-01', toDay: '2026-10-31' }

function makePrisma(opts: {
  queries?: any[]
  runs?: any[]
  events?: any[]
}) {
  return {
    citationQuery: {
      findMany: vi.fn(async ({ where }: any) =>
        (opts.queries ?? []).filter((q) => q.workspaceId === where.workspaceId && q.status === where.status),
      ),
    },
    citationRun: {
      findMany: vi.fn(async ({ where }: any) =>
        (opts.runs ?? [])
          .filter((r) => r.workspaceId === where.workspaceId)
          .filter((r) => (where.status?.in ? where.status.in.includes(r.status) : true))
          .filter((r) => where.finishedAt?.not === null ? r.finishedAt !== null : true)
          .sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1)),
      ),
    },
    citationEvent: {
      findMany: vi.fn(async () => opts.events ?? []),
    },
  } as any
}

describe('queryLevelAggregate / pickTopCompetitor（M2 §3.3）', () => {
  it('查询级 = 组 macro 等权（组等权而非样本池化）', () => {
    const a = groupAggregate([
      ev({ queryId: 'q1', platform: 'openai', sovScore: 0.4, brandMentioned: true }),
    ])
    const b = groupAggregate([
      ev({ queryId: 'q1', platform: 'anthropic', sovScore: 0.0, brandMentioned: false }),
      ev({ queryId: 'q1', platform: 'anthropic', sovScore: 0.0, brandMentioned: false }),
    ])
    const level = queryLevelAggregate('run-1', [a, b])!
    // 品牌率 = (1 + 0)/2 = 0.5；样本数求和 = 3
    expect(level.brandMentionRate).toBeCloseTo(0.5)
    expect(level.validSamples).toBe(3)
    expect(level.sovMean).toBeCloseTo((0.4 + 0) / 2)
  })

  it('无有效组 → null（不造 0，调用方据此跳过该 run）', () => {
    const empty = groupAggregate([
      ev({ queryId: 'q1', status: 'FAILED', sovScore: null } as Partial<AggregateEvent> & { queryId: string }),
    ])
    expect(queryLevelAggregate('run-1', [empty])).toBeNull()
  })

  it('竞品查询级 = 组级率的 macro；某组未提及计 0', () => {
    const a = groupAggregate([ev({ queryId: 'q1', platform: 'openai', competitors: [comp('Acme', true)] })])
    const b = groupAggregate([ev({ queryId: 'q1', platform: 'anthropic', competitors: [comp('Acme', false)] })])
    const level = queryLevelAggregate('run-1', [a, b])!
    expect(level.competitorMentionRates.Acme).toBeCloseTo(0.5)
  })

  it('topCompetitor 并列取字典序首个', () => {
    expect(pickTopCompetitor({ Zebra: 0.9, Alpha: 0.9, Mid: 0.5 })?.name).toBe('Alpha')
  })

  it('无竞品越过阈值 → null', () => {
    expect(pickTopCompetitor({ Acme: 0.4 })).toBeNull()
    expect(pickTopCompetitor({})).toBeNull()
  })
})

describe('loadWeakPoints（M2 §3.3）', () => {
  const QUERIES = [
    { id: 'q1', workspaceId: 'w1', queryText: 'AI 设计工具', status: 'ACTIVE', mappedPageUrl: 'https://example.com/a' },
    { id: 'q2', workspaceId: 'w1', queryText: 'PDF 转换', status: 'ACTIVE', mappedPageUrl: null },
  ]

  it('命中：品牌率 < 0.2 且竞品查询级率 > 0.4 → 返回薄弱点', async () => {
    const prisma = makePrisma({
      queries: QUERIES,
      runs: [{ id: 'run-1', workspaceId: 'w1', status: 'COMPLETED', finishedAt: new Date('2026-10-10T00:00:00Z') }],
      events: [
        ev({ queryId: 'q1', brandMentioned: false, competitors: [comp('Acme', true)] }),
        ev({ queryId: 'q1', brandMentioned: false, competitors: [comp('Acme', true)] }),
        // q2 品牌表现好，不该命中
        ev({ queryId: 'q2', brandMentioned: true, competitors: [comp('Acme', false)] }),
      ],
    })
    const points = await loadWeakPoints(prisma, { workspaceId: 'w1', ...RANGE })
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({
      queryId: 'q1',
      queryText: 'AI 设计工具',
      mappedPageUrl: 'https://example.com/a',
      runId: 'run-1',
      brandMentionRate: 0,
      validSamples: 2,
      topCompetitor: 'Acme',
    })
    expect(points[0].topCompetitorMentionRate).toBe(1)
  })

  it('品牌率达标 → 不命中', async () => {
    const prisma = makePrisma({
      queries: QUERIES,
      runs: [{ id: 'run-1', workspaceId: 'w1', status: 'COMPLETED', finishedAt: new Date('2026-10-10T00:00:00Z') }],
      events: [ev({ queryId: 'q1', brandMentioned: true, competitors: [comp('Acme', true)] })],
    })
    expect(await loadWeakPoints(prisma, { workspaceId: 'w1', ...RANGE })).toHaveLength(0)
  })

  it('竞品未越过 0.4 → 不命中', async () => {
    const prisma = makePrisma({
      queries: QUERIES,
      runs: [{ id: 'run-1', workspaceId: 'w1', status: 'COMPLETED', finishedAt: new Date('2026-10-10T00:00:00Z') }],
      events: [ev({ queryId: 'q1', brandMentioned: false, competitors: [comp('Acme', false)] })],
    })
    expect(await loadWeakPoints(prisma, { workspaceId: 'w1', ...RANGE })).toHaveLength(0)
  })

  it('取范围内最近的有效 Run（finishedAt 降序），旧 run 的更差数据不参与', async () => {
    const prisma = makePrisma({
      queries: QUERIES,
      runs: [
        { id: 'run-old', workspaceId: 'w1', status: 'COMPLETED', finishedAt: new Date('2026-10-01T00:00:00Z') },
        { id: 'run-new', workspaceId: 'w1', status: 'PARTIAL', finishedAt: new Date('2026-10-20T00:00:00Z') },
      ],
      events: [
        // run-old：品牌率 0 且竞品爆表（若被选中会被判薄弱）
        ev({ queryId: 'q1', runId: 'run-old', brandMentioned: false, competitors: [comp('Acme', true)] }),
        // run-new：品牌已起来 → 最近 run 不再命中
        ev({ queryId: 'q1', runId: 'run-new', brandMentioned: true, competitors: [comp('Acme', true)] }),
      ],
    })
    expect(await loadWeakPoints(prisma, { workspaceId: 'w1', ...RANGE })).toHaveLength(0)
  })

  it('最近 run 未收尾 → 跳过，退到上一个已收尾 run', async () => {
    const prisma = makePrisma({
      queries: QUERIES,
      runs: [
        { id: 'run-old', workspaceId: 'w1', status: 'COMPLETED', finishedAt: new Date('2026-10-01T00:00:00Z') },
        { id: 'run-running', workspaceId: 'w1', status: 'RUNNING', finishedAt: null },
      ],
      events: [ev({ queryId: 'q1', runId: 'run-old', brandMentioned: false, competitors: [comp('Acme', true)] })],
    })
    const points = await loadWeakPoints(prisma, { workspaceId: 'w1', ...RANGE })
    expect(points).toHaveLength(1)
    expect(points[0].runId).toBe('run-old')
  })

  it('FAILED run 不作基线（候选里就没有）', async () => {
    const prisma = makePrisma({
      queries: QUERIES,
      runs: [{ id: 'run-failed', workspaceId: 'w1', status: 'FAILED', finishedAt: new Date('2026-10-10T00:00:00Z') }],
      events: [ev({ queryId: 'q1', runId: 'run-failed', brandMentioned: false, competitors: [comp('Acme', true)] })],
    })
    expect(await loadWeakPoints(prisma, { workspaceId: 'w1', ...RANGE })).toHaveLength(0)
  })

  it('该查询在 run 内全失败（无有效组）→ 跳过该 run', async () => {
    const prisma = makePrisma({
      queries: QUERIES,
      runs: [{ id: 'run-1', workspaceId: 'w1', status: 'PARTIAL', finishedAt: new Date('2026-10-10T00:00:00Z') }],
      events: [ev({ queryId: 'q1', runId: 'run-1', status: 'FAILED', sovScore: null } as Partial<AggregateEvent> & { queryId: string })],
    })
    expect(await loadWeakPoints(prisma, { workspaceId: 'w1', ...RANGE })).toHaveLength(0)
  })

  it('无 ACTIVE 查询 → 空', async () => {
    const prisma = makePrisma({ queries: [], runs: [], events: [] })
    expect(await loadWeakPoints(prisma, { workspaceId: 'w1', ...RANGE })).toHaveLength(0)
  })

  it('未映射页面的薄弱点照样返回（mappedPageUrl=null，前端引导"去映射"）', async () => {
    const prisma = makePrisma({
      queries: [QUERIES[1]],
      runs: [{ id: 'run-1', workspaceId: 'w1', status: 'COMPLETED', finishedAt: new Date('2026-10-10T00:00:00Z') }],
      events: [ev({ queryId: 'q2', brandMentioned: false, competitors: [comp('Acme', true)] })],
    })
    const points = await loadWeakPoints(prisma, { workspaceId: 'w1', ...RANGE })
    expect(points).toHaveLength(1)
    expect(points[0].mappedPageUrl).toBeNull()
  })

  it('阈值常量与规格一致（0.2 / 0.4）', () => {
    expect(WEAK_BRAND_MENTION_RATE).toBe(0.2)
  })
})
