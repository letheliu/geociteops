import type { Prisma, PrismaClient } from '@prisma/client'
import type { CitationPillar, CitationSample, GeoHealthReport } from './types.js'

export const HEALTH_CHECK_TRIGGER = 'HEALTH_CHECK' as const
export const HEALTH_CHECK_QUERY_SOURCE = 'HEALTH_CHECK' as const

export interface SnapshotEventDraft {
  queryText: string
  queryKind: string
  platform: string
  sampleIndex: number
  status: 'OK' | 'FAILED'
  brandMentioned: boolean
  brandSourceCited: boolean
  rankInAnswer: number | null
  sovScore: number | null
  citedUrls: string[]
  competitors: CitationSample['competitors']
  rawAnswer: string
  failureReason: string | null
  analysis: { source: 'geo-health'; checkId: string }
}

export interface SnapshotPlan {
  slotKey: string
  trigger: typeof HEALTH_CHECK_TRIGGER
  sampleCount: 1
  platforms: string[]
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED'
  completedUnits: number
  failedUnits: number
  events: SnapshotEventDraft[]
}

/**
 * Turn a finished citation pillar into the rows a CitationRun expects.
 * Returns null when the pillar never asked an engine, so a skipped
 * snapshot does not invent a zero on the trend chart.
 */
export function planCitationSnapshot(checkId: string, citations: CitationPillar): SnapshotPlan | null {
  if (citations.samples.length === 0) return null
  const seen = new Map<string, number>()
  const events: SnapshotEventDraft[] = citations.samples.map((sample) => {
    const key = `${sample.query}\u0000${sample.platform}`
    const sampleIndex = (seen.get(key) ?? 0) + 1
    seen.set(key, sampleIndex)
    const ok = sample.ok
    return {
      queryText: sample.query,
      queryKind: citations.queries.find((query) => query.text === sample.query)?.kind ?? 'custom',
      platform: sample.platform,
      sampleIndex,
      status: ok ? 'OK' : 'FAILED',
      brandMentioned: ok ? sample.brandMentioned : false,
      brandSourceCited: ok ? sample.brandCited : false,
      rankInAnswer: ok ? sample.rankInAnswer : null,
      sovScore: ok ? sample.sovScore : null,
      citedUrls: ok ? sample.citedUrls : [],
      competitors: ok ? sample.competitors : [],
      rawAnswer: ok ? `GEO 体检快照（未保留完整回答）：${sample.query}` : '',
      failureReason: ok ? null : sample.error,
      analysis: { source: 'geo-health', checkId },
    }
  })
  const failedUnits = events.filter((event) => event.status === 'FAILED').length
  const completedUnits = events.length - failedUnits
  const status = completedUnits === 0 ? 'FAILED' : failedUnits === 0 ? 'COMPLETED' : 'PARTIAL'
  const platforms = citations.enginesRun.length > 0
    ? citations.enginesRun
    : [...new Set(events.map((event) => event.platform))]
  return {
    slotKey: `health:${checkId}`,
    trigger: HEALTH_CHECK_TRIGGER,
    sampleCount: 1,
    platforms,
    status,
    completedUnits,
    failedUnits,
    events,
  }
}

function isUnique(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002'
}

async function queryIdFor(
  prisma: PrismaClient,
  workspaceId: string,
  event: SnapshotEventDraft,
  checkId: string,
  cache: Map<string, string>,
): Promise<string> {
  const key = event.queryText.trim().toLowerCase()
  const cached = cache.get(key)
  if (cached) return cached
  const existing = await prisma.citationQuery.findMany({
    where: { workspaceId },
    select: { id: true, queryText: true },
  })
  for (const row of existing) {
    cache.set(row.queryText.trim().toLowerCase(), row.id)
  }
  const found = cache.get(key)
  if (found) return found
  const created = await prisma.citationQuery.create({
    data: {
      workspaceId,
      queryText: event.queryText.trim(),
      source: HEALTH_CHECK_QUERY_SOURCE,
      status: 'PAUSED',
      scheduled: false,
      intent: { geoHealthCheckId: checkId, kind: event.queryKind } as Prisma.InputJsonValue,
      intentType: event.queryKind,
      cluster: 'GEO 体检',
      priority: 3,
    },
    select: { id: true },
  })
  cache.set(key, created.id)
  return created.id
}

async function writeEvents(
  prisma: PrismaClient,
  workspaceId: string,
  runId: string,
  checkId: string,
  plan: SnapshotPlan,
  capturedAt: Date,
): Promise<void> {
  const count = await prisma.citationEvent.count({ where: { runId } })
  if (count > 0) return
  const cache = new Map<string, string>()
  const rows = []
  for (const event of plan.events) {
    const queryId = await queryIdFor(prisma, workspaceId, event, checkId, cache)
    rows.push({
      workspaceId,
      queryId,
      platform: event.platform,
      runId,
      sampleIndex: event.sampleIndex,
      status: event.status,
      brandMentioned: event.brandMentioned,
      brandSourceCited: event.brandSourceCited,
      rankInAnswer: event.rankInAnswer,
      sovScore: event.sovScore,
      citedUrls: event.citedUrls as unknown as Prisma.InputJsonValue,
      competitors: event.competitors as unknown as Prisma.InputJsonValue,
      rawAnswer: event.rawAnswer,
      failureReason: event.failureReason,
      analysis: event.analysis as unknown as Prisma.InputJsonValue,
      capturedAt,
    })
  }
  if (rows.length > 0) await prisma.citationEvent.createMany({ data: rows })
}

/**
 * Idempotent write. The slot key `health:<checkId>` is unique, so a finalize
 * retry does not create a second run. Queries that already exist (any status)
 * are reused. New question text is stored paused and unscheduled so the
 * citation cron does not start calling engines for it.
 */
export async function persistCitationSnapshot(
  prisma: PrismaClient,
  input: { workspaceId: string; checkId: string; report: GeoHealthReport; startedAt?: Date },
): Promise<string | null> {
  const plan = planCitationSnapshot(input.checkId, input.report.pillars.citations)
  if (!plan) return null
  const startedAt = input.startedAt ?? new Date(input.report.generatedAt)
  const existing = await prisma.citationRun.findUnique({ where: { slotKey: plan.slotKey }, select: { id: true } })
  if (existing) {
    await writeEvents(prisma, input.workspaceId, existing.id, input.checkId, plan, startedAt)
    return existing.id
  }
  const cache = new Map<string, string>()
  const queryIds = new Map<string, string>()
  for (const event of plan.events) {
    const id = await queryIdFor(prisma, input.workspaceId, event, input.checkId, cache)
    queryIds.set(event.queryText.trim().toLowerCase(), id)
  }
  const querySnapshot = [...queryIds.entries()].map(([text, id]) => {
    const original = plan.events.find((event) => event.queryText.trim().toLowerCase() === text)
    return { id, text: original?.queryText ?? text }
  })
  try {
    const run = await prisma.citationRun.create({
      data: {
        workspaceId: input.workspaceId,
        trigger: HEALTH_CHECK_TRIGGER,
        sampleCount: plan.sampleCount,
        platforms: plan.platforms as unknown as Prisma.InputJsonValue,
        querySnapshot: querySnapshot as unknown as Prisma.InputJsonValue,
        plannedUnits: plan.events.length,
        completedUnits: plan.completedUnits,
        failedUnits: plan.failedUnits,
        status: plan.status,
        slotKey: plan.slotKey,
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 60_000),
      },
      select: { id: true },
    })
    await writeEvents(prisma, input.workspaceId, run.id, input.checkId, plan, startedAt)
    return run.id
  } catch (err) {
    if (!isUnique(err)) throw err
    const winner = await prisma.citationRun.findUnique({ where: { slotKey: plan.slotKey }, select: { id: true } })
    if (!winner) throw err
    await writeEvents(prisma, input.workspaceId, winner.id, input.checkId, plan, startedAt)
    return winner.id
  }
}
