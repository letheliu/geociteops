import { describe, it, expect, vi } from 'vitest'
import { createSampleWorker } from './diagnostic-sample-worker.js'

describe('DiagnosticSampleWorker', () => {
  it('processes a sample successfully', async () => {
    const boss = { send: vi.fn() }
    const prisma: any = {
      diagnosticRun: { findFirst: vi.fn() },
      diagnosticSample: { findFirst: vi.fn(), update: vi.fn().mockResolvedValue({}) },
      diagnosticRunQuery: { findFirst: vi.fn() },
    }
    prisma.diagnosticRun.findFirst.mockResolvedValue({
      id: 'run-1', status: 'RUNNING',
      brandSnapshot: { brandName: 'Test' },
      competitorSnapshot: [],
      platformSnapshot: ['deepseek'],
      samplingSnapshot: { samplesPerQuery: 1, locale: 'zh-CN', timezone: 'Asia/Shanghai' },
    })
    prisma.diagnosticSample.findFirst.mockResolvedValue({
      id: 's-1', runId: 'run-1', platform: 'deepseek', status: 'PENDING', attemptCount: 0,
    })
    prisma.diagnosticRunQuery.findFirst.mockResolvedValue({
      id: 'rq-1', queryText: 'test query',
    })

    const registry = { get: vi.fn().mockReturnValue({ name: 'deepseek', query: vi.fn().mockResolvedValue({ answer: 'test', sourceCitations: [], groundingSources: [], answerMentions: [] }) }) }
    const analyzeCitation = vi.fn().mockResolvedValue({
      brandMentioned: true, brandSourceCited: true, rankInAnswer: 1, sourceRank: 1,
      sovScore: 0.8, sourceCitationRate: 0.5, competitors: [],
    })

    const worker = createSampleWorker({ registry: registry as any, analyzeCitation, boss: boss as any, prisma })
    const result = await worker.process({ sampleId: 's-1', runId: 'run-1' })

    expect(result.status).toBe('SUCCEEDED')
  })

  it('retries on retryable errors up to 3 times', async () => {
    const boss = { send: vi.fn() }
    const prisma: any = {
      diagnosticRun: { findFirst: vi.fn() },
      diagnosticSample: { findFirst: vi.fn(), update: vi.fn().mockResolvedValue({}) },
      diagnosticRunQuery: { findFirst: vi.fn() },
    }
    prisma.diagnosticRun.findFirst.mockResolvedValue({
      id: 'run-1', status: 'RUNNING',
      brandSnapshot: { brandName: 'Test' },
      competitorSnapshot: [],
      platformSnapshot: ['deepseek'],
      samplingSnapshot: { samplesPerQuery: 1, locale: 'zh-CN', timezone: 'Asia/Shanghai' },
    })
    prisma.diagnosticSample.findFirst.mockResolvedValue({
      id: 's-1', runId: 'run-1', platform: 'deepseek', status: 'PENDING', attemptCount: 0,
    })
    prisma.diagnosticRunQuery.findFirst.mockResolvedValue({
      id: 'rq-1', queryText: 'test query',
    })

    const registry = { get: vi.fn().mockReturnValue({ name: 'deepseek', query: vi.fn().mockRejectedValue({ status: 429, message: 'Too Many Requests' }) }) }
    const analyzeCitation = vi.fn()

    const worker = createSampleWorker({ registry: registry as any, analyzeCitation, boss: boss as any, prisma })
    const result = await worker.process({ sampleId: 's-1', runId: 'run-1' })

    expect(result.status).toBe('FAILED')
    expect(result.retryable).toBe(true)
  })

  it('does not retry non-retryable errors', async () => {
    const boss = { send: vi.fn() }
    const prisma: any = {
      diagnosticRun: { findFirst: vi.fn() },
      diagnosticSample: { findFirst: vi.fn(), update: vi.fn().mockResolvedValue({}) },
      diagnosticRunQuery: { findFirst: vi.fn() },
    }
    prisma.diagnosticRun.findFirst.mockResolvedValue({
      id: 'run-1', status: 'RUNNING',
      brandSnapshot: { brandName: 'Test' },
      competitorSnapshot: [],
      platformSnapshot: ['deepseek'],
      samplingSnapshot: { samplesPerQuery: 1, locale: 'zh-CN', timezone: 'Asia/Shanghai' },
    })
    prisma.diagnosticSample.findFirst.mockResolvedValue({
      id: 's-1', runId: 'run-1', platform: 'deepseek', status: 'PENDING', attemptCount: 0,
    })
    prisma.diagnosticRunQuery.findFirst.mockResolvedValue({
      id: 'rq-1', queryText: 'test query',
    })

    const registry = { get: vi.fn().mockReturnValue({ name: 'deepseek', query: vi.fn().mockRejectedValue({ status: 401, message: 'Unauthorized' }) }) }
    const analyzeCitation = vi.fn()

    const worker = createSampleWorker({ registry: registry as any, analyzeCitation, boss: boss as any, prisma })
    const result = await worker.process({ sampleId: 's-1', runId: 'run-1' })

    expect(result.status).toBe('FAILED')
    expect(result.retryable).toBe(false)
  })
})
