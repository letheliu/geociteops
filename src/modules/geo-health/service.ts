import type { Prisma, PrismaClient } from '@prisma/client'
import type { QuerySource } from '@prisma/client'
import { assertPublicHttpUrl, SsrfError } from '../agent-readiness/ssrf.js'
import type { ReadinessGrade } from '../agent-readiness/types.js'
import { publicError, GeoHealthError } from './errors.js'
import { conclude, runPillar, type GeoHealthRunDeps, type PillarBundle } from './orchestrator.js'
import { exportFilename, renderJson, renderMarkdown } from './export.js'
import { emptyProgress, isTerminal, progressPercent } from './score.js'
import type { GeoHealthRunInput } from './run-input.js'
import type {
  GeoHealthCheckDetail,
  GeoHealthCheckSummary,
  GeoHealthProgress,
  GeoHealthReport,
  GeoHealthStartInput,
  GeoHealthStatus,
  HealthLanguage,
  PillarId,
  PillarRunStatus,
} from './types.js'
import { PILLAR_IDS } from './types.js'

export const GEO_HEALTH_QUEUES = {
  dispatch: 'geo-health-dispatch',
  pillar: 'geo-health-pillar',
  finalize: 'geo-health-finalize',
} as const

const EARLY_PILLARS: PillarId[] = ['agentReadiness', 'citations', 'citability']

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

function cleanList(values: string[] | undefined, max: number, itemMax: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of values ?? []) {
    const text = raw.trim()
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text.slice(0, itemMax))
    if (out.length >= max) break
  }
  return out
}

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

export interface GeoHealthService {
  start(workspaceId: string, input: GeoHealthStartInput): Promise<GeoHealthCheckSummary>
  get(workspaceId: string, id: string): Promise<GeoHealthCheckDetail>
  list(workspaceId: string, limit?: number): Promise<GeoHealthCheckSummary[]>
  saveQueries(workspaceId: string, id: string): Promise<{ saved: number; skipped: number }>
  exportReport(workspaceId: string, id: string, format: 'markdown' | 'json'): Promise<{ filename: string; mime: string; content: string }>
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
      const brandName = input.brandName?.trim() ?? ''
      if (!brandName || brandName.length > 80) {
        throw new GeoHealthError('BAD_INPUT', '品牌名需要 1 到 80 个字符')
      }
      const industry = input.industry?.trim() || null
      if (industry && industry.length > 80) {
        throw new GeoHealthError('BAD_INPUT', '行业最长 80 个字符')
      }
      const language = input.language ?? 'auto'
      if (language !== 'zh' && language !== 'en' && language !== 'auto') {
        throw new GeoHealthError('BAD_INPUT', '语言只能是 zh、en 或 auto')
      }
      let siteUrl: string
      try {
        siteUrl = assertPublicHttpUrl(input.siteUrl.trim()).toString()
      } catch (err) {
        if (err instanceof SsrfError) {
          const code = /无效/.test(err.message) ? 'INVALID_URL' : 'SSRF_BLOCKED'
          throw new GeoHealthError(code, err.message)
        }
        throw err
      }

      const row = await db.create({
        data: {
          workspaceId,
          brandName,
          siteUrl,
          industry,
          competitors: cleanList(input.competitors, 8, 80),
          userQueries: cleanList(input.queries, 10, 300),
          language,
          status: 'QUEUED',
          progress: emptyProgress() as unknown as Prisma.InputJsonValue,
        },
      })

      try {
        const jobId = await deps.boss.send(GEO_HEALTH_QUEUES.dispatch, { checkId: row.id }, {
          retryLimit: 2,
          retryDelay: 15,
          expireInSeconds: 120,
        })
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
      return {
        ...toSummary(row as CheckRow),
        industry: row.industry,
        competitors: asStringList(row.competitors),
        userQueries: asStringList(row.userQueries),
        language: asLanguage(row.language),
        progress: asProgress(row.progress),
        report: asReport(row.report),
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
        }
      }
      return {
        filename: exportFilename(report, 'md'),
        mime: 'text/markdown; charset=utf-8',
        content: renderMarkdown(report),
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
      await db.updateMany({
        where: { id: checkId, status: { in: ['QUEUED', 'RUNNING'] } },
        data: {
          status,
          score: report.score,
          grade: report.grade,
          report: report as unknown as Prisma.InputJsonValue,
          error,
          finishedAt: now(),
        },
      })
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
