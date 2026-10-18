import { describe, it, expect } from 'vitest'
import {
  okEventsWhere,
  isLegacyEvent,
  dayKey,
  dayStart,
  groupKey,
  groupEventsByKey,
  groupAggregate,
  runAggregate,
  periodAggregate,
  bucketLegacyDays,
  toTrendPoint,
  deriveRunStatus,
  isDayInRange,
  MAX_TREND_RANGE_DAYS,
  type AggregateEvent,
  type TrendPoint,
} from './aggregate.js'

/** 测试用事件工厂：只填聚合口径真正读取的字段 */
function ev(over: Partial<AggregateEvent> = {}): AggregateEvent {
  return {
    id: 'e-' + Math.random().toString(36).slice(2, 8),
    queryId: 'q1',
    platform: 'openai',
    runId: 'run-1',
    sampleIndex: 1,
    status: 'OK',
    brandMentioned: false,
    brandSourceCited: false,
    rankInAnswer: null,
    sovScore: null,
    capturedAt: new Date('2026-10-18T04:00:00.000Z'),
    ...over,
  }
}

/** 规格 §3 数值算例：run 内 Q1×A 5 个 OK，Q1×B 1 个 OK + 1 个 FAILED */
function specExampleEvents(): AggregateEvent[] {
  const A = [
    ev({ id: 'a1', queryId: 'q1', platform: 'openai', sampleIndex: 1, sovScore: 0.2, brandMentioned: true, rankInAnswer: 1 }),
    ev({ id: 'a2', queryId: 'q1', platform: 'openai', sampleIndex: 2, sovScore: 0.4, brandMentioned: true, rankInAnswer: 2 }),
    ev({ id: 'a3', queryId: 'q1', platform: 'openai', sampleIndex: 3, sovScore: 0.4, brandMentioned: false, brandSourceCited: false }),
    ev({ id: 'a4', queryId: 'q1', platform: 'openai', sampleIndex: 4, sovScore: 0.6, brandMentioned: true, rankInAnswer: 4, brandSourceCited: true }),
    ev({ id: 'a5', queryId: 'q1', platform: 'openai', sampleIndex: 5, sovScore: 0.4, brandMentioned: false }),
  ]
  const B = [
    ev({ id: 'b1', queryId: 'q1', platform: 'anthropic', sampleIndex: 1, sovScore: 0.0 }),
    ev({ id: 'b2', queryId: 'q1', platform: 'anthropic', sampleIndex: 2, status: 'FAILED', sovScore: null, failureReason: 'boom' } as Partial<AggregateEvent>),
  ]
  return [...A, ...B]
}

describe('okEventsWhere / isLegacyEvent', () => {
  it('okEventsWhere 是唯一过滤点且只含 status=OK', () => {
    expect(okEventsWhere()).toEqual({ status: 'OK' })
  })

  it('isLegacyEvent 以 runId 为 null 判定', () => {
    expect(isLegacyEvent(ev({ runId: null }))).toBe(true)
    expect(isLegacyEvent(ev({ runId: undefined }))).toBe(true)
    expect(isLegacyEvent(ev({ runId: 'run-1' }))).toBe(false)
  })
})

describe('dayKey / dayStart（Asia/Shanghai 日界）', () => {
  it('日键按 Asia/Shanghai 计算而非 UTC', () => {
    // UTC 10-18 16:30 = 上海 10-19 00:30 → 日键必须已经翻到 10-19
    expect(dayKey(new Date('2026-10-18T16:30:00.000Z'))).toBe('2026-10-19')
    // 上海时间 10-19 00:00 整点翻日
    expect(dayKey(new Date('2026-10-18T16:00:00.000Z'))).toBe('2026-10-19')
    // 差一毫秒仍在 10-18
    expect(dayKey(new Date('2026-10-18T15:59:59.000Z'))).toBe('2026-10-18')
  })

  it('dayStart 返回该日上海 00:00', () => {
    expect(dayStart('2026-10-18').toISOString()).toBe('2026-10-17T16:00:00.000Z')
  })

  it('isDayInRange 用桶日相交判定（含端点）', () => {
    expect(isDayInRange('2026-10-18', '2026-10-01', '2026-10-31')).toBe(true)
    expect(isDayInRange('2026-10-01', '2026-10-01', '2026-10-31')).toBe(true)
    expect(isDayInRange('2026-10-31', '2026-10-01', '2026-10-31')).toBe(true)
    expect(isDayInRange('2026-11-01', '2026-10-01', '2026-10-31')).toBe(false)
  })

  it('MAX_TREND_RANGE_DAYS 为 366', () => {
    expect(MAX_TREND_RANGE_DAYS).toBe(366)
  })
})

describe('groupAggregate — 采样级→组级（规格 §3 表）', () => {
  it('validSamples = OK 且 sovScore 非 null', () => {
    const g = groupAggregate([
      ev({ sovScore: 0.5 }),
      ev({ sovScore: null }),          // OK 但无 sovScore → 不计入 validSamples
      ev({ status: 'FAILED', sovScore: 0.9, brandMentioned: true }),
    ])
    expect(g.validSamples).toBe(1)
    expect(g.okSamples).toBe(2)
    expect(g.failedSamples).toBe(1)
    expect(g.sovMean).toBe(0.5)
  })

  it('sovMean 是 validSamples 的算术平均', () => {
    const g = groupAggregate(specExampleEvents().filter((e) => e.platform === 'openai'))
    expect(g.validSamples).toBe(5)
    expect(g.sovMean).toBeCloseTo(0.4, 10)
  })

  it('提及率/引用率的分母统一是 validSamples', () => {
    // 3 个 valid：提及 2、被引 1 → 2/3 与 1/3
    const g = groupAggregate([
      ev({ sovScore: 0.1, brandMentioned: true }),
      ev({ sovScore: 0.2, brandMentioned: true, brandSourceCited: true }),
      ev({ sovScore: 0.3 }),
    ])
    expect(g.brandMentionRate).toBeCloseTo(2 / 3, 10)
    expect(g.brandSourceCitationRate).toBeCloseTo(1 / 3, 10)
  })

  it('ranked 宇宙 = OK && 提及 && rankInAnswer 非 null', () => {
    const g = groupAggregate([
      ev({ brandMentioned: true, rankInAnswer: 2, sovScore: 0.1 }),
      ev({ brandMentioned: false, rankInAnswer: 5, sovScore: 0.1 }), // 未提及 → 不进 ranked
      ev({ brandMentioned: true, rankInAnswer: null, sovScore: 0.1 }), // 提及但无 rank → 不进
      ev({ status: 'FAILED', brandMentioned: true, rankInAnswer: 1, sovScore: null }), // FAILED → 不进
    ])
    expect(g.ranks).toEqual([2])
    expect(g.rankMedian).toBe(2)
    expect(g.rankBest).toBe(2)
  })

  it('无 ranked 样本时 rank 指标为 null，不造 0', () => {
    const g = groupAggregate([ev({ sovScore: 0.1 }), ev({ sovScore: 0.2, brandMentioned: false })])
    expect(g.rankMedian).toBeNull()
    expect(g.rankBest).toBeNull()
  })

  it('rankMedian 是组内中位数（偶数个取中间两数均值）', () => {
    const g = groupAggregate([
      ev({ brandMentioned: true, rankInAnswer: 1, sovScore: 0.1 }),
      ev({ brandMentioned: true, rankInAnswer: 3, sovScore: 0.1 }),
      ev({ brandMentioned: true, rankInAnswer: 4, sovScore: 0.1 }),
      ev({ brandMentioned: true, rankInAnswer: 5, sovScore: 0.1 }),
    ])
    expect(g.rankMedian).toBe(3.5)
    expect(g.rankBest).toBe(1)
  })

  it('sovStdDev 是样本标准差（N-1），N=1 时为 0', () => {
    const one = groupAggregate([ev({ sovScore: 0.7 })])
    expect(one.sovStdDev).toBe(0)

    const two = groupAggregate([ev({ sovScore: 0.2 }), ev({ sovScore: 0.6 })])
    // 样本标准差：|0.6-0.2| / sqrt(2) = 0.2828...
    expect(two.sovStdDev).toBeCloseTo(0.4 / Math.SQRT2, 10)
  })

  it('全 FAILED 组：所有指标为 null 且不进 Run 级平均', () => {
    const g = groupAggregate([
      ev({ status: 'FAILED', sovScore: null, failureReason: 'x' }),
      ev({ status: 'FAILED', sovScore: null, failureReason: 'y' }),
    ])
    expect(g.validSamples).toBe(0)
    expect(g.failedSamples).toBe(2)
    expect(g.sovMean).toBeNull()
    expect(g.brandMentionRate).toBeNull()
    expect(g.rankMedian).toBeNull()
    expect(g.sovStdDev).toBeNull()

    const run = runAggregate([g])
    expect(run.validSamples).toBe(0)
    expect(run.sovMean).toBeNull()
  })

  it('groupKey / groupEventsByKey 按 query×platform 分组', () => {
    const events = specExampleEvents()
    const groups = groupEventsByKey(events)
    expect([...groups.keys()].sort()).toEqual(['q1::anthropic', 'q1::openai'])
    expect(groupKey(events[0])).toBe('q1::openai')
  })
})

describe('runAggregate — 组级→Run 级（macro 等权）', () => {
  it('规格 §3 算例逐值复现', () => {
    const groups = [...groupEventsByKey(specExampleEvents()).values()].map(groupAggregate)
    const run = runAggregate(groups)

    // 组 A: sovMean=0.4 rate=0.6 rankMedian=2；组 B: sovMean=0.0 rate=0.0 rank 跳过
    const A = groups.find((g) => g.platform === 'openai')!
    const B = groups.find((g) => g.platform === 'anthropic')!
    expect(A.sovMean).toBeCloseTo(0.4, 10)
    expect(A.brandMentionRate).toBeCloseTo(0.6, 10)
    expect(A.rankMedian).toBe(2)
    expect(B.sovMean).toBe(0)
    expect(B.brandMentionRate).toBe(0)
    expect(B.rankMedian).toBeNull()

    // Run 级：macro 0.2 / 0.3；rankMedian 池化 2；rankBest 全局 1；6 valid / 1 failed / PARTIAL
    expect(run.sovMean).toBeCloseTo(0.2, 10)
    expect(run.brandMentionRate).toBeCloseTo(0.3, 10)
    expect(run.rankMedian).toBe(2)
    expect(run.rankBest).toBe(1)
    expect(run.validSamples).toBe(6)
    expect(run.failedSamples).toBe(1)
    expect(run.status).toBe('PARTIAL')
  })

  it('macro：1 样本组与 5 样本组等权', () => {
    // 组 A：5 个样本均 1.0 → 1.0；组 B：1 个样本 0.0 → 0.0。micro 会得 5/6，macro 必须是 0.5
    const run = runAggregate([
      groupAggregate(Array.from({ length: 5 }, () => ev({ platform: 'openai', sovScore: 1 }))),
      groupAggregate([ev({ platform: 'anthropic', sovScore: 0 })]),
    ])
    expect(run.sovMean).toBeCloseTo(0.5, 10)
    expect(run.validSamples).toBe(6)
  })

  it('rankMedian 在 Run 级是池化中位数而非组中位数的平均', () => {
    // 组 A 池化 [1,2] → 1.5；组 B 池化 [10,20] → 15。组中位数的平均是 8.25，
    // 全池 [1,2,10,20] 的中位数 = (2+10)/2 = 6 —— 断言拿到的是后者
    const run = runAggregate([
      groupAggregate([
        ev({ platform: 'openai', brandMentioned: true, rankInAnswer: 1, sovScore: 0.1 }),
        ev({ platform: 'openai', brandMentioned: true, rankInAnswer: 2, sovScore: 0.1 }),
      ]),
      groupAggregate([
        ev({ platform: 'anthropic', brandMentioned: true, rankInAnswer: 10, sovScore: 0.1 }),
        ev({ platform: 'anthropic', brandMentioned: true, rankInAnswer: 20, sovScore: 0.1 }),
      ]),
    ])
    expect(run.rankMedian).toBe(6)
    expect(run.rankBest).toBe(1)
  })

  it('Run 级 sovStdDev 是各组 stdDev 的均值（平均组内离散度）', () => {
    const run = runAggregate([
      groupAggregate([ev({ platform: 'openai', sovScore: 0.0 }), ev({ platform: 'openai', sovScore: 1.0 })]), // √0.5
      groupAggregate([ev({ platform: 'anthropic', sovScore: 0.2 }), ev({ platform: 'anthropic', sovScore: 0.6 })]), // 0.4/√2
    ])
    const expected = (Math.SQRT1_2 + 0.4 / Math.SQRT2) / 2
    expect(run.sovStdDev).toBeCloseTo(expected, 10)
  })

  it('deriveRunStatus：全 OK=COMPLETED，部分失败=PARTIAL，0 OK=FAILED', () => {
    expect(deriveRunStatus(5, 0)).toBe('COMPLETED')
    expect(deriveRunStatus(4, 1)).toBe('PARTIAL')
    expect(deriveRunStatus(0, 3)).toBe('FAILED')
    expect(deriveRunStatus(0, 0)).toBe('RUNNING')
  })

  it('0 OK 全 FAILED 的 Run 不产生任何指标', () => {
    const run = runAggregate([
      groupAggregate([
        ev({ status: 'FAILED', sovScore: null }),
        ev({ status: 'FAILED', sovScore: null }),
      ]),
    ])
    expect(run.status).toBe('FAILED')
    expect(run.sovMean).toBeNull()
    expect(run.brandMentionRate).toBeNull()
    expect(run.rankMedian).toBeNull()
    expect(run.validSamples).toBe(0)
    expect(run.failedSamples).toBe(2)
  })
})

describe('bucketLegacyDays — legacy 日桶合成（规格 §7）', () => {
  const legacyEvents = [
    ev({ id: 'l1', runId: null, queryId: 'q1', platform: 'openai', capturedAt: new Date('2026-10-10T02:00:00.000Z'), sovScore: 1, brandMentioned: true, rankInAnswer: 1 }),
    ev({ id: 'l2', runId: null, queryId: 'q1', platform: 'anthropic', capturedAt: new Date('2026-10-10T09:00:00.000Z'), sovScore: 0 }),
    // 上海时间 10-11 凌晨（UTC 10-10 16:30）
    ev({ id: 'l3', runId: null, queryId: 'q2', platform: 'openai', capturedAt: new Date('2026-10-10T16:30:00.000Z'), sovScore: 0.5 }),
  ]

  it('按 Asia/Shanghai 自然日分桶，合成 legacy:<date> ID', () => {
    const buckets = bucketLegacyDays(legacyEvents, [])
    expect(buckets).toHaveLength(2)
    expect(buckets[0].id).toBe('legacy:2026-10-10')
    expect(buckets[0].date).toBe('2026-10-10')
    expect(buckets[0].startedAt.toISOString()).toBe('2026-10-09T16:00:00.000Z')
    expect(buckets[1].id).toBe('legacy:2026-10-11')
    expect(buckets[1].events).toHaveLength(1)
  })

  it('桶内按 query×platform 合成组并做 macro 聚合', () => {
    const bucket = bucketLegacyDays(legacyEvents, [])[0]
    expect(bucket.agg.validSamples).toBe(2)
    expect(bucket.agg.sovMean).toBeCloseTo(0.5, 10) // (1 + 0) / 2，组等权
    expect(bucket.agg.brandMentionRate).toBeCloseTo(0.5, 10)
    expect(bucket.agg.rankBest).toBe(1)
  })

  it('当日已有物理 Run 时不合成 legacy 桶（防同日双点）', () => {
    const buckets = bucketLegacyDays(legacyEvents, ['2026-10-10'])
    expect(buckets.map((b) => b.id)).toEqual(['legacy:2026-10-11'])
  })

  it('physicalRunDays 接受 Set 与数组', () => {
    expect(bucketLegacyDays(legacyEvents, new Set(['2026-10-10', '2026-10-11']))).toHaveLength(0)
  })

  it('只合成 legacy 行（runId 非 null 的事件忽略）', () => {
    expect(bucketLegacyDays([ev({ runId: 'run-9', capturedAt: new Date('2026-10-10T02:00:00.000Z') })], [])).toHaveLength(0)
  })
})

describe('periodAggregate — 期间级（macro over 数据点）', () => {
  function point(over: Partial<TrendPoint> & { id: string; date: string; agg: ReturnType<typeof runAggregate> }): TrendPoint {
    return toTrendPoint({
      id: over.id,
      startedAt: dayStart(over.date),
      sampleCount: 5,
      status: over.status ?? 'COMPLETED',
      slotKey: null,
      trigger: 'SCHEDULED',
      agg: over.agg,
      ...(over.trigger ? { trigger: over.trigger } : {}),
      ...(over.slotKey !== undefined ? { slotKey: over.slotKey } : {}),
    })
  }

  it('多 Run 等权平均（macro over 数据点）', () => {
    const p1 = point({
      id: 'run-1', date: '2026-10-10',
      agg: runAggregate([groupAggregate([ev({ sovScore: 1 })])]),
    })
    const p2 = point({
      id: 'run-2', date: '2026-10-11',
      agg: runAggregate([groupAggregate([ev({ sovScore: 0, brandMentioned: false })])]),
    })
    const period = periodAggregate([p1, p2])
    expect(period.sovMean).toBeCloseTo(0.5, 10)
    expect(period.validSamples).toBe(2)
  })

  it('PARTIAL 计入、FAILED 排除', () => {
    const partial = point({
      id: 'run-p', date: '2026-10-10', status: 'PARTIAL',
      agg: runAggregate([groupAggregate([ev({ sovScore: 1 }), ev({ platform: 'anthropic', status: 'FAILED', sovScore: null })])]),
    })
    const failed = point({
      id: 'run-f', date: '2026-10-11', status: 'FAILED',
      agg: runAggregate([groupAggregate([ev({ status: 'FAILED', sovScore: null })])]),
    })
    const period = periodAggregate([partial, failed])
    expect(period.sovMean).toBeCloseTo(1, 10) // FAILED 点的 null 被跳过
    expect(period.validSamples).toBe(1)
    expect(period.failedSamples).toBe(1)
  })

  it('rank 走池化：期间级 rankMedian/rankBest 取全池', () => {
    const p1 = point({
      id: 'run-1', date: '2026-10-10',
      agg: runAggregate([groupAggregate([
        ev({ brandMentioned: true, rankInAnswer: 2, sovScore: 0.1 }),
        ev({ brandMentioned: true, rankInAnswer: 4, sovScore: 0.1 }),
      ])]),
    })
    const p2 = point({
      id: 'run-2', date: '2026-10-11',
      agg: runAggregate([groupAggregate([ev({ brandMentioned: true, rankInAnswer: 9, sovScore: 0.1 })])]),
    })
    const period = periodAggregate([p1, p2])
    expect(period.ranks.sort((a, b) => a - b)).toEqual([2, 4, 9])
    expect(period.rankMedian).toBe(4)
    expect(period.rankBest).toBe(2)
  })

  it('空数据点时全部指标为 null 而不是 0', () => {
    const period = periodAggregate([])
    expect(period.sovMean).toBeNull()
    expect(period.brandMentionRate).toBeNull()
    expect(period.rankMedian).toBeNull()
    expect(period.rankBest).toBeNull()
    expect(period.validSamples).toBe(0)
  })

  it('legacy 点与物理 Run 点同权参与（macro over 数据点）', () => {
    const legacy = toTrendPoint({
      id: 'legacy:2026-10-11',
      startedAt: dayStart('2026-10-11'),
      sampleCount: 2,
      status: 'COMPLETED',
      slotKey: null,
      trigger: 'LEGACY',
      agg: runAggregate([groupAggregate([ev({ runId: null, sovScore: 0 })])]),
    })
    const physical = point({
      id: 'run-1', date: '2026-10-10',
      agg: runAggregate([groupAggregate([ev({ sovScore: 1 })])]),
    })
    const period = periodAggregate([physical, legacy])
    expect(period.sovMean).toBeCloseTo(0.5, 10)
  })
})

describe('toTrendPoint', () => {
  it('携带 run 元信息供 tooltip 使用', () => {
    const agg = runAggregate([groupAggregate([ev({ sovScore: 0.5, brandMentioned: true, rankInAnswer: 2 })])])
    const tp = toTrendPoint({
      id: 'run-7',
      startedAt: new Date('2026-10-18T18:00:00.000Z'), // 上海 10-19 02:00
      sampleCount: 5,
      status: 'PARTIAL',
      slotKey: 'w1:2026-10-19',
      trigger: 'SCHEDULED',
      agg,
    })
    expect(tp.date).toBe('2026-10-19')
    expect(tp.startedAt).toBe(new Date('2026-10-18T18:00:00.000Z').toISOString())
    expect(tp.sampleCount).toBe(5)
    expect(tp.validSamples).toBe(1)
    expect(tp.failedSamples).toBe(0)
    expect(tp.status).toBe('PARTIAL')
    expect(tp.slotKey).toBe('w1:2026-10-19')
    expect(tp.legacy).toBe(false)
    expect(tp.sovMean).toBe(0.5)
    expect(tp.rankMedian).toBe(2)
  })

  it('legacy 点 legacy=true 且 slotKey 为 null', () => {
    const tp = toTrendPoint({
      id: 'legacy:2026-10-10',
      startedAt: dayStart('2026-10-10'),
      sampleCount: 3,
      status: 'COMPLETED',
      slotKey: null,
      trigger: 'LEGACY',
      agg: runAggregate([groupAggregate([ev({ runId: null, sovScore: 0.2 })])]),
    })
    expect(tp.legacy).toBe(true)
    expect(tp.slotKey).toBeNull()
  })
})

describe('对拍：macro vs micro（旧口径，规格 §7）', () => {
  /** micro = 全事件池化的 mentioned/total（旧产品日聚合口径） */
  function microMentionRate(events: AggregateEvent[]): number {
    const valid = events.filter((e) => e.status === 'OK' && e.sovScore !== null)
    return valid.length === 0 ? 0 : valid.filter((e) => e.brandMentioned).length / valid.length
  }

  it('等价 fixture：每组每日 ≤1 事件时 macro ≡ micro', () => {
    const events: AggregateEvent[] = [
      ev({ id: 'x1', runId: null, queryId: 'q1', platform: 'openai', brandMentioned: true, sovScore: 0.5 }),
      ev({ id: 'x2', runId: null, queryId: 'q2', platform: 'openai', brandMentioned: false, sovScore: 0.5 }),
      ev({ id: 'x3', runId: null, queryId: 'q3', platform: 'anthropic', brandMentioned: true, sovScore: 0.5 }),
    ]
    const groups = [...groupEventsByKey(events).values()].map(groupAggregate)
    const macro = runAggregate(groups).brandMentionRate!
    expect(macro).toBe(microMentionRate(events))
    expect(macro).toBeCloseTo(2 / 3, 10)
  })

  it('不等价 fixture：同组同日多事件时差值等于两公式之差', () => {
    // 组 A（openai）2 个事件都提及 → 组率 1.0；组 B（anthropic）1 个未提及 → 组率 0.0
    const events: AggregateEvent[] = [
      ev({ id: 'y1', runId: null, queryId: 'q1', platform: 'openai', brandMentioned: true, sovScore: 0.4 }),
      ev({ id: 'y2', runId: null, queryId: 'q1', platform: 'openai', brandMentioned: true, sovScore: 0.6 }),
      ev({ id: 'y3', runId: null, queryId: 'q2', platform: 'anthropic', brandMentioned: false, sovScore: 0.1 }),
    ]
    const groups = [...groupEventsByKey(events).values()].map(groupAggregate)
    const macro = runAggregate(groups).brandMentionRate!
    const micro = microMentionRate(events)

    expect(macro).toBeCloseTo(0.5, 10)   // (1.0 + 0.0) / 2
    expect(micro).toBeCloseTo(2 / 3, 10)  // 2 / 3
    expect(macro - micro).toBeCloseTo(0.5 - 2 / 3, 10) // 差值 = 两公式之差
    expect(macro).not.toBeCloseTo(micro, 10)
  })
})

describe('方差验收：N 次采样聚合抹平随机性（规格 §12）', () => {
  /** mulberry32：固定种子 PRNG，保证测试可复现 */
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  /** 单次采样的 sovScore：10 次机会里"赢" k 次 → k/10，Binomial(10, 0.35) */
  const P = 0.35
  function sampleSovScore(rand: () => number): number {
    let wins = 0
    for (let i = 0; i < 10; i++) if (rand() < P) wins++
    return wins / 10
  }

  function variance(values: number[]): number {
    const mean = values.reduce((s, v) => s + v, 0) / values.length
    return values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1)
  }

  it('N=5 聚合方差显著小于单采样方差，且均值收敛于期望 ±0.02', () => {
    const RUNS = 1000
    const N = 5
    const singleScores: number[] = []
    const runMeans: number[] = []

    for (let r = 0; r < RUNS; r++) {
      const rand = mulberry32(20261018 + r)
      // 每次采样 = 一个 query×platform 组里的一个样本
      const samples = Array.from({ length: N }, () => sampleSovScore(rand))
      singleScores.push(...samples)

      // 走真实聚合路径：N 个采样行 → groupAggregate → runAggregate
      const group = groupAggregate(samples.map((s, i) => ev({ sampleIndex: i + 1, sovScore: s })))
      const run = runAggregate([group])
      expect(run.validSamples).toBe(N)
      runMeans.push(run.sovMean!)
    }

    const singleVar = variance(singleScores)
    const runVar = variance(runMeans)
    // N=5 理论上方差降至 1/5，留一倍余量仍断言 < 0.6
    expect(runVar).toBeLessThan(singleVar * 0.6)

    const expected = P
    const mean = runMeans.reduce((s, v) => s + v, 0) / runMeans.length
    expect(Math.abs(mean - expected)).toBeLessThan(0.02)
  })

  it('同一批分数走真实聚合链路得到的 Run 级 sovMean 与手算一致', () => {
    const rand = mulberry32(20261018)
    const N = 5
    const scores = Array.from({ length: N }, () => sampleSovScore(rand))
    const agg = runAggregate([
      groupAggregate(scores.map((s, i) => ev({ sampleIndex: i + 1, sovScore: s }))),
    ])
    expect(agg.sovMean).toBeCloseTo(scores.reduce((s, v) => s + v, 0) / N, 12)
  })
})
