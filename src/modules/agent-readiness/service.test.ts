import type { PrismaClient } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { AgentReadinessError } from './errors.js'
import { createAgentReadinessService, type AgentReadinessQueue } from './service.js'
import type { AgentReadinessReport } from './types.js'

function memoryPrisma() {
  const rows = new Map<string, any>()
  const db = {
    create: vi.fn(async ({ data }: any) => {
      const row = {
        id: `audit-${rows.size + 1}`,
        score: null,
        grade: null,
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
    findMany: vi.fn(async ({ where }: any) => [...rows.values()].filter((row) => row.workspaceId === where.workspaceId)),
    update: vi.fn(async ({ where, data }: any) => {
      const row = rows.get(where.id)
      Object.assign(row, data)
      return row
    }),
  }
  return { prisma: { agentReadinessAudit: db } as unknown as PrismaClient, rows, db }
}

const report = {
  version: 1,
  url: 'https://example.com/',
  finalUrl: 'https://example.com/',
  fetchedAt: '2026-11-16T00:00:00.000Z',
  durationMs: 12,
  score: 88,
  grade: 'B',
  summary: { en: 'ok', zh: '好' },
  checks: [],
  fixes: [],
  categories: [],
} satisfies AgentReadinessReport

describe('agent readiness service', () => {
  it('rejects a private URL before enqueueing', async () => {
    const { prisma, db } = memoryPrisma()
    const boss: AgentReadinessQueue = { send: vi.fn() }
    const service = createAgentReadinessService({ prisma, boss, runAudit: vi.fn() })
    await expect(service.start('ws-1', 'http://127.0.0.1/')).rejects.toMatchObject({ code: 'SSRF_BLOCKED' })
    await expect(service.start('ws-1', 'notaurl')).rejects.toBeInstanceOf(AgentReadinessError)
    expect(db.create).not.toHaveBeenCalled()
  })

  it('persists a queued audit and enqueues the pg-boss job', async () => {
    const { prisma } = memoryPrisma()
    const boss: AgentReadinessQueue = { send: vi.fn(async () => 'job-1') }
    const service = createAgentReadinessService({ prisma, boss, runAudit: vi.fn() })
    const created = await service.start('ws-1', 'https://example.com')
    expect(created.status).toBe('QUEUED')
    expect(created.url).toBe('https://example.com/')
    expect(boss.send).toHaveBeenCalledWith('agent-readiness-audit', { auditId: created.id }, expect.objectContaining({ retryLimit: 2 }))
  })

  it('marks the row failed when the queue refuses the job', async () => {
    const { prisma, rows } = memoryPrisma()
    const boss: AgentReadinessQueue = { send: vi.fn(async () => null) }
    const service = createAgentReadinessService({ prisma, boss, runAudit: vi.fn() })
    await expect(service.start('ws-1', 'https://example.com/')).rejects.toMatchObject({ code: 'QUEUE_UNAVAILABLE' })
    expect([...rows.values()][0].status).toBe('FAILED')
  })

  it('stores the report and will not run a finished audit again', async () => {
    const { prisma } = memoryPrisma()
    const runAudit = vi.fn(async () => report)
    const boss: AgentReadinessQueue = { send: vi.fn(async () => 'job-1') }
    const service = createAgentReadinessService({ prisma, boss, runAudit })
    const created = await service.start('ws-1', 'https://example.com/')
    await service.execute(created.id)
    await service.execute(created.id)
    expect(runAudit).toHaveBeenCalledTimes(1)
    const stored = await service.get('ws-1', created.id)
    expect(stored.status).toBe('SUCCEEDED')
    expect(stored.score).toBe(88)
    expect(stored.report?.version).toBe(1)
    await expect(service.get('ws-2', created.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('records an SSRF failure from the runner without retrying', async () => {
    const { prisma } = memoryPrisma()
    const { SsrfError } = await import('./ssrf.js')
    const runAudit = vi.fn(async () => { throw new SsrfError('目标解析到内网或本机地址，已拒绝') })
    const service = createAgentReadinessService({
      prisma,
      boss: { send: vi.fn(async () => 'job-1') },
      runAudit,
    })
    const created = await service.start('ws-1', 'https://example.com/')
    await expect(service.execute(created.id)).resolves.toBeUndefined()
    const stored = await service.get('ws-1', created.id)
    expect(stored.status).toBe('FAILED')
    expect(stored.error).toContain('内网')
  })
})
