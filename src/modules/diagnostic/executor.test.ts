import { describe, it, expect, vi } from 'vitest'
import { createSampleExecutor, classifySampleError } from './executor.js'

describe('Executor', () => {
  it('executes a sample successfully', async () => {
    const prisma: any = {
      diagnosticSample: { update: vi.fn().mockResolvedValue({}) },
      diagnosticRun: { findFirst: vi.fn().mockResolvedValue({ status: 'RUNNING' }) },
    }
    const registry = {
      get: vi.fn().mockReturnValue({
        name: 'deepseek',
        query: vi.fn().mockResolvedValue({
          answer: 'Zoomer is a GEO platform.',
          sourceCitations: [{ url: 'https://zoomer.ai', position: 1 }],
          groundingSources: [],
          answerMentions: [{ brand: 'Zoomer', mentioned: true, firstIndex: 0, count: 1 }],
        }),
      }),
    }
    const analyzeCitation: any = vi.fn().mockResolvedValue({
      brandMentioned: true,
      brandSourceCited: true,
      rankInAnswer: 1,
      sourceRank: 1,
      sovScore: 0.8,
      sourceCitationRate: 0.5,
      competitors: [],
    })

    const executor = createSampleExecutor({ prisma, registry, analyzeCitation } as any)

    const result = await executor.execute({
      sampleId: 's-1',
      runId: 'run-1',
      workspaceId: 'ws-1',
      platform: 'deepseek',
      queryText: 'what is Zoomer?',
      brandSnapshot: { brandName: 'Zoomer', brandAliases: [], brandDomain: 'zoomer.ai' },
      competitorSnapshot: [],
    })

    expect(result.status).toBe('SUCCEEDED')
    expect(registry.get).toHaveBeenCalledWith('deepseek')
  })

  it('classifies 429 as retryable', () => {
    const error = new Error('Too Many Requests')
    ;(error as any).status = 429
    const classified = classifySampleError(error as any)
    expect(classified.retryable).toBe(true)
    expect(classified.code).toBe('RATE_LIMITED')
  })

  it('classifies 401 as non-retryable configuration error', () => {
    const error = new Error('Unauthorized')
    ;(error as any).status = 401
    const classified = classifySampleError(error as any)
    expect(classified.retryable).toBe(false)
    expect(classified.code).toBe('CONFIGURATION_ERROR')
  })

  it('classifies 500 as retryable platform error', () => {
    const error = new Error('Internal Server Error')
    ;(error as any).status = 500
    const classified = classifySampleError(error as any)
    expect(classified.retryable).toBe(true)
    expect(classified.code).toBe('PLATFORM_ERROR')
  })

  it('classifies network timeout as retryable', () => {
    const error = new Error('connect ETIMEDOUT')
    const classified = classifySampleError(error)
    expect(classified.retryable).toBe(true)
    expect(classified.code).toBe('NETWORK_ERROR')
  })

  it('classifies unknown platform', () => {
    const error = new Error('UNSUPPORTED_PLATFORM')
    const classified = classifySampleError(error as any)
    expect(classified.retryable).toBe(false)
    expect(classified.code).toBe('UNSUPPORTED_PLATFORM')
  })

  it('handles cancelled run by skipping execution', async () => {
    const prisma: any = {
      diagnosticSample: { update: vi.fn() },
      diagnosticRun: { findFirst: vi.fn().mockResolvedValue({ status: 'CANCELLED' }) },
    }
    const registry = { get: vi.fn() }
    const analyzeCitation: any = vi.fn()

    const executor = createSampleExecutor({ prisma, registry, analyzeCitation } as any)
    const result = await executor.execute({
      sampleId: 's-1',
      runId: 'run-1',
      workspaceId: 'ws-1',
      platform: 'deepseek',
      queryText: 'test',
      brandSnapshot: { brandName: 'Test', brandAliases: [], brandDomain: '' },
      competitorSnapshot: [],
    })

    expect(result.status).toBe('CANCELLED')
  })
})
