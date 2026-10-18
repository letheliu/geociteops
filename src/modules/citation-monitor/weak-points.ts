import type { PrismaClient } from '@prisma/client'
import {
  groupAggregate,
  groupEventsByKey,
  okEventsWhere,
  type AggregateEvent,
  type GroupAgg,
} from './aggregate.js'
import { dayStart } from './aggregate.js'

/**
 * 薄弱点识别（M2 §3.3 规格 §5）。
 *
 * 口径钉死（与 §5/§7 同源，杜绝"看板一张口径、趋势图另一张"）：
 * - 样本：OK 且 sovScore ≠ null（与品牌指标同一批样本，competitorMentionRates 复用 groupAggregate）
 * - 查询级：query × platform 各组 macro 等权（查询重要性不随采样数变化）
 * - 基线 Run：范围内最近一个「含该查询 + COMPLETED/PARTIAL + 该查询至少一组 validSamples>0」
 *   的 Run，按 finishedAt 排序取最新（与发布事务的基线读同规则）
 * - 命中：brandMentionRate < 0.2 且存在竞品查询级 mentionRate > 0.4
 */

/** 品牌提及率阈值（规格 §11：常量起步） */
export const WEAK_BRAND_MENTION_RATE = 0.2
/** 竞品提及率阈值（规格 §11：常量起步） */
export const WEAK_COMPETITOR_MENTION_RATE = 0.4

export interface WeakPoint {
  queryId: string
  queryText: string
  /** 关联页面 url（可能为 null —— Reports 页据此引导"去映射"） */
  mappedPageUrl: string | null
  /** 命中所用的基线 Run */
  runId: string
  finishedAt: string
  /** 查询级品牌指标（macro over 组） */
  sovMean: number
  brandMentionRate: number
  validSamples: number
  /** 查询级竞品提及率最高者（并列取字典序首个） */
  topCompetitor: string
  topCompetitorMentionRate: number
}

export interface WeakPointsInput {
  workspaceId: string
  fromDay: string
  toDay: string
}

/** 一个 (Run × 查询) 的查询级结果——§5 weakPoints 与 §7 基线/验证共用同一形状 */
export interface QueryLevelAgg {
  runId: string
  queryId: string
  sovMean: number
  brandMentionRate: number
  validSamples: number
  competitorMentionRates: Record<string, number>
}

function macro(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length
}

/**
 * 把某 run 内某查询的各组聚合成查询级结果（macro 等权 + 样本数求和）。
 * 无有效组 → null（调用方跳过该 run，不造 0）。
 */
export function queryLevelAggregate(runId: string, groups: GroupAgg[]): QueryLevelAgg | null {
  const active = groups.filter((g) => g.validSamples > 0)
  if (active.length === 0) return null
  const sovValues = active.map((g) => g.sovMean as number)
  const mentionValues = active.map((g) => g.brandMentionRate as number)

  // 竞品查询级 = 组级竞品率的 macro 等权（某组未提及该竞品计 0，与品牌口径同形）
  const brands = new Set<string>()
  for (const g of active) for (const brand of Object.keys(g.competitorMentionRates)) brands.add(brand)
  const competitorMentionRates: Record<string, number> = {}
  for (const brand of brands) {
    competitorMentionRates[brand] = macro(active.map((g) => g.competitorMentionRates[brand] ?? 0))
  }

  return {
    runId,
    queryId: active[0].queryId,
    sovMean: macro(sovValues),
    brandMentionRate: macro(mentionValues),
    validSamples: active.reduce((s, g) => s + g.validSamples, 0),
    competitorMentionRates,
  }
}

/** topCompetitor：按提及率降序、并列取字典序首个（稳定可预期，不受遍历顺序影响） */
export function pickTopCompetitor(
  competitorMentionRates: Record<string, number>,
  threshold: number = WEAK_COMPETITOR_MENTION_RATE,
): { name: string; rate: number } | null {
  const passed = Object.entries(competitorMentionRates).filter(([, rate]) => rate > threshold)
  if (passed.length === 0) return null
  passed.sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
  return { name: passed[0][0], rate: passed[0][1] }
}

/**
 * 取薄弱点列表。数据通道与趋势读路径**独立**（不省列也不共享 select），
 * 但口径函数全部复用 aggregate.ts——竞品分母与品牌指标同源由 groupAggregate 保证。
 */
export async function loadWeakPoints(prisma: PrismaClient, input: WeakPointsInput): Promise<WeakPoint[]> {
  const { workspaceId, fromDay, toDay } = input
  const from = dayStart(fromDay)
  const toExclusive = new Date(dayStart(toDay).getTime() + 86_400_000)

  const queries = await prisma.citationQuery.findMany({
    where: { workspaceId, status: 'ACTIVE' },
    select: { id: true, queryText: true, mappedPageUrl: true },
  })
  if (queries.length === 0) return []

  // 候选 Run：范围内 + COMPLETED/PARTIAL + 已收尾（finishedAt 排序取最近）
  const runs = await prisma.citationRun.findMany({
    where: {
      workspaceId,
      startedAt: { gte: from, lt: toExclusive },
      status: { in: ['COMPLETED', 'PARTIAL'] },
      finishedAt: { not: null },
    },
    orderBy: { finishedAt: 'desc' },
    select: { id: true, finishedAt: true },
  })
  if (runs.length === 0) return []

  const runIds = runs.map((r) => r.id)
  const events = (await prisma.citationEvent.findMany({
    where: {
      workspaceId,
      runId: { in: runIds },
      // 唯一过滤点：FAILED 行不进任何指标（与趋势同源）
      ...okEventsWhere(),
      queryId: { in: queries.map((q) => q.id) },
    },
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
      competitors: true,
    },
  })) as unknown as AggregateEvent[]

  // (runId × queryId) → 各组 → 查询级聚合
  const byRunQuery = new Map<string, AggregateEvent[]>()
  for (const e of events) {
    const key = `${e.runId}::${e.queryId}`
    const bucket = byRunQuery.get(key)
    if (bucket) bucket.push(e)
    else byRunQuery.set(key, [e])
  }

  const weakPoints: WeakPoint[] = []
  // 已确定基线 Run 的查询：一旦取到"最近的有效 Run"就锁定，
  // 不再回退到更早的 run（否则最近一次表现转好的查询会被旧数据误判为薄弱点）
  const resolved = new Set<string>()

  // runs 已按 finishedAt 降序：首个满足条件的 Run 即"最近一个有效 Run"
  for (const run of runs) {
    for (const query of queries) {
      if (resolved.has(query.id)) continue
      const bucket = byRunQuery.get(`${run.id}::${query.id}`)
      if (!bucket || bucket.length === 0) continue
      const level = queryLevelAggregate(run.id, [...groupEventsByKey(bucket).values()].map(groupAggregate))
      // 该查询在本次 run 至少一组 validSamples>0 才算有效基线；否则继续往更早的 run 找
      if (!level) continue
      resolved.add(query.id)

      // 阈值判定针对**这一个**最近有效 Run，不因不命中而改用更早的 Run
      if (level.brandMentionRate >= WEAK_BRAND_MENTION_RATE) continue
      const top = pickTopCompetitor(level.competitorMentionRates)
      if (!top) continue

      weakPoints.push({
        queryId: query.id,
        queryText: query.queryText,
        mappedPageUrl: query.mappedPageUrl ?? null,
        runId: run.id,
        finishedAt: run.finishedAt!.toISOString(),
        sovMean: level.sovMean,
        brandMentionRate: level.brandMentionRate,
        validSamples: level.validSamples,
        topCompetitor: top.name,
        topCompetitorMentionRate: top.rate,
      })
    }
    if (resolved.size === queries.length) break
  }

  return weakPoints
}
