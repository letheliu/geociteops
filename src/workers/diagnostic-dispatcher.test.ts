import { describe, it, expect, vi } from 'vitest'
import { createDispatcher } from './diagnostic-dispatcher.js'

describe('DiagnosticDispatcher', () => {
  it('sends only PENDING samples to queue', async () => {
    const boss = { send: vi.fn() }
    const prisma: any = {
      diagnosticSample: { findMany: vi.fn() },
    }
    prisma.diagnosticSample.findMany.mockResolvedValue([
      { id: 's-1', status: 'PENDING' },
      { id: 's-2', status: 'PENDING' },
    ])

    const dispatcher = createDispatcher({ boss: boss as any, prisma })
    await dispatcher.dispatch('run-1')

    expect(boss.send).toHaveBeenCalledTimes(2)
    expect(boss.send).toHaveBeenCalledWith('diagnostic-sample-execute', { sampleId: 's-1', runId: 'run-1' })
  })

  it('skips non-PENDING samples', async () => {
    const boss = { send: vi.fn() }
    const prisma: any = {
      diagnosticSample: { findMany: vi.fn() },
    }
    // Dispatcher queries for status: 'PENDING', return empty
    prisma.diagnosticSample.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.status === 'PENDING') return []
      return []
    })

    const dispatcher = createDispatcher({ boss: boss as any, prisma })
    await dispatcher.dispatch('run-1')

    expect(boss.send).not.toHaveBeenCalled()
  })

  it('re-dispatches does not duplicate already succeeded samples', async () => {
    const boss = { send: vi.fn() }
    const prisma: any = {
      diagnosticSample: { findMany: vi.fn() },
    }
    prisma.diagnosticSample.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.status === 'PENDING') return [{ id: 's-2', status: 'PENDING' }]
      return []
    })

    const dispatcher = createDispatcher({ boss: boss as any, prisma })
    await dispatcher.dispatch('run-1')

    expect(boss.send).toHaveBeenCalledTimes(1)
    expect(boss.send).toHaveBeenCalledWith('diagnostic-sample-execute', { sampleId: 's-2', runId: 'run-1' })
  })
})
