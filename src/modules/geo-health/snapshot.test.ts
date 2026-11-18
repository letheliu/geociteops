import type { PrismaClient } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { buildAcmeDrawSeries } from '../../../scripts/lib/acme-draw-health.ts'
import { persistCitationSnapshot, planCitationSnapshot } from './snapshot.js'
import type { CitationSample } from './types.js'

describe('citation snapshot mapping', () => {
  const report = buildAcmeDrawSeries({ now: new Date('2026-11-16T08:00:00.000Z') }).at(-1)!.health

  it('plans a health-check run and does not invent one when nothing was asked', () => {
    const plan = planCitationSnapshot('check-1', report.pillars.citations)
    expect(plan).toMatchObject({
      slotKey: 'health:check-1',
      trigger: 'HEALTH_CHECK',
      sampleCount: 1,
      status: 'COMPLETED',
    })
    expect(plan?.events).toHaveLength(report.pillars.citations.samples.length)
    expect(plan?.events[0]?.analysis).toEqual({ source: 'geo-health', checkId: 'check-1' })
    expect(plan?.events.every((event) => event.rawAnswer.includes('GEO 体检快照'))).toBe(true)
    expect(planCitationSnapshot('check-1', { ...report.pillars.citations, samples: [] })).toBeNull()
  })

  it('numbers a repeated query and platform, and drops a failed sample out of the score fields', () => {
    const first = report.pillars.citations.samples[0] as CitationSample
    const failed: CitationSample = { ...first, ok: false, error: 'timeout', sovScore: 0.9, brandMentioned: true }
    const plan = planCitationSnapshot('check-2', {
      ...report.pillars.citations,
      samples: [first, failed],
    })
    expect(plan?.status).toBe('PARTIAL')
    expect(plan?.events.map((event) => event.sampleIndex)).toEqual([1, 2])
    expect(plan?.events[1]).toMatchObject({ status: 'FAILED', sovScore: null, brandMentioned: false, failureReason: 'timeout' })
  })

  it('reuses an existing query and writes the run as HEALTH_CHECK once', async () => {
    const queries = new Map<string, { id: string; queryText: string; status?: string; scheduled?: boolean; source?: string }>()
    queries.set('q-existing', { id: 'q-existing', queryText: report.pillars.citations.queries[0]!.text, status: 'ACTIVE', scheduled: true, source: 'MANUAL' })
    const runs = new Map<string, { id: string; slotKey: string; trigger: string; workspaceId: string }>()
    const events: { runId: string; queryId: string; platform: string; sampleIndex: number }[] = []
    let querySeq = 0
    let runSeq = 0
    const prisma = {
      citationQuery: {
        findMany: vi.fn(async () => [...queries.values()]),
        create: vi.fn(async ({ data }: { data: { queryText: string; status: string; scheduled: boolean; source: string } }) => {
          const row = { id: `q-${++querySeq}`, queryText: data.queryText, status: data.status, scheduled: data.scheduled, source: data.source }
          queries.set(row.id, row)
          return row
        }),
      },
      citationRun: {
        findUnique: vi.fn(async ({ where }: { where: { slotKey: string } }) => [...runs.values()].find((run) => run.slotKey === where.slotKey) ?? null),
        create: vi.fn(async ({ data }: { data: { slotKey: string; trigger: string; workspaceId: string } }) => {
          const row = { id: `run-${++runSeq}`, slotKey: data.slotKey, trigger: data.trigger, workspaceId: data.workspaceId }
          runs.set(row.id, row)
          return row
        }),
      },
      citationEvent: {
        count: vi.fn(async ({ where }: { where: { runId: string } }) => events.filter((event) => event.runId === where.runId).length),
        createMany: vi.fn(async ({ data }: { data: { runId: string; queryId: string; platform: string; sampleIndex: number }[] }) => {
          events.push(...data)
          return { count: data.length }
        }),
      },
    }
    const first = await persistCitationSnapshot(prisma as unknown as PrismaClient, {
      workspaceId: 'ws-1',
      checkId: 'check-9',
      report,
      startedAt: new Date('2026-11-04T02:00:00.000Z'),
    })
    const second = await persistCitationSnapshot(prisma as unknown as PrismaClient, {
      workspaceId: 'ws-1',
      checkId: 'check-9',
      report,
      startedAt: new Date('2026-11-04T02:00:00.000Z'),
    })
    expect(first).toBe('run-1')
    expect(second).toBe('run-1')
    expect(runs.get('run-1')).toMatchObject({ trigger: 'HEALTH_CHECK', workspaceId: 'ws-1', slotKey: 'health:check-9' })
    expect(prisma.citationRun.create).toHaveBeenCalledTimes(1)
    expect(events.filter((event) => event.queryId === 'q-existing').length).toBeGreaterThan(0)
    const created = [...queries.values()].filter((query) => query.id !== 'q-existing')
    expect(created.length).toBeGreaterThan(0)
    expect(created.every((query) => query.status === 'PAUSED' && query.scheduled === false && query.source === 'HEALTH_CHECK')).toBe(true)
  })
})
