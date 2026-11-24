import { createHash } from 'node:crypto'
import type { GeoApi } from './api-types.js'
import { htmlToText } from './html.js'
import {
  auditUrl,
  buildLlmsTxt,
  buildSchema,
  fetchPublic,
  llmsTarget,
  schemaError,
  ssrfMessage,
  validateLlmsText,
  type FetchedPage,
} from './local.js'
import { pollUntil, type Clocks } from './poll.js'
import { asNumber, asRecord, asString, errorMessage, fail, isToolOutput, ok, type ToolOutput } from './result.js'
import type { AgentReadinessReport } from '../../src/modules/agent-readiness/types.js'

const DEFAULT_WAIT_MS = 45_000
const MAX_WAIT_MS = 180_000
const HEALTH_DONE = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED'])
const READINESS_DONE = new Set(['SUCCEEDED', 'FAILED'])
const RUN_DONE = new Set(['COMPLETED', 'PARTIAL', 'FAILED'])
const REMOTE_SCHEMA = new Set([
  'SoftwareApplication',
  'Organization',
  'Product',
  'FAQPage',
  'Article',
  'BreadcrumbList',
])

export interface HandlerDeps {
  api: GeoApi | null
  preferLocal: boolean
  clocks?: Clocks
  signal?: AbortSignal
  onProgress?: (progress: number, total: number, message: string) => Promise<void>
  /** DEMO_MODE or a read-only deployment. Handlers must not persist. */
  readOnly?: boolean
  /** False when the HTTP token lacks run-checks. stdio leaves this true. */
  allowWrite?: boolean
  runAudit?: (url: string) => Promise<AgentReadinessReport>
  fetchUrl?: (url: string) => Promise<FetchedPage>
}

export interface GeoHealthInput {
  brandName: string
  siteUrl: string
  industry?: string
  competitors?: string[]
  queries?: string[]
  language?: 'zh' | 'en' | 'auto'
  waitMs?: number
}

export interface ReportInput {
  id: string
  format?: 'markdown' | 'json'
}

export interface ReadinessInput {
  url: string
  waitMs?: number
}

export interface QueryItem {
  queryText: string
  source?: 'manual' | 'google_suggest' | 'llm_generated' | 'paa' | 'competitor'
  pageId?: string
  intent?: Record<string, unknown>
}

export interface AddQueriesInput {
  queries: QueryItem[]
}

export interface CitationInput {
  query?: string
  queryId?: string
  platforms?: string[]
  sampleCount?: number
  waitMs?: number
}

export interface SovToolInput {
  competitors?: string[]
  start?: string
  end?: string
  platform?: string
}

export interface OptimizeToolInput {
  url?: string
  text?: string
  pageId?: string
  pageType?: string
}

export interface SchemaToolInput {
  schemaType: string
  fields: Record<string, unknown>
  pageUrl?: string
}

export interface LlmsSectionInput {
  title: string
  items: Array<{ label: string; url: string; description: string }>
}

export interface LlmsToolInput {
  brandName?: string
  tagline?: string
  sections?: LlmsSectionInput[]
  updateFrequency?: { docs?: string; blog?: string }
  pageUrl?: string
  text?: string
  url?: string
}

export interface KgToolInput {
  pageId?: string
  url?: string
  text?: string
  pageType?: string
}

function needApi(deps: HandlerDeps): GeoApi | ToolOutput {
  if (!deps.api) {
    return fail(
      'This tool needs a GeoCiteOps server. Set GEOCITEOPS_API_URL and GEOCITEOPS_API_KEY. Agent readiness, llms.txt, and JSON-LD work with no key.',
      { code: 'API_KEY_REQUIRED' },
    )
  }
  return deps.api
}

function localSignals(deps: HandlerDeps): boolean {
  return deps.preferLocal || deps.api == null || deps.readOnly === true || deps.allowWrite === false
}

function waitMs(value: number | undefined): number {
  if (value == null) return DEFAULT_WAIT_MS
  return Math.min(MAX_WAIT_MS, Math.max(0, Math.trunc(value)))
}

async function progress(deps: HandlerDeps, value: number, message: string): Promise<void> {
  await deps.onProgress?.(value, 100, message)
}

function textOf(value: unknown, key: string): string | null {
  const record = asRecord(value)
  if (!record) return null
  const nested = asRecord(record[key])
  return asString(nested?.en) ?? asString(record[key])
}

function healthView(raw: unknown): Record<string, unknown> | null {
  const row = asRecord(raw)
  if (!row || typeof row.id !== 'string' || typeof row.status !== 'string') return null
  return row
}

function pillarScore(report: Record<string, unknown> | null, id: string): number | null {
  const pillars = asRecord(report?.pillars)
  return asNumber(asRecord(pillars?.[id])?.score)
}

function compactHealth(row: Record<string, unknown>, timedOut: boolean) {
  const report = asRecord(row.report)
  const actions = Array.isArray(report?.actions) ? report.actions.slice(0, 8).map((item) => {
    const action = asRecord(item) ?? {}
    return {
      impact: action.impact ?? null,
      title: textOf(action, 'title'),
      fix: textOf(action, 'fix'),
    }
  }) : []
  const citations = asRecord(asRecord(report?.pillars)?.citations)
  const samples = Array.isArray(citations?.samples) ? citations.samples.length : 0
  return {
    mode: 'remote' as const,
    id: row.id,
    status: row.status,
    timedOut,
    score: asNumber(report?.score) ?? asNumber(row.score),
    grade: asString(report?.grade) ?? asString(row.grade),
    summary: textOf(report ?? {}, 'summary'),
    progress: asNumber(asRecord(row.progress)?.percent),
    pillars: report ? {
      agentReadiness: pillarScore(report, 'agentReadiness'),
      citations: pillarScore(report, 'citations'),
      citability: pillarScore(report, 'citability'),
      structuredSignals: pillarScore(report, 'structuredSignals'),
    } : null,
    actions,
    citationSampleCount: samples,
    error: asString(row.error),
    followUp: timedOut || !HEALTH_DONE.has(String(row.status))
      ? { tool: 'get_geo_health_report', id: row.id }
      : null,
  }
}

function healthSummary(view: ReturnType<typeof compactHealth>): string {
  if (!view.score && view.score !== 0) {
    return `GEO health check ${view.status}${view.progress != null ? ` (${view.progress}%)` : ''}. Job id: ${String(view.id)}. ${view.timedOut ? 'The wait ended before the report was ready. ' : ''}Fetch it with get_geo_health_report.`
  }
  const lines = [
    `GEO health ${view.score}/100 (${view.grade ?? 'n/a'}) — ${view.summary ?? ''}`.trim(),
    view.pillars
      ? `Pillars: readiness ${view.pillars.agentReadiness ?? 'n/a'}, citations ${view.pillars.citations ?? 'n/a'}, citability ${view.pillars.citability ?? 'n/a'}, signals ${view.pillars.structuredSignals ?? 'n/a'}`
      : '',
    view.actions.length
      ? `Top actions:\n${view.actions.map((action, index) => `${index + 1}. [${String(action.impact)}] ${action.title ?? ''} — ${action.fix ?? ''}`).join('\n')}`
      : 'No actions.',
    `Job id: ${String(view.id)}`,
  ]
  return lines.filter(Boolean).join('\n')
}

export async function runGeoHealthCheck(input: GeoHealthInput, deps: HandlerDeps): Promise<ToolOutput> {
  const api = needApi(deps)
  if (isToolOutput(api)) return api
  await progress(deps, 1, 'Starting GEO health check')
  let started: unknown
  try {
    started = await api.geoHealth.start.mutate({
      brandName: input.brandName,
      siteUrl: input.siteUrl,
      industry: input.industry,
      competitors: input.competitors,
      queries: input.queries,
      language: input.language,
    })
  } catch (err) {
    return fail(errorMessage(err), { code: 'API_ERROR' })
  }
  const row = healthView(started)
  if (!row) return fail('GEO health check returned an unexpected payload.', { code: 'API_ERROR' })
  let polled: { value: Record<string, unknown>; timedOut: boolean }
  try {
    polled = await pollUntil({
      timeoutMs: waitMs(input.waitMs),
      clocks: deps.clocks,
      signal: deps.signal,
      isDone: (value) => HEALTH_DONE.has(String(value.status)),
      fetch: async () => {
        const next = healthView(await api.geoHealth.get.query({ id: String(row.id) }))
        if (!next) throw new Error('GEO health check returned an unexpected payload.')
        return next
      },
      onTick: async (value) => {
        const percent = asNumber(asRecord(value.progress)?.percent) ?? (value.status === 'QUEUED' ? 5 : 40)
        await progress(deps, percent, `GEO health ${String(value.status)}`)
      },
    })
  } catch (err) {
    return fail(errorMessage(err), {
      code: 'API_ERROR',
      id: row.id,
      followUp: { tool: 'get_geo_health_report', id: row.id },
    })
  }
  const view = compactHealth(polled.value, polled.timedOut)
  if (view.status === 'FAILED') return fail(view.error ?? 'GEO health check failed.', view)
  return ok(healthSummary(view), view)
}

export async function getGeoHealthReport(input: ReportInput, deps: HandlerDeps): Promise<ToolOutput> {
  const api = needApi(deps)
  if (isToolOutput(api)) return api
  try {
    if (input.format) {
      const exported = asRecord(await api.geoHealth.export.query({ id: input.id, format: input.format }))
      const content = asString(exported?.content)
      if (!exported || content == null) return fail('GEO health export was empty.', { code: 'API_ERROR', id: input.id })
      const clipped = content.length > 8_000 ? `${content.slice(0, 8_000)}\n…(truncated)` : content
      return ok(`GEO health report ${input.id} (${input.format}).\n\n${clipped}`, {
        id: input.id,
        format: input.format,
        filename: exported.filename ?? null,
        mime: exported.mime ?? null,
        content,
      })
    }
    const row = healthView(await api.geoHealth.get.query({ id: input.id }))
    if (!row) return fail('GEO health report returned an unexpected payload.', { code: 'API_ERROR' })
    const view = compactHealth(row, false)
    return ok(healthSummary(view), view)
  } catch (err) {
    return fail(errorMessage(err), { code: 'API_ERROR', id: input.id })
  }
}

function compactReadiness(report: AgentReadinessReport, extra: Record<string, unknown>) {
  const fixes = report.fixes.slice(0, 8).map((fix) => ({
    checkId: fix.checkId,
    impact: fix.impact,
    title: fix.title.en,
    fix: fix.fix.en,
    verify: fix.verify.en,
  }))
  return {
    ...extra,
    url: report.url,
    finalUrl: report.finalUrl,
    score: report.score,
    grade: report.grade,
    summary: report.summary.en,
    categories: report.categories.map((category) => ({
      id: category.id,
      score: category.score,
      status: category.status,
    })),
    fixes,
    checkCount: report.checks.length,
  }
}

function readinessSummary(data: { score: number; grade: string; summary: string; fixes: Array<{ title: string; fix: string }>; url: string }): string {
  const lines = [
    `Agent readiness ${data.score}/100 (${data.grade}) for ${data.url}`,
    data.summary,
    data.fixes.length
      ? `Top fixes:\n${data.fixes.map((fix, index) => `${index + 1}. ${fix.title} — ${fix.fix}`).join('\n')}`
      : 'No fixes. The applicable checks passed.',
  ]
  return lines.join('\n')
}

export async function runAgentReadinessAuditTool(input: ReadinessInput, deps: HandlerDeps): Promise<ToolOutput> {
  if (localSignals(deps)) {
    await progress(deps, 5, 'Auditing in-process')
    try {
      const report = await (deps.runAudit ?? auditUrl)(input.url)
      await progress(deps, 100, 'Audit finished')
      const data = compactReadiness(report, { mode: 'local', persisted: false })
      return ok(readinessSummary(data), data)
    } catch (err) {
      return fail(ssrfMessage(err) ?? errorMessage(err), { code: 'AUDIT_FAILED', url: input.url })
    }
  }
  const api = needApi(deps)
  if (isToolOutput(api)) return api
  await progress(deps, 1, 'Queueing agent readiness audit')
  let started: unknown
  try {
    started = await api.agentReadiness.start.mutate({ url: input.url })
  } catch (err) {
    return fail(errorMessage(err), { code: 'API_ERROR' })
  }
  const row = healthView(started)
  if (!row) return fail('Agent readiness audit returned an unexpected payload.', { code: 'API_ERROR' })
  let polled: { value: Record<string, unknown>; timedOut: boolean }
  try {
    polled = await pollUntil({
      timeoutMs: waitMs(input.waitMs),
      clocks: deps.clocks,
      signal: deps.signal,
      isDone: (value) => READINESS_DONE.has(String(value.status)),
      fetch: async () => {
        const next = healthView(await api.agentReadiness.get.query({ id: String(row.id) }))
        if (!next) throw new Error('Agent readiness audit returned an unexpected payload.')
        return next
      },
      onTick: async (value) => {
        await progress(deps, value.status === 'QUEUED' ? 10 : 60, `Agent readiness ${String(value.status)}`)
      },
    })
  } catch (err) {
    return fail(errorMessage(err), {
      code: 'API_ERROR',
      id: row.id,
      followUp: { tool: 'get_agent_readiness_report', id: row.id },
    })
  }
  const report = polled.value.report as AgentReadinessReport | null
  if (polled.value.status === 'FAILED') {
    return fail(asString(polled.value.error) ?? 'Agent readiness audit failed.', {
      mode: 'remote',
      id: polled.value.id,
      status: polled.value.status,
    })
  }
  if (!report || polled.timedOut) {
    return ok(
      `Agent readiness audit ${String(polled.value.status)}. Job id: ${String(polled.value.id)}. Fetch it with get_agent_readiness_report.`,
      {
        mode: 'remote',
        id: polled.value.id,
        status: polled.value.status,
        timedOut: polled.timedOut,
        followUp: { tool: 'get_agent_readiness_report', id: polled.value.id },
      },
    )
  }
  const data = compactReadiness(report, {
    mode: 'remote',
    id: polled.value.id,
    status: polled.value.status,
    timedOut: false,
    persisted: true,
  })
  return ok(readinessSummary(data), data)
}

export async function getAgentReadinessReport(input: { id: string }, deps: HandlerDeps): Promise<ToolOutput> {
  const api = needApi(deps)
  if (isToolOutput(api)) return api
  try {
    const row = healthView(await api.agentReadiness.get.query({ id: input.id }))
    if (!row) return fail('Agent readiness report returned an unexpected payload.', { code: 'API_ERROR' })
    const report = row.report as AgentReadinessReport | null
    if (!report) {
      return ok(`Agent readiness audit ${String(row.status)}. Job id: ${String(row.id)}.`, {
        mode: 'remote',
        id: row.id,
        status: row.status,
        error: row.error ?? null,
        report: null,
      })
    }
    const data = compactReadiness(report, { mode: 'remote', id: row.id, status: row.status, persisted: true })
    return ok(readinessSummary(data), { ...data, report })
  } catch (err) {
    return fail(errorMessage(err), { code: 'API_ERROR', id: input.id })
  }
}

function trimQuery(value: unknown): Record<string, unknown> | null {
  const row = asRecord(value)
  if (!row) return null
  return {
    id: row.id ?? null,
    queryText: row.queryText ?? null,
    source: row.source ?? null,
    status: row.status ?? null,
    intentType: row.intentType ?? null,
    mappedPageUrl: row.mappedPageUrl ?? null,
    priority: row.priority ?? null,
    scheduled: row.scheduled ?? null,
  }
}

export async function listQueries(deps: HandlerDeps): Promise<ToolOutput> {
  const api = needApi(deps)
  if (isToolOutput(api)) return api
  try {
    const rows = await api.citation.queries.list.query()
    const list = Array.isArray(rows) ? rows.map(trimQuery).filter((row): row is Record<string, unknown> => row != null) : []
    return ok(`${list.length} active quer${list.length === 1 ? 'y' : 'ies'} in the library.`, { queries: list })
  } catch (err) {
    return fail(errorMessage(err), { code: 'API_ERROR' })
  }
}

export async function addQueries(input: AddQueriesInput, deps: HandlerDeps): Promise<ToolOutput> {
  const api = needApi(deps)
  if (isToolOutput(api)) return api
  if (input.queries.length === 0) return fail('Pass at least one query.', { code: 'BAD_INPUT' })
  const created = []
  const errors = []
  for (const query of input.queries) {
    try {
      const row = trimQuery(await api.citation.queries.add.mutate({
        queryText: query.queryText,
        source: query.source ?? 'manual',
        pageId: query.pageId,
        intent: query.intent,
      }))
      created.push(row)
    } catch (err) {
      errors.push({ queryText: query.queryText, error: errorMessage(err) })
    }
  }
  const summary = `Added ${created.length} quer${created.length === 1 ? 'y' : 'ies'}${errors.length ? `, ${errors.length} failed` : ''}.`
  if (created.length === 0) return fail(summary, { created, errors })
  return ok(summary, { created, errors })
}

async function configuredPlatforms(api: GeoApi): Promise<string[]> {
  const workspace = asRecord(await api.workspace.get.query())
  const summary = asRecord(workspace?.platformSummary)
  if (!summary) return []
  return Object.entries(summary)
    .filter(([, value]) => asRecord(value)?.configured === true)
    .map(([name]) => name)
}

function trimEvent(value: unknown): Record<string, unknown> {
  const row = asRecord(value) ?? {}
  const query = asRecord(row.query)
  return {
    platform: row.platform ?? null,
    query: query?.queryText ?? null,
    status: row.status ?? null,
    brandMentioned: row.brandMentioned ?? null,
    brandSourceCited: row.brandSourceCited ?? null,
    rankInAnswer: row.rankInAnswer ?? null,
    sovScore: row.sovScore ?? null,
    citedUrls: row.citedUrls ?? [],
    failureReason: row.failureReason ?? null,
  }
}

export async function runCitationCheck(input: CitationInput, deps: HandlerDeps): Promise<ToolOutput> {
  const api = needApi(deps)
  if (isToolOutput(api)) return api
  const queryText = input.query?.trim()
  if (!input.queryId && !queryText) return fail('Pass query or queryId.', { code: 'BAD_INPUT' })
  try {
    let queryId = input.queryId ?? null
    if (!queryId && queryText) {
      const existing = await api.citation.queries.list.query()
      const match = Array.isArray(existing)
        ? existing.map(asRecord).find((row) => asString(row?.queryText)?.trim().toLowerCase() === queryText.toLowerCase())
        : null
      queryId = asString(match?.id)
      if (!queryId) {
        const added = asRecord(await api.citation.queries.add.mutate({ queryText, source: 'manual' }))
        queryId = asString(added?.id)
      }
    }
    if (!queryId) return fail('Could not resolve a query id.', { code: 'API_ERROR' })

    const platforms = input.platforms?.length ? input.platforms : await configuredPlatforms(api)
    if (platforms.length === 0) {
      return fail(
        'No AI engines are configured for this workspace. Add platform credentials in the console, or pass platforms.',
        { code: 'NO_ENGINES', queryId },
      )
    }
    await progress(deps, 5, `Starting citation check on ${platforms.join(', ')}`)
    const created = asRecord(await api.citation.runs.create.mutate({
      platforms,
      queryIds: [queryId],
      sampleCount: input.sampleCount,
    }))
    const runId = asString(created?.runId)
    if (!runId) {
      return ok('Citation check did not start. There was no active query or platform to run.', {
        queryId,
        platforms,
        runId: null,
        status: created?.status ?? 'SKIPPED',
      })
    }
    let polled: { value: unknown; timedOut: boolean }
    try {
      polled = await pollUntil({
        timeoutMs: waitMs(input.waitMs),
        clocks: deps.clocks,
        signal: deps.signal,
        isDone: (value) => RUN_DONE.has(String(asRecord(value)?.status)),
        fetch: () => api.citation.runStatus.query({ runId }),
        onTick: async (value) => {
          const row = asRecord(value)
          const planned = asNumber(row?.plannedUnits) ?? 0
          const completed = asNumber(row?.completedUnits) ?? 0
          const percent = planned > 0 ? Math.round((completed / planned) * 100) : 20
          await progress(deps, percent, `Citation run ${String(row?.status ?? 'RUNNING')}`)
        },
      })
    } catch (err) {
      return fail(`${errorMessage(err)} Run id: ${runId}.`, { code: 'API_ERROR', queryId, runId })
    }
    const status = asRecord(polled.value) ?? {}
    if (polled.timedOut || !RUN_DONE.has(String(status.status))) {
      return ok(
        `Citation check is still ${String(status.status ?? 'RUNNING')}. Run id: ${runId}. Poll citation status later with this id.`,
        { queryId, platforms, runId, status: status.status ?? 'RUNNING', timedOut: true, followUp: { runId } },
      )
    }
    let events: Record<string, unknown>[] = []
    try {
      const samples = asRecord(await api.citation.runs.samples.query({ runId }))
      events = Array.isArray(samples?.events) ? samples.events.map(trimEvent) : []
    } catch (err) {
      return ok(`Citation run ${String(status.status)} finished, but the samples could not be loaded. Run id: ${runId}.`, {
        queryId,
        platforms,
        runId,
        status: status.status,
        timedOut: false,
        error: errorMessage(err),
      })
    }
    const okEvents = events.filter((event) => event.status === 'OK')
    const mentions = okEvents.filter((event) => event.brandMentioned === true).length
    const data = {
      queryId,
      platforms,
      runId,
      status: status.status,
      timedOut: false,
      failureReason: status.failureReason ?? null,
      mentioned: mentions,
      answered: okEvents.length,
      events,
    }
    const summary = `Citation run ${String(status.status)} for query ${queryId}. Brand mentioned in ${mentions} of ${okEvents.length} answers.`
    if (status.status === 'FAILED') return fail(asString(status.failureReason) ?? summary, data)
    return ok(summary, data)
  } catch (err) {
    return fail(errorMessage(err), { code: 'API_ERROR' })
  }
}

export async function getShareOfVoice(input: SovToolInput, deps: HandlerDeps): Promise<ToolOutput> {
  const api = needApi(deps)
  if (isToolOutput(api)) return api
  const now = deps.clocks?.now() ?? Date.now()
  const end = input.end ? new Date(input.end) : new Date(now)
  const start = input.start ? new Date(input.start) : new Date(end.getTime() - 29 * 86_400_000)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return fail('start and end must be dates.', { code: 'BAD_INPUT' })
  }
  try {
    let competitors = input.competitors
    if (!competitors) {
      const workspace = asRecord(await api.workspace.get.query())
      competitors = Array.isArray(workspace?.competitors) ? workspace.competitors.filter((item): item is string => typeof item === 'string') : []
    }
    const score = await api.citation.getSovScore.query({
      competitors,
      dateRange: { start: start.toISOString(), end: end.toISOString() },
      platform: input.platform,
    })
    const row = asRecord(score) ?? {}
    return ok(
      `Share of voice ${row.sovMean ?? 'n/a'} from ${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}. Mention rate ${row.brandMentionRate ?? 'n/a'}.`,
      { start: start.toISOString(), end: end.toISOString(), platform: input.platform ?? null, competitors, score: row },
    )
  } catch (err) {
    return fail(errorMessage(err), { code: 'API_ERROR' })
  }
}

async function pageText(input: { url?: string; text?: string }, deps: HandlerDeps): Promise<{ text: string; url?: string } | ToolOutput> {
  if (input.text?.trim()) return { text: input.text, url: input.url }
  if (!input.url) return fail('Pass text, url, or pageId.', { code: 'BAD_INPUT' })
  let fetched: FetchedPage
  try {
    fetched = await (deps.fetchUrl ?? fetchPublic)(input.url)
  } catch (err) {
    return fail(ssrfMessage(err) ?? errorMessage(err), { code: 'FETCH_FAILED', url: input.url })
  }
  if (fetched.error || fetched.status !== 200) {
    return fail(fetched.errorMessage ?? `Fetch failed (${fetched.error ?? `HTTP ${fetched.status}`}).`, {
      code: 'FETCH_FAILED',
      url: input.url,
    })
  }
  const text = htmlToText(fetched.body)
  if (!text) return fail('The URL did not contain readable text.', { code: 'EMPTY_PAGE', url: input.url })
  return { text, url: input.url }
}

function compactOptimization(raw: unknown) {
  const row = asRecord(raw) ?? {}
  const atoms = Array.isArray(row.atoms) ? row.atoms : []
  const faqs = Array.isArray(row.faqs) ? row.faqs : []
  return {
    overallScore: row.overallScore ?? null,
    rewrittenCount: row.rewrittenCount ?? null,
    atomCount: atoms.length,
    atoms: atoms.slice(0, 12).map((atom) => {
      const item = asRecord(atom) ?? {}
      return { text: item.text ?? null, score: asNumber(asRecord(item.score)?.total) }
    }),
    faqCount: faqs.length,
    faqs: faqs.slice(0, 8),
    truncated: atoms.length > 12 || faqs.length > 8,
  }
}

export async function optimizeContent(input: OptimizeToolInput, deps: HandlerDeps): Promise<ToolOutput> {
  const api = needApi(deps)
  if (isToolOutput(api)) return api
  try {
    let result: unknown
    if (input.pageId && !input.text && !input.url) {
      result = await api.content.optimize.mutate({ pageId: input.pageId })
    } else {
      const page = await pageText(input, deps)
      if (isToolOutput(page)) return page
      if (page.text.length > 100_000) return fail('Text is longer than 100000 characters.', { code: 'BAD_INPUT' })
      result = await api.content.optimize.mutate({
        content: page.text,
        url: page.url,
        pageType: input.pageType,
        pageId: input.pageId,
      })
    }
    const data = compactOptimization(result)
    return ok(
      `Optimized content. Overall score ${String(data.overallScore)}. Rewrote ${String(data.rewrittenCount)} weak atoms out of ${data.atomCount}.`,
      data,
    )
  } catch (err) {
    return fail(errorMessage(err), { code: 'API_ERROR' })
  }
}

export async function generateSchema(input: SchemaToolInput, deps: HandlerDeps): Promise<ToolOutput> {
  const remote = !localSignals(deps) && Boolean(input.pageUrl) && REMOTE_SCHEMA.has(input.schemaType)
  if (!remote) {
    try {
      const built = buildSchema(input.schemaType, input.fields)
      const why = localSignals(deps)
        ? 'Generated in-process. Nothing was stored.'
        : input.pageUrl
          ? `${input.schemaType} is not stored by the API. Generated in-process.`
          : 'No pageUrl, so the document was not stored. Generated in-process.'
      const problems = built.valid
        ? 'Validation passed.'
        : `Validation reported errors: ${built.errors.slice(0, 5).map((item) => item.message).join('; ')}`
      return ok(`${why} ${problems}\n${JSON.stringify(built.jsonld)}`, {
        mode: 'local',
        persisted: false,
        ...built,
      })
    } catch (err) {
      return fail(schemaError(err) ?? errorMessage(err), { code: 'SCHEMA_INVALID', schemaType: input.schemaType })
    }
  }
  const api = needApi(deps)
  if (isToolOutput(api)) return api
  try {
    const result = asRecord(await api.schema.generate.jsonLd.mutate({
      pageUrl: input.pageUrl ?? '',
      schemaType: input.schemaType as 'Organization',
      fields: input.fields,
    }))
    return ok(`Stored JSON-LD on the workspace.\n${JSON.stringify(result?.jsonld ?? result)}`, {
      mode: 'remote',
      persisted: true,
      jsonld: result?.jsonld ?? result,
      recordId: asRecord(result?.record)?.id ?? null,
    })
  } catch (err) {
    return fail(errorMessage(err), { code: 'API_ERROR' })
  }
}

export async function generateLlmsTxt(input: LlmsToolInput, deps: HandlerDeps): Promise<ToolOutput> {
  if (input.brandName) {
    if (!input.tagline || !input.sections) {
      return fail('Generating llms.txt needs brandName, tagline, and sections.', { code: 'BAD_INPUT' })
    }
    const built = buildLlmsTxt({
      brandName: input.brandName,
      tagline: input.tagline,
      sections: input.sections,
      updateFrequency: input.updateFrequency,
    })
    if (localSignals(deps)) {
      return ok(`Generated llms.txt in-process. Nothing was stored.\n\n${built.content}`, {
        mode: 'local',
        persisted: false,
        content: built.content,
        warnings: built.warnings,
      })
    }
    const api = needApi(deps)
    if (isToolOutput(api)) return api
    try {
      await api.schema.generate.llmsTxt.mutate({
        pageUrl: input.pageUrl,
        brandName: input.brandName,
        tagline: input.tagline,
        sections: input.sections,
        updateFrequency: input.updateFrequency,
      })
      return ok(`Generated llms.txt and stored it on the workspace.\n\n${built.content}`, {
        mode: 'remote',
        persisted: true,
        content: built.content,
        warnings: built.warnings,
      })
    } catch (err) {
      return ok(`Generated llms.txt in-process. Storing it failed.\n\n${built.content}`, {
        mode: 'local',
        persisted: false,
        content: built.content,
        warnings: [...built.warnings, errorMessage(err)],
      })
    }
  }

  if (input.text) {
    const validation = validateLlmsText(input.text)
    return ok(`llms.txt validation: ${validation.status}. ${validation.explanation}`, { mode: 'local', validation })
  }
  if (input.url) {
    let target: string
    try {
      target = llmsTarget(input.url)
    } catch (err) {
      return fail(errorMessage(err), { code: 'BAD_INPUT' })
    }
    let fetched: FetchedPage
    try {
      fetched = await (deps.fetchUrl ?? fetchPublic)(target)
    } catch (err) {
      return fail(ssrfMessage(err) ?? errorMessage(err), { code: 'FETCH_FAILED', url: target })
    }
    const validation = validateLlmsText(fetched.body, fetched.error ? 0 : fetched.status, fetched.contentType)
    return ok(`llms.txt at ${target}: ${validation.status}. ${validation.explanation}`, {
      mode: 'local',
      url: target,
      httpStatus: fetched.status,
      validation,
    })
  }
  return fail('Pass brandName, tagline, and sections to generate, or text / url to validate.', { code: 'BAD_INPUT' })
}

function inlineUrl(text: string): string {
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 12)
  return `https://mcp.geociteops.local/extract/${hash}`
}

function compactGraph(raw: unknown) {
  const row = asRecord(raw) ?? {}
  const proposals = asRecord(row.proposals)
  const entities = Array.isArray(proposals?.entities) ? proposals.entities : []
  const relations = Array.isArray(proposals?.relations) ? proposals.relations : []
  return {
    taskId: asRecord(row.task)?.id ?? null,
    entityCount: entities.length,
    relationCount: relations.length,
    entities: entities.slice(0, 20).map((entity) => {
      const item = asRecord(entity) ?? {}
      return { name: item.name ?? null, type: item.type ?? item.rawType ?? null }
    }),
    relations: relations.slice(0, 20),
    truncated: entities.length > 20 || relations.length > 20,
  }
}

export async function extractKnowledgeGraph(input: KgToolInput, deps: HandlerDeps): Promise<ToolOutput> {
  const api = needApi(deps)
  if (isToolOutput(api)) return api
  try {
    let pageId = input.pageId ?? null
    if (!pageId) {
      const page = await pageText(input, deps)
      if (isToolOutput(page)) return page
      const saved = asRecord(await api.content.pages.upsert.mutate({
        url: page.url ?? inlineUrl(page.text),
        pageType: input.pageType ?? 'article',
        currentContent: page.text,
      }))
      pageId = asString(saved?.id)
      if (!pageId) return fail('Saving the page did not return an id.', { code: 'API_ERROR' })
    }
    const extracted = await api.kg.extractFromPage.mutate({ pageId })
    const data = { pageId, ...compactGraph(extracted) }
    return ok(
      `Knowledge graph for page ${pageId}: ${data.entityCount} entities, ${data.relationCount} relations.`,
      data,
    )
  } catch (err) {
    return fail(errorMessage(err), { code: 'API_ERROR' })
  }
}
