import type { Prisma, PrismaClient } from '@prisma/client'
import type { QuerySource } from '@prisma/client'
import { dayKey } from '../citation-monitor/aggregate.js'
import type { ReadinessGrade } from '../agent-readiness/types.js'
import { publicError, GeoHealthError } from './errors.js'
import { diffReports } from './diff.js'
import { conclude, runPillar, type GeoHealthRunDeps, type PillarBundle } from './orchestrator.js'
import { exportFilename, renderJson, renderMarkdown } from './export.js'
import { renderHealthPdf } from './pdf.js'
import { emptyProgress, isTerminal, progressPercent } from './score.js'
import { prepareHealthFields, type GeoHealthRunInput } from './run-input.js'
import { createScheduleRunner, type ScheduleRunner } from './schedule.js'
import { persistCitationSnapshot } from './snapshot.js'
import type {
  GeoHealthCheckDetail,
  GeoHealthCheckSummary,
  GeoHealthProgress,
  GeoHealthReport,
  GeoHealthStartInput,
  GeoHealthStatus,
  GeoHealthTrigger,
  GeoScorePoint,
  HealthLanguage,
  PillarId,
  PillarRunStatus,
} from './types.js'
import { PILLAR_IDS } from './types.js'

export const GEO_HEALTH_QUEUES = {
  dispatch: 'geo-health-dispatch',
  pillar: 'geo-health-pillar',
  finalize: 'geo-health-finalize',
  /** One tick a minute. It only starts schedules whose nextRunAt has passed. */
  schedule: 'geo-health-schedule',
} as const

export const GEO_HEALTH_TICK_CRON = '* * * * *'
export const GEO_HEALTH_TICK_TZ = 'Asia/Shanghai'

const EARLY_PILLARS: PillarId[] = ['agentReadiness', 'citations', 'citability']
const DISPATCH_SEND = { retryLimit: 2, retryDelay: 15, expireInSeconds: 120 }

export interface GeoHealthDispatchJob {
  checkId: string
}

export interface GeoHealthPillarJob {
  checkId: string
  pillar: PillarId
}

export interface GeoHealthQueue {
  send(
    name: string,
    data: GeoHealthDispatchJob | GeoHealthPillarJob,
    options?: { retryLimit?: number; retryDelay?: number; expireInSeconds?: number; singletonKey?: string },
  ): Promise<string | null>
}

export interface GeoHealthQueryLibrary {
  listActive(workspaceId: string): Promise<{ queryText: string }[]>
  addQuery(input: {
    workspaceId: string
    queryText: string
    source: QuerySource
    intent?: Record<string, unknown>
    intentType?: string
    cluster?: string
    priority?: number
  }): Promise<unknown>
}

const GRADES = new Set<ReadinessGrade>(['A', 'B', 'C', 'D', 'F'])
const CHECK_DONE = new Set<GeoHealthStatus>(['SUCCEEDED', 'PARTIAL', 'FAILED'])
const PILLAR_OPTS = { retryLimit: 1, retryDelay: 20, expireInSeconds: 900 }
const FINALIZE_OPTS = { retryLimit: 2, retryDelay: 10, expireInSeconds: 120 }

function asGrade(value: string | null): ReadinessGrade | null {
  if (value && GRADES.has(value as ReadinessGrade)) return value as ReadinessGrade
  return null
}

function asLanguage(value: string): HealthLanguage {
  if (value === 'zh' || value === 'en' || value === 'auto') return value
  return 'auto'
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function asProgress(value: unknown): GeoHealthProgress {
  if (!value || typeof value !== 'object') return emptyProgress()
  const progress = value as GeoHealthProgress
  if (!progress.pillars?.agentReadiness || !progress.pillars?.citations || !progress.pillars?.citability || !progress.pillars?.structuredSignals) {
    return emptyProgress()
  }
  return progress
}

function asResults(value: unknown): Partial<PillarBundle> {
  if (!value || typeof value !== 'object') return {}
  return value as Partial<PillarBundle>
}

function asReport(value: unknown): GeoHealthReport | null {
  if (!value || typeof value !== 'object') return null
  if ((value as { version?: unknown }).version !== GEO_REPORT_VERSION) return null
  return value as GeoHealthReport
}

const GEO_REPORT_VERSION = 1

type CheckRow = {
  id: string
  workspaceId: string
  brandName: string
  siteUrl: string
  industry: string | null
  competitors: unknown
  userQueries: unknown
  language: string
  status: string
  score: number | null
  grade: string | null
  progress: unknown
  pillarResults: unknown
  report: unknown
  error: string | null
  trigger?: string | null
  scheduleId?: string | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}

function toSummary(row: CheckRow): GeoHealthCheckSummary {
  return {
    id: row.id,
    brandName: row.brandName,
    siteUrl: row.siteUrl,
    status: row.status as GeoHealthStatus,
    trigger: row.trigger === 'SCHEDULED' ? 'SCHEDULED' : 'MANUAL',
    score: row.score,
    grade: asGrade(row.grade),
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  }
}

function inputFromRow(row: CheckRow): GeoHealthRunInput {
  return {
    workspaceId: row.workspaceId,
    brandName: row.brandName,
    siteUrl: row.siteUrl,
    industry: row.industry,
    competitors: asStringList(row.competitors),
    userQueries: asStringList(row.userQueries),
    language: asLanguage(row.language),
  }
}

export interface GeoHealthExportFile {
  filename: string
  mime: string
  content: string
  encoding: 'utf8' | 'base64'
}

export interface GeoHealthService {
  start(workspaceId: string, input: GeoHealthStartInput): Promise<GeoHealthCheckSummary>
  get(workspaceId: string, id: string): Promise<GeoHealthCheckDetail>
  list(workspaceId: string, limit?: number): Promise<GeoHealthCheckSummary[]>
  trend(workspaceId: string, limit?: number): Promise<{ points: GeoScorePoint[] }>
  saveQueries(workspaceId: string, id: string): Promise<{ saved: number; skipped: number }>
  exportReport(workspaceId: string, id: string, format: 'markdown' | 'json' | 'pdf'): Promise<GeoHealthExportFile>
  listSchedules: ScheduleRunner['list']
  saveSchedule: ScheduleRunner['save']
  setScheduleEnabled: ScheduleRunner['setEnabled']
  removeSchedule: ScheduleRunner['remove']
  runDueSchedules: ScheduleRunner['runDue']
  dispatch(checkId: string): Promise<void>
  runPillarJob(checkId: string, pillar: PillarId): Promise<void>
  finalize(checkId: string): Promise<void>
}

export function createGeoHealthService(deps: {
  prisma: PrismaClient
  boss: GeoHealthQueue
  queryLibrary: GeoHealthQueryLibrary
  pillarDeps: GeoHealthRunDeps
  runPillar?: typeof runPillar
  now?: () => Date
}): GeoHealthService {
  const db = deps.prisma.geoHealthCheck
  const now = deps.now ?? (() => new Date())
  const execute = deps.runPillar ?? runPillar
  const schedules = createScheduleRunner({
    prisma: deps.prisma,
    now,
    enqueue: (checkId) => deps.boss.send(GEO_HEALTH_QUEUES.dispatch, { checkId }, DISPATCH_SEND),
  })

  async function markFailed(id: string, message: string): Promise<void> {
    await db.update({
      where: { id },
      data: { status: 'FAILED', error: message.slice(0, 500), finishedAt: new Date() },
    })
  }

  async function patchPillar(
    checkId: string,
    pillar: PillarId,
    patch: { status: PillarRunStatus; error: string | null; startedAt: string | null; finishedAt: string | null },
    result?: PillarBundle[PillarId],
  ): Promise<{ allTerminal: boolean; enqueueSignals: boolean }> {
    return deps.prisma.$transaction(async (tx) => {
      const row = await tx.geoHealthCheck.findUnique({ where: { id: checkId } })
      if (!row || CHECK_DONE.has(row.status as GeoHealthStatus)) {
        return { allTerminal: false, enqueueSignals: false }
      }
      const progress = asProgress(row.progress)
      if (isTerminal(progress.pillars[pillar].status)) {
        return { allTerminal: false, enqueueSignals: false }
      }
      progress.pillars[pillar] = {
        status: patch.status,
        error: patch.error,
        startedAt: patch.startedAt ?? progress.pillars[pillar].startedAt,
        finishedAt: patch.finishedAt,
      }
      progress.percent = progressPercent(progress)
      const results = asResults(row.pillarResults)
      if (result) (results as Record<string, unknown>)[pillar] = result
      const enqueueSignals = pillar === 'agentReadiness'
        && !!result
        && progress.pillars.structuredSignals.status === 'PENDING'
      const allTerminal = PILLAR_IDS.every((id) => isTerminal(progress.pillars[id].status))
      await tx.geoHealthCheck.update({
        where: { id: checkId },
        data: {
          status: 'RUNNING',
          progress: progress as unknown as Prisma.InputJsonValue,
          pillarResults: results as unknown as Prisma.InputJsonValue,
        },
      })
      return { allTerminal, enqueueSignals }
    })
  }

  async function enqueue(data: GeoHealthPillarJob) {
    return deps.boss.send(GEO_HEALTH_QUEUES.pillar, data, PILLAR_OPTS)
  }

  return {
    async start(workspaceId, input) {
      const prepared = prepareHealthFields(input)
      const row = await db.create({
        data: {
          workspaceId,
          brandName: prepared.brandName,
          siteUrl: prepared.siteUrl,
          industry: prepared.industry,
          competitors: prepared.competitors,
          userQueries: prepared.userQueries,
          language: prepared.language,
          status: 'QUEUED',
          trigger: 'MANUAL',
          progress: emptyProgress() as unknown as Prisma.InputJsonValue,
        },
      })

      try {
        const jobId = await deps.boss.send(GEO_HEALTH_QUEUES.dispatch, { checkId: row.id }, DISPATCH_SEND)
        if (!jobId) {
          await markFailed(row.id, '任务队列没有接受体检任务')
          throw new GeoHealthError('QUEUE_UNAVAILABLE', '任务队列没有接受体检任务')
        }
      } catch (err) {
        if (err instanceof GeoHealthError) throw err
        await markFailed(row.id, '任务队列不可用')
        throw new GeoHealthError('QUEUE_UNAVAILABLE', '任务队列不可用')
      }

      return toSummary(row as CheckRow)
    },

    async get(workspaceId, id) {
      const row = await db.findFirst({ where: { id, workspaceId } })
      if (!row) throw new GeoHealthError('NOT_FOUND', '体检记录不存在')
      const report = asReport(row.report)
      const diff = report ? await previousDiff(deps.prisma, row as CheckRow, report) : null
      return {
        ...toSummary(row as CheckRow),
        industry: row.industry,
        competitors: asStringList(row.competitors),
        userQueries: asStringList(row.userQueries),
        language: asLanguage(row.language),
        progress: asProgress(row.progress),
        report,
        diff,
      }
    },

    async list(workspaceId, limit = 20) {
      const take = Math.min(Math.max(limit, 1), 50)
      const rows = await db.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take,
      })
      return rows.map((row) => toSummary(row as CheckRow))
    },

    async saveQueries(workspaceId, id) {
      const row = await db.findFirst({ where: { id, workspaceId } })
      if (!row) throw new GeoHealthError('NOT_FOUND', '体检记录不存在')
      const report = asReport(row.report)
      if (!report) throw new GeoHealthError('NOT_READY', '体检还没有报告，不能保存问题')
      const existing = await deps.queryLibrary.listActive(workspaceId)
      const seen = new Set(existing.map((query) => query.queryText.trim().toLowerCase()))
      let saved = 0
      let skipped = 0
      for (const query of report.pillars.citations.queries) {
        const key = query.text.trim().toLowerCase()
        if (!key || seen.has(key)) {
          skipped += 1
          continue
        }
        seen.add(key)
        await deps.queryLibrary.addQuery({
          workspaceId,
          queryText: query.text,
          source: query.source === 'user' ? 'MANUAL' : 'LLM_GENERATED',
          intent: {
            geoHealthCheckId: id,
            kind: query.kind,
            language: query.language,
            generator: query.source,
          },
          intentType: query.kind,
          cluster: query.kind,
          priority: query.kind === 'brand' ? 1 : query.kind === 'comparison' ? 2 : 3,
        })
        saved += 1
      }
      return { saved, skipped }
    },

    async trend(workspaceId, limit = 30) {
      const take = Math.min(Math.max(limit, 1), 100)
      const rows = await db.findMany({
        where: { workspaceId, status: { in: ['SUCCEEDED', 'PARTIAL'] } },
        orderBy: { createdAt: 'desc' },
        take,
      })
      const points = rows
        .map((row) => toScorePoint(row as CheckRow))
        .filter((point): point is GeoScorePoint => point !== null)
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
      return { points }
    },

    async exportReport(workspaceId, id, format) {
      const row = await db.findFirst({ where: { id, workspaceId } })
      if (!row) throw new GeoHealthError('NOT_FOUND', '体检记录不存在')
      const report = asReport(row.report)
      if (!report) throw new GeoHealthError('NOT_READY', '体检还没有报告')
      if (format === 'json') {
        return {
          filename: exportFilename(report, 'json'),
          mime: 'application/json; charset=utf-8',
          content: renderJson(report),
          encoding: 'utf8' as const,
        }
      }
      if (format === 'pdf') {
        const bytes = await renderHealthPdf(report)
        return {
          filename: exportFilename(report, 'pdf'),
          mime: 'application/pdf',
          content: bytes.toString('base64'),
          encoding: 'base64' as const,
        }
      }
      return {
        filename: exportFilename(report, 'md'),
        mime: 'text/markdown; charset=utf-8',
        content: renderMarkdown(report),
        encoding: 'utf8' as const,
      }
    },

    async dispatch(checkId) {
      const row = await db.findUnique({ where: { id: checkId } })
      if (!row || CHECK_DONE.has(row.status as GeoHealthStatus)) return
      const progress = asProgress(row.progress)
      await db.update({
        where: { id: checkId },
        data: { status: 'RUNNING', startedAt: row.startedAt ?? now() },
      })
      for (const pillar of EARLY_PILLARS) {
        if (progress.pillars[pillar].status !== 'PENDING') continue
        const jobId = await enqueue({ checkId, pillar })
        if (!jobId) {
          await patchPillar(checkId, pillar, {
            status: 'FAILED',
            error: '任务队列没有接受这一支柱',
            startedAt: now().toISOString(),
            finishedAt: now().toISOString(),
          }, failedResult(pillar))
        }
      }
      const latest = await db.findUnique({ where: { id: checkId } })
      const latestProgress = asProgress(latest?.progress)
      if (isTerminal(latestProgress.pillars.agentReadiness.status) && latestProgress.pillars.structuredSignals.status === 'PENDING') {
        const jobId = await enqueue({ checkId, pillar: 'structuredSignals' })
        if (!jobId) {
          await patchPillar(checkId, 'structuredSignals', {
            status: 'FAILED',
            error: '任务队列没有接受结构化信号',
            startedAt: now().toISOString(),
            finishedAt: now().toISOString(),
          }, failedResult('structuredSignals'))
        }
      }
      const done = await db.findUnique({ where: { id: checkId } })
      const doneProgress = asProgress(done?.progress)
      if (done && !CHECK_DONE.has(done.status as GeoHealthStatus) && PILLAR_IDS.every((id) => isTerminal(doneProgress.pillars[id].status))) {
        await deps.boss.send(GEO_HEALTH_QUEUES.finalize, { checkId }, { ...FINALIZE_OPTS, singletonKey: checkId })
      }
    },

    async runPillarJob(checkId, pillar) {
      if (!PILLAR_IDS.includes(pillar)) return
      const row = await db.findUnique({ where: { id: checkId } })
      if (!row || CHECK_DONE.has(row.status as GeoHealthStatus)) return
      const progress = asProgress(row.progress)
      if (isTerminal(progress.pillars[pillar].status)) return

      const startedAt = progress.pillars[pillar].startedAt ?? now().toISOString()
      await patchPillar(checkId, pillar, { status: 'RUNNING', error: null, startedAt, finishedAt: null })

      const current = await db.findUnique({ where: { id: checkId } })
      if (!current) return
      const readinessReport = asResults(current.pillarResults).agentReadiness?.report ?? null
      let payload: PillarBundle[PillarId]
      try {
        payload = await execute(pillar, inputFromRow(current as CheckRow), readinessReport, deps.pillarDeps) as PillarBundle[PillarId]
      } catch (err) {
        payload = failedResult(pillar, publicError(err))
      }
      const finishedAt = now().toISOString()
      const written = await patchPillar(checkId, pillar, {
        status: payload.status,
        error: 'error' in payload ? payload.error : null,
        startedAt,
        finishedAt,
      }, payload)
      if (written.enqueueSignals) {
        const jobId = await enqueue({ checkId, pillar: 'structuredSignals' })
        if (!jobId) {
          await patchPillar(checkId, 'structuredSignals', {
            status: 'FAILED',
            error: '任务队列没有接受结构化信号',
            startedAt: finishedAt,
            finishedAt,
          }, failedResult('structuredSignals'))
        }
      }
      const after = await db.findUnique({ where: { id: checkId } })
      const afterProgress = asProgress(after?.progress)
      if (PILLAR_IDS.every((id) => isTerminal(afterProgress.pillars[id].status))) {
        await deps.boss.send(GEO_HEALTH_QUEUES.finalize, { checkId }, { ...FINALIZE_OPTS, singletonKey: checkId })
      }
    },

    async finalize(checkId) {
      const row = await db.findUnique({ where: { id: checkId } })
      if (!row || CHECK_DONE.has(row.status as GeoHealthStatus)) return
      const { status, report } = conclude(inputFromRow(row as CheckRow), asResults(row.pillarResults), now())
      const error = status === 'FAILED'
        ? [report.pillars.agentReadiness.error, report.pillars.citations.error, report.pillars.citability.error, report.pillars.structuredSignals.error]
          .filter((item): item is string => !!item)
          .join('；')
          .slice(0, 500)
        : null
      let citationRunId: string | null = null
      if (status !== 'FAILED') {
        try {
          citationRunId = await persistCitationSnapshot(deps.prisma, {
            workspaceId: row.workspaceId,
            checkId,
            report,
            startedAt: now(),
          })
        } catch (err) {
          console.error(`[geo-health] citation snapshot failed check=${checkId}:`, err)
        }
      }
      const written = await db.updateMany({
        where: { id: checkId, status: { in: ['QUEUED', 'RUNNING'] } },
        data: {
          status,
          score: report.score,
          grade: report.grade,
          report: report as unknown as Prisma.InputJsonValue,
          error,
          finishedAt: now(),
          ...(citationRunId ? { citationRunId } : {}),
        },
      })
      if (written.count === 0) return
      if (row.scheduleId) {
        await deps.prisma.geoHealthSchedule.updateMany({
          where: { id: row.scheduleId, runningCheckId: checkId },
          data: { runningCheckId: null, lastStatus: status, lastCheckId: checkId },
        })
      }
    },

    listSchedules: schedules.list,
    saveSchedule: schedules.save,
    setScheduleEnabled: schedules.setEnabled,
    removeSchedule: schedules.remove,
    runDueSchedules: schedules.runDue,
  }
}

async function previousDiff(prisma: PrismaClient, row: CheckRow, report: GeoHealthReport) {
  const rows = await prisma.geoHealthCheck.findMany({
    where: {
      workspaceId: row.workspaceId,
      brandName: row.brandName,
      siteUrl: row.siteUrl,
      status: { in: ['SUCCEEDED', 'PARTIAL'] },
      createdAt: { lt: row.createdAt },
    },
    orderBy: { createdAt: 'desc' },
    take: 8,
  })
  const previous = [...rows]
    .filter((candidate) => candidate.id !== row.id)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((candidate) => ({ candidate, report: asReport(candidate.report) }))
    .find((item) => item.report)
  if (!previous?.report) return null
  const at = previous.candidate.finishedAt ?? previous.candidate.createdAt
  return {
    ...diffReports(previous.report, report),
    previousId: previous.candidate.id,
    previousAt: at.toISOString(),
  }
}

function toScorePoint(row: CheckRow): GeoScorePoint | null {
  const report = asReport(row.report)
  if (!report || row.score == null) return null
  if (row.status !== 'SUCCEEDED' && row.status !== 'PARTIAL') return null
  const at = row.finishedAt ?? row.createdAt
  const trigger: GeoHealthTrigger = row.trigger === 'SCHEDULED' ? 'SCHEDULED' : 'MANUAL'
  return {
    id: row.id,
    at: at.toISOString(),
    date: dayKey(at),
    score: report.score,
    grade: report.grade,
    brandName: row.brandName,
    trigger,
    pillars: {
      agentReadiness: report.pillars.agentReadiness.score,
      citations: report.pillars.citations.score,
      citability: report.pillars.citability.score,
      structuredSignals: report.pillars.structuredSignals.score,
    },
  }
}

function failedResult(pillar: PillarId, error = '任务队列没有接受这一支柱'): PillarBundle[PillarId] {
  if (pillar === 'agentReadiness') return { status: 'FAILED', score: null, report: null, error }
  if (pillar === 'citations') {
    return {
      status: 'FAILED',
      score: null,
      queries: [],
      querySource: 'template',
      enginesRun: [],
      enginesSkipped: [],
      mentionRate: null,
      citationRate: null,
      meanRank: null,
      shareOfVoice: null,
      citedUrls: [],
      brandCitedUrls: [],
      competitorSov: [],
      samples: [],
      note: null,
      error,
    }
  }
  if (pillar === 'citability') return { status: 'FAILED', score: null, pages: [], weakestPages: [], note: null, error }
  return {
    status: 'FAILED',
    score: null,
    schemaTypes: [],
    jsonLdPresent: false,
    llmsTxtStatus: 'unknown',
    llmsFullStatus: 'unknown',
    generatedLlmsTxt: '',
    generatedJsonLd: '',
    note: null,
    error,
  }
}
