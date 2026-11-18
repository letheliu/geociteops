import type { PrismaClient } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import type { AgentReadinessReport } from '../agent-readiness/types.js'
import { GeoHealthError } from './errors.js'
import { createGeoHealthService, GEO_HEALTH_QUEUES, type GeoHealthQueue } from './service.js'
import type { PillarId } from './types.js'

function memoryPrisma() {
  const rows = new Map<string, any>()
  const db = {
    create: vi.fn(async ({ data }: any) => {
      const row = {
        id: `check-${rows.size + 1}`,
        industry: null,
        score: null,
        grade: null,
        pillarResults: null,
        report: null,
        error: null,
        createdAt: new Date('2026-11-16T00:00:00.000Z'),
        startedAt: null,
        finishedAt: null,
        updatedAt: new Date('2026-11-16T00:00:00.000Z'),
        ...data,
      }
      rows.set(row.id, row)
      return { ...row }
    }),
    findFirst: vi.fn(async ({ where }: any) => {
      const row = rows.get(where.id)
      if (!row || row.workspaceId !== where.workspaceId) return null
      return row
    }),
    findUnique: vi.fn(async ({ where }: any) => rows.get(where.id) ?? null),
    findMany: vi.fn(async ({ where }: any) => [...rows.values()].filter((row) => row.workspaceId === where.workspaceId).reverse()),
    update: vi.fn(async ({ where, data }: any) => {
      const row = rows.get(where.id)
      Object.assign(row, data)
      return row
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const row = rows.get(where.id)
      if (!row) return { count: 0 }
      const allowed = where.status?.in as string[] | undefined
      if (allowed && !allowed.includes(row.status)) return { count: 0 }
      Object.assign(row, data)
      return { count: 1 }
    }),
  }
  const prisma = {
    geoHealthCheck: db,
    $transaction: async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
  }
  return { prisma: prisma as unknown as PrismaClient, rows, db }
}

const readiness = {
  version: 1,
  url: 'https://acme.example/',
  finalUrl: 'https://acme.example/',
  fetchedAt: '2026-11-16T00:00:00.000Z',
  durationMs: 1,
  score: 80,
  grade: 'B',
  summary: { en: 'ok', zh: '好' },
  checks: [],
  fixes: [],
  categories: [],
} satisfies AgentReadinessReport

function pillarResult(pillar: PillarId) {
  if (pillar === 'agentReadiness') return { status: 'SUCCEEDED', score: 80, report: readiness, error: null }
  if (pillar === 'citations') {
    return {
      status: 'SKIPPED',
      score: null,
      queries: [{
        text: 'What is Acme?',
        kind: 'brand',
        language: 'en',
        source: 'template',
        samples: 0,
        mentions: 0,
        citations: 0,
        meanRank: null,
      }],
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
      note: { en: 'skip', zh: '跳过' },
      error: null,
    }
  }
  if (pillar === 'citability') {
    return { status: 'FAILED', score: null, pages: [], weakestPages: [], note: null, error: 'fetch failed' }
  }
  return {
    status: 'SUCCEEDED',
    score: 40,
    schemaTypes: [],
    jsonLdPresent: false,
    llmsTxtStatus: 'fail',
    llmsFullStatus: 'fail',
    generatedLlmsTxt: '# Acme\n',
    generatedJsonLd: '[]',
    note: null,
    error: null,
  }
}

describe('geo health service', () => {
  it('rejects a private URL before enqueueing', async () => {
    const { prisma, db } = memoryPrisma()
    const boss: GeoHealthQueue = { send: vi.fn() }
    const service = createGeoHealthService({
      prisma,
      boss,
      queryLibrary: { listActive: vi.fn(), addQuery: vi.fn() },
      pillarDeps: {} as any,
    })
    await expect(service.start('ws-1', { brandName: 'Acme', siteUrl: 'http://127.0.0.1/' })).rejects.toMatchObject({ code: 'SSRF_BLOCKED' })
    await expect(service.start('ws-1', { brandName: '', siteUrl: 'https://acme.example' })).rejects.toBeInstanceOf(GeoHealthError)
    expect(db.create).not.toHaveBeenCalled()
  })

  it('queues a check and keeps history on the workspace', async () => {
    const { prisma } = memoryPrisma()
    const boss: GeoHealthQueue = { send: vi.fn(async () => 'job-1') }
    const service = createGeoHealthService({
      prisma,
      boss,
      queryLibrary: { listActive: vi.fn(), addQuery: vi.fn() },
      pillarDeps: {} as any,
    })
    const created = await service.start('ws-1', {
      brandName: ' Acme ',
      siteUrl: 'https://acme.example',
      industry: 'docs',
      competitors: [' Notion ', 'Notion'],
      language: 'auto',
    })
    expect(created.status).toBe('QUEUED')
    expect(created.siteUrl).toBe('https://acme.example/')
    expect(boss.send).toHaveBeenCalledWith(GEO_HEALTH_QUEUES.dispatch, { checkId: created.id }, expect.objectContaining({ retryLimit: 2 }))
    await expect(service.get('ws-2', created.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const detail = await service.get('ws-1', created.id)
    expect(detail.competitors).toEqual(['Notion'])
    expect(detail.progress.percent).toBe(0)
    await service.start('ws-1', { brandName: 'Other', siteUrl: 'https://other.example' })
    const list = await service.list('ws-1')
    expect(list).toHaveLength(2)
    expect(list.map((item) => item.brandName)).toContain('Acme')
  })

  it('fans out pillars, survives one failure, and can save the generated questions', async () => {
    const { prisma } = memoryPrisma()
    const sent: unknown[] = []
    const boss: GeoHealthQueue = {
      send: vi.fn(async (name, data) => {
        sent.push({ name, data })
        return 'job'
      }),
    }
    const stored = [{ queryText: 'already there' }]
    const addQuery = vi.fn(async (input: { queryText: string }) => {
      stored.push({ queryText: input.queryText })
      return { id: 'q1' }
    })
    const service = createGeoHealthService({
      prisma,
      boss,
      queryLibrary: {
        listActive: vi.fn(async () => stored.map((item) => ({ ...item }))),
        addQuery,
      },
      pillarDeps: {} as any,
      runPillar: async (pillar) => pillarResult(pillar),
    })
    const created = await service.start('ws-1', { brandName: 'Acme', siteUrl: 'https://acme.example/' })
    await service.dispatch(created.id)
    const pillarJobs = sent.filter((item) => (item as { name: string }).name === GEO_HEALTH_QUEUES.pillar) as { data: { pillar: PillarId } }[]
    expect(pillarJobs.map((item) => item.data.pillar).sort()).toEqual(['agentReadiness', 'citability', 'citations'])
    for (const job of pillarJobs) {
      await service.runPillarJob(created.id, job.data.pillar)
    }
    const signal = sent.find((item) => (item as { data?: { pillar?: string } }).data?.pillar === 'structuredSignals')
    expect(signal).toBeTruthy()
    await service.runPillarJob(created.id, 'structuredSignals')
    await service.finalize(created.id)
    const detail = await service.get('ws-1', created.id)
    expect(detail.status).toBe('PARTIAL')
    expect(detail.report?.pillars.agentReadiness.report).toEqual(readiness)
    expect(detail.report?.pillars.citability.status).toBe('FAILED')
    expect(detail.score).toBe(Math.round(80 * (0.3 / 0.45) + 40 * (0.15 / 0.45)))
    expect(detail.report?.weighting.applied.citability).toBe(0)
    const saved = await service.saveQueries('ws-1', created.id)
    expect(saved).toEqual({ saved: 1, skipped: 0 })
    expect(addQuery).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1',
      queryText: 'What is Acme?',
      source: 'LLM_GENERATED',
    }))
    const again = await service.saveQueries('ws-1', created.id)
    expect(again.skipped).toBe(1)
    expect(again.saved).toBe(0)
    const markdown = await service.exportReport('ws-1', created.id, 'markdown')
    expect(markdown.content).toContain('GEO 体检：Acme')
    expect(markdown.content).toContain(String(detail.score))
    const json = await service.exportReport('ws-1', created.id, 'json')
    expect(JSON.parse(json.content).version).toBe(1)
    const pdf = await service.exportReport('ws-1', created.id, 'pdf')
    expect(pdf.encoding).toBe('base64')
    expect(Buffer.from(pdf.content, 'base64').subarray(0, 5).toString()).toBe('%PDF-')
  })
})
