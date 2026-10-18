/**
 * 监测读时聚合（规格 §3 口径表 / §7 legacy 适配）
 *
 * 本模块是**纯函数**、不 import Prisma——where 片段是字面量对象，事件是结构兼容的最小视图。
 * 好处是口径可脱离数据库单测，且所有读路径共用同一份实现，杜绝 micro/macro 口径漂移。
 *
 * 口径三层：采样级(Event) → 组级(run × query × platform) → Run 级 → 期间级。
 * macro（组等权）理由：查询重要性不随采样数变化，1 样本组与 5 样本组等权。
 */

/** 与 Prisma CitationEvent 结构兼容的最小视图——不 import Prisma 类型，保持纯函数 */
export interface AggregateEvent {
  id?: string
  workspaceId?: string
  queryId: string
  platform: string
  /** null/undefined = 遗留事件（读时按自然日合成伪 Run） */
  runId?: string | null
  sampleIndex?: number
  status: 'OK' | 'FAILED'
  brandMentioned: boolean
  brandSourceCited: boolean
  rankInAnswer: number | null
  sovScore: number | null
  capturedAt: Date
  failureReason?: string | null
  /**
   * 竞品提及（M2 §3.3 竞品口径的唯一输入）：[{brand, mentioned, rank, ...}]。
   * 趋势读路径不 select 该列（省列），只有 weakPoints 单独取数时读——
   * 分母口径与品牌指标完全同源（validSamples），只是数据通道独立。
   */
  competitors?: unknown
}

export type RunStatus = 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED'
export type RunTrigger = 'SCHEDULED' | 'MANUAL' | 'LEGACY'

/** 趋势一次范围的最大天数（规格 §8） */
export const MAX_TREND_RANGE_DAYS = 366

/** 时区固定为 Asia/Shanghai：日界、slotKey、legacy 桶都以它为准 */
const MONITOR_TZ = 'Asia/Shanghai'

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: MONITOR_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/**
 * CitationEvent 读取的唯一过滤点（规格 §5）。
 * 任何绕过它的查询都会把 FAILED 行当成"未提及"——这是 review 重点 #1 的钉子。
 */
export function okEventsWhere(): { status: 'OK' } {
  return { status: 'OK' }
}

/** 遗留事件判定：runId 为空即 legacy（规格 §4） */
export function isLegacyEvent(e: Pick<AggregateEvent, 'runId'>): boolean {
  return e.runId === null || e.runId === undefined
}

/** Asia/Shanghai 日键 YYYY-MM-DD。UTC 已跨日但上海未跨日时仍归前一日——桶日与 slotKey 都依赖它 */
export function dayKey(d: Date): string {
  return dayFormatter.format(d)
}

/** 该日 Asia/Shanghai 00:00 对应的 UTC 时刻（legacy 桶的 startedAt） */
export function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00+08:00`)
}

/** 桶日与范围相交判定（含端点）；YYYY-MM-DD 字典序即时间序，可直接比较 */
export function isDayInRange(day: string, fromDay: string, toDay: string): boolean {
  return day >= fromDay && day <= toDay
}

/** 组键 = query × platform（规格 §3 组级定义） */
export function groupKey(e: Pick<AggregateEvent, 'queryId' | 'platform'>): string {
  return `${e.queryId}::${e.platform}`
}

/** 按组键切分，保持首次出现顺序（macro 平均的稳定性依赖它） */
export function groupEventsByKey(events: readonly AggregateEvent[]): Map<string, AggregateEvent[]> {
  const groups = new Map<string, AggregateEvent[]>()
  for (const e of events) {
    const key = groupKey(e)
    const bucket = groups.get(key)
    if (bucket) bucket.push(e)
    else groups.set(key, [e])
  }
  return groups
}

export interface GroupAgg {
  /** `${queryId}::${platform}` */
  key: string
  queryId: string
  platform: string
  /** 统一分母：OK 且 sovScore 非 null */
  validSamples: number
  okSamples: number
  failedSamples: number
  sovMean: number | null
  brandMentionRate: number | null
  brandSourceCitationRate: number | null
  rankMedian: number | null
  rankBest: number | null
  /** 样本标准差（N-1）；N<2 为 0；validSamples=0（组被跳过）时为 null */
  sovStdDev: number | null
  /** 池化 rank 样本，供 Run/期间级复用 */
  ranks: number[]
  /**
   * 竞品 → 提及率（M2 §3.3 规格 §5）：**与 brandMentionRate 同分母**（本组 validSamples），
   * 只统计 OK 且 sovScore 非 null 的样本。从未提及的竞品不进 map（不是 0）；
   * validSamples=0 的组恒为空对象。
   */
  competitorMentionRates: Record<string, number>
}

export interface RunAgg {
  validSamples: number
  okSamples: number
  failedSamples: number
  sovMean: number | null
  brandMentionRate: number | null
  brandSourceCitationRate: number | null
  rankMedian: number | null
  rankBest: number | null
  sovStdDev: number | null
  status: RunStatus
  ranks: number[]
  groups: GroupAgg[]
}

export interface PeriodAgg {
  validSamples: number
  okSamples: number
  failedSamples: number
  sovMean: number | null
  brandMentionRate: number | null
  brandSourceCitationRate: number | null
  rankMedian: number | null
  rankBest: number | null
  sovStdDev: number | null
  ranks: number[]
  /** 参与平均的数据点数（macro over 数据点） */
  pointCount: number
}

/** 趋势序列的一个点：物理 Run 或 legacy 日桶共用（规格 §8） */
export interface TrendPoint {
  /** CitationRun.id 或 `legacy:<YYYY-MM-DD>` */
  id: string
  /** 桶日 Asia/Shanghai YYYY-MM-DD——范围相交判定用 */
  date: string
  startedAt: string
  trigger: RunTrigger
  /** 生效 N */
  sampleCount: number
  validSamples: number
  okSamples: number
  failedSamples: number
  status: RunStatus
  slotKey: string | null
  /** legacy 日桶为 true（UI 虚线样式 + tooltip 口径注明） */
  legacy: boolean
  sovMean: number | null
  brandMentionRate: number | null
  brandSourceCitationRate: number | null
  sovStdDev: number | null
  rankMedian: number | null
  rankBest: number | null
  ranks: number[]
}

/** legacy 事件按自然日合成的伪 Run（不写物理行） */
export interface SyntheticRun {
  id: string
  date: string
  startedAt: Date
  legacy: true
  events: AggregateEvent[]
  agg: RunAgg
}

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** 样本标准差（N-1）；N<2 返回 0 —— 1 个样本没有离散度，但也不能报 undefined */
function sampleStdDev(values: number[]): number | null {
  if (values.length === 0) return null
  if (values.length < 2) return 0
  const m = mean(values)
  const sumSq = values.reduce((s, v) => s + (v - m) ** 2, 0)
  return Math.sqrt(sumSq / (values.length - 1))
}

/** 对非 null 指标取等权平均（macro）；全 null 时返回 null，不造 0 */
function macroMean(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v !== null)
  return valid.length === 0 ? null : mean(valid)
}

/**
 * 组级竞品提及率（M2 §3.3 规格 §5）：竞品名 → 提及样本数 / 本组 validSamples。
 * 与品牌指标同一个分母（同一批 valid 样本），因此"竞品提及率高"与"品牌提及率低"
 * 一定落在同一批样本上，不会出现两张表分母不一致的伪信号。
 */
function competitorMentionRates(valid: readonly AggregateEvent[]): Record<string, number> {
  const counts = new Map<string, number>()
  for (const e of valid) {
    if (!Array.isArray(e.competitors)) continue
    for (const c of e.competitors as Array<{ brand?: unknown; mentioned?: unknown }>) {
      if (!c || typeof c.brand !== 'string' || c.mentioned !== true) continue
      counts.set(c.brand, (counts.get(c.brand) ?? 0) + 1)
    }
  }
  const out: Record<string, number> = {}
  for (const [brand, count] of counts) out[brand] = count / valid.length
  return out
}

/**
 * 组级聚合：run × query × platform。
 * validSamples=0（全 FAILED 或全无 sovScore）的组所有指标为 null，调用方据此跳过——不造 0。
 */
export function groupAggregate(events: AggregateEvent[]): GroupAgg {
  if (events.length === 0) {
    throw new Error('groupAggregate 需要至少一个事件——空组应由调用方跳过')
  }
  const first = events[0]
  const valid = events.filter((e) => e.status === 'OK' && e.sovScore !== null)
  const okSamples = events.filter((e) => e.status === 'OK').length
  const failedSamples = events.filter((e) => e.status === 'FAILED').length
  // ranked 宇宙独立于 validSamples：只要 OK + 提及 + 有名次
  const ranks = events
    .filter((e) => e.status === 'OK' && e.brandMentioned && e.rankInAnswer !== null)
    .map((e) => e.rankInAnswer as number)

  if (valid.length === 0) {
    return {
      key: groupKey(first),
      queryId: first.queryId,
      platform: first.platform,
      validSamples: 0,
      okSamples,
      failedSamples,
      sovMean: null,
      brandMentionRate: null,
      brandSourceCitationRate: null,
      rankMedian: null,
      rankBest: null,
      sovStdDev: null,
      ranks,
      competitorMentionRates: {},
    }
  }

  const sovScores = valid.map((e) => e.sovScore as number)
  return {
    key: groupKey(first),
    queryId: first.queryId,
    platform: first.platform,
    validSamples: valid.length,
    okSamples,
    failedSamples,
    sovMean: mean(sovScores),
    brandMentionRate: valid.filter((e) => e.brandMentioned).length / valid.length,
    brandSourceCitationRate: valid.filter((e) => e.brandSourceCited).length / valid.length,
    rankMedian: ranks.length > 0 ? median(ranks) : null,
    rankBest: ranks.length > 0 ? Math.min(...ranks) : null,
    sovStdDev: sampleStdDev(sovScores),
    ranks,
    competitorMentionRates: competitorMentionRates(valid),
  }
}

/** Run 终态推导（规格 §10）：全 OK=COMPLETED；部分失败且有 OK=PARTIAL；0 OK=FAILED；未收到任何采样=RUNNING */
export function deriveRunStatus(okSamples: number, failedSamples: number): RunStatus {
  if (okSamples === 0 && failedSamples === 0) return 'RUNNING'
  if (okSamples === 0) return 'FAILED'
  if (failedSamples === 0) return 'COMPLETED'
  return 'PARTIAL'
}

/**
 * Run 级聚合：各组等权平均（macro）。
 * 跳过 validSamples=0 的组——它们不参与任何平均，但计数仍并入 Run（失败可见）。
 * rank 指标走**池化**而非组中位数的平均，rankBest 名副其实地取全局最小。
 */
export function runAggregate(groups: GroupAgg[]): RunAgg {
  const active = groups.filter((g) => g.validSamples > 0)
  const ranks = active.flatMap((g) => g.ranks)
  const okSamples = groups.reduce((s, g) => s + g.okSamples, 0)
  const failedSamples = groups.reduce((s, g) => s + g.failedSamples, 0)

  return {
    validSamples: groups.reduce((s, g) => s + g.validSamples, 0),
    okSamples,
    failedSamples,
    sovMean: macroMean(active.map((g) => g.sovMean)),
    brandMentionRate: macroMean(active.map((g) => g.brandMentionRate)),
    brandSourceCitationRate: macroMean(active.map((g) => g.brandSourceCitationRate)),
    rankMedian: ranks.length > 0 ? median(ranks) : null,
    rankBest: ranks.length > 0 ? Math.min(...ranks) : null,
    // 各组组内离散度的均值——"平均组内离散度"，不是置信区间
    sovStdDev: macroMean(active.map((g) => g.sovStdDev)),
    status: deriveRunStatus(okSamples, failedSamples),
    ranks,
    groups,
  }
}

/**
 * 期间级聚合：数据点等权平均（macro over 数据点）。
 * 物理 Run 与 legacy 日桶同权参与。
 * **FAILED 排除**：无 OK 样本的点整体不参与——指标与计数都不并入（规格 §3 期间级）。
 * 即只聚合「有 OK 样本」的点，PARTIAL 因此计入。
 */
export function periodAggregate(points: TrendPoint[]): PeriodAgg {
  const included = points.filter((p) => p.validSamples > 0)
  const ranks = included.flatMap((p) => p.ranks)
  return {
    validSamples: included.reduce((s, p) => s + p.validSamples, 0),
    okSamples: included.reduce((s, p) => s + p.okSamples, 0),
    failedSamples: included.reduce((s, p) => s + p.failedSamples, 0),
    sovMean: macroMean(included.map((p) => p.sovMean)),
    brandMentionRate: macroMean(included.map((p) => p.brandMentionRate)),
    brandSourceCitationRate: macroMean(included.map((p) => p.brandSourceCitationRate)),
    rankMedian: ranks.length > 0 ? median(ranks) : null,
    rankBest: ranks.length > 0 ? Math.min(...ranks) : null,
    sovStdDev: macroMean(included.map((p) => p.sovStdDev)),
    ranks,
    pointCount: included.length,
  }
}

/**
 * legacy 事件按 Asia/Shanghai 自然日合成伪 Run（规格 §7）。
 * - 只收 OK 行（FAILED 不进趋势，与 okEventsWhere 一致）
 * - 当日已有物理 Run 时**不**合成该日桶，防止同日双点
 * - 不写物理行，合成 ID 为 `legacy:<YYYY-MM-DD>`
 */
export function bucketLegacyDays(
  events: readonly AggregateEvent[],
  physicalRunDays: readonly string[] | Set<string>,
): SyntheticRun[] {
  const occupied = physicalRunDays instanceof Set ? physicalRunDays : new Set(physicalRunDays)
  const byDay = new Map<string, AggregateEvent[]>()
  for (const e of events) {
    if (!isLegacyEvent(e) || e.status !== 'OK') continue
    const key = dayKey(e.capturedAt)
    const bucket = byDay.get(key)
    if (bucket) bucket.push(e)
    else byDay.set(key, [e])
  }

  return [...byDay.entries()]
    .filter(([day]) => !occupied.has(day))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, dayEvents]) => ({
      id: `legacy:${date}`,
      date,
      startedAt: dayStart(date),
      legacy: true as const,
      events: dayEvents,
      agg: runAggregate([...groupEventsByKey(dayEvents).values()].map(groupAggregate)),
    }))
}

/** 把 Run 级聚合结果装配成趋势点（物理 Run 与 legacy 桶共用，UI 只认 TrendPoint） */
export function toTrendPoint(input: {
  id: string
  startedAt: Date
  sampleCount: number
  status: RunStatus
  slotKey?: string | null
  trigger: RunTrigger
  agg: RunAgg
}): TrendPoint {
  const { agg } = input
  return {
    id: input.id,
    date: dayKey(input.startedAt),
    startedAt: input.startedAt.toISOString(),
    trigger: input.trigger,
    sampleCount: input.sampleCount,
    validSamples: agg.validSamples,
    okSamples: agg.okSamples,
    failedSamples: agg.failedSamples,
    status: input.status,
    slotKey: input.slotKey ?? null,
    legacy: input.trigger === 'LEGACY' || input.id.startsWith('legacy:'),
    sovMean: agg.sovMean,
    brandMentionRate: agg.brandMentionRate,
    brandSourceCitationRate: agg.brandSourceCitationRate,
    sovStdDev: agg.sovStdDev,
    rankMedian: agg.rankMedian,
    rankBest: agg.rankBest,
    ranks: agg.ranks,
  }
}
