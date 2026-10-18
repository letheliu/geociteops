import type { PrismaClient } from '@prisma/client'
import {
  bucketLegacyDays,
  dayKey,
  dayStart,
  groupAggregate,
  groupEventsByKey,
  isDayInRange,
  okEventsWhere,
  runAggregate,
  toTrendPoint,
  type AggregateEvent,
  type RunStatus,
  type TrendPoint,
} from './aggregate.js'
import { MAX_TREND_RANGE_DAYS } from './aggregate.js'

/**
 * 读时聚合的查询层：把「查库 → 分组 → 聚合 → 装配趋势点」固定成一条路径。
 *
 * trend / runs.list / getSovScore / getEffectComparison 全部走这里，
 * 保证四者看到的永远是同一批数据点、同一套口径（规格 §5 的单点过滤 + §3 的期间级口径）。
 */

export interface TrendQueryInput {
  workspaceId: string
  /** 桶日 YYYY-MM-DD（含端点） */
  fromDay: string
  toDay: string
  queryId?: string
  platform?: string
}

/** 范围超过 366 天直接拒——避免一个请求把多年数据拉进内存 */
export function assertRangeWithinLimit(fromDay: string, toDay: string): void {
  const from = dayStart(fromDay).getTime()
  const to = dayStart(toDay).getTime()
  if (to < from) {
    throw new RangeError('dateRange 的 end 不能早于 start')
  }
  const days = Math.floor((to - from) / 86_400_000) + 1
  if (days > MAX_TREND_RANGE_DAYS) {
    throw new RangeError(`时间范围超过 ${MAX_TREND_RANGE_DAYS} 天（当前 ${days} 天）`)
  }
}

/**
 * 取一个时间范围内的趋势点：物理 Run + legacy 日桶，合并后按日期升序。
 *
 * 期间过滤键 = run.startedAt（物理）/ legacy 桶日——**不用 sample capturedAt**，
 * 否则跨日的 run 会被切成两半（规格 §3 明确）。
 */
export async function loadTrendPoints(prisma: PrismaClient, input: TrendQueryInput): Promise<TrendPoint[]> {
  const { workspaceId, fromDay, toDay, queryId, platform } = input

  const from = dayStart(fromDay)
  // 含 toDay 当天：用次日零点做开区间上界
  const toExclusive = new Date(dayStart(toDay).getTime() + 86_400_000)

  const runs = await prisma.citationRun.findMany({
    where: {
      workspaceId,
      startedAt: { gte: from, lt: toExclusive },
    },
    orderBy: { startedAt: 'asc' },
    select: { id: true, trigger: true, sampleCount: true, slotKey: true, status: true, startedAt: true },
  })

  const runIds = runs.map((r) => r.id)
  const eventFilter: Record<string, unknown> = {
    workspaceId,
    // 唯一过滤点：FAILED 行不进任何指标
    ...okEventsWhere(),
    OR: [{ runId: { in: runIds } }, { runId: null, capturedAt: { gte: from, lt: toExclusive } }],
  }
  if (queryId) eventFilter.queryId = queryId
  if (platform) eventFilter.platform = platform

  const events = (await prisma.citationEvent.findMany({
    where: eventFilter as any,
    select: {
      id: true,
      queryId: true,
      platform: true,
      runId: true,
      status: true,
      brandMentioned: true,
      brandSourceCited: true,
      rankInAnswer: true,
      sovScore: true,
      capturedAt: true,
    },
  })) as unknown as AggregateEvent[]

  // 物理 Run：按 runId 分组 → 组聚合 → Run 聚合
  const byRun = new Map<string, AggregateEvent[]>()
  const legacy: AggregateEvent[] = []
  for (const e of events) {
    if (e.runId === null || e.runId === undefined) {
      legacy.push(e)
      continue
    }
    const bucket = byRun.get(e.runId)
    if (bucket) bucket.push(e)
    else byRun.set(e.runId, [e])
  }

  const physicalPoints: TrendPoint[] = []
  for (const run of runs) {
    const runEvents = byRun.get(run.id) ?? []
    // 空 Run（尚无采样）不产生数据点——趋势不造零
    if (runEvents.length === 0) continue
    const agg = runAggregate([...groupEventsByKey(runEvents).values()].map(groupAggregate))
    physicalPoints.push(
      toTrendPoint({
        id: run.id,
        startedAt: run.startedAt,
        sampleCount: run.sampleCount,
        // 终态以 Run 行存值为准；RUNNING 期间用采样实况推导，避免轮询期间"完成度"倒退
        status: (run.status === 'RUNNING' ? agg.status : run.status) as RunStatus,
        slotKey: run.slotKey,
        trigger: run.trigger as 'SCHEDULED' | 'MANUAL',
        agg,
      }),
    )
  }

  // legacy 日桶：当日已有物理 Run 时不合成（防同日双点）
  const physicalRunDays = runs.map((r) => dayKey(r.startedAt))
  const legacyPoints: TrendPoint[] = bucketLegacyDays(legacy, physicalRunDays).map((bucket) =>
    toTrendPoint({
      id: bucket.id,
      startedAt: bucket.startedAt,
      sampleCount: bucket.events.length,
      status: bucket.agg.status,
      slotKey: null,
      trigger: 'LEGACY',
      agg: bucket.agg,
    }),
  )

  return [...physicalPoints, ...legacyPoints]
    // 桶日与范围相交判定（物理 Run 的 startedAt 可能落在 toDay 的更晚时刻）
    .filter((p) => isDayInRange(p.date, fromDay, toDay))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.startedAt < b.startedAt ? -1 : 1))
}

/** Reports 页的行视图：Run 行 + legacy 合成行同形状 */
export interface RunListRow {
  id: string
  date: string
  startedAt: string
  trigger: 'SCHEDULED' | 'MANUAL' | 'LEGACY'
  sampleCount: number
  validSamples: number
  failedSamples: number
  status: RunStatus
  slotKey: string | null
  legacy: boolean
  failureReason: string | null
}

export function toRunListRow(point: TrendPoint): RunListRow {
  return {
    id: point.id,
    date: point.date,
    startedAt: point.startedAt,
    trigger: point.trigger,
    sampleCount: point.sampleCount,
    validSamples: point.validSamples,
    failedSamples: point.failedSamples,
    status: point.status,
    slotKey: point.slotKey,
    legacy: point.legacy,
    failureReason: null,
  }
}
