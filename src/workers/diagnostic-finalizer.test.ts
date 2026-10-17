import { describe, it, expect, vi } from 'vitest'
import { createFinalizer } from './diagnostic-finalizer.js'

function mockPrisma() {
  return {
    diagnosticSample: { groupBy: vi.fn() },
    diagnosticRun: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    diagnosticFinding: { createMany: vi.fn() },
    diagnosticAction: { createMany: vi.fn() },
  } as any
}

describe('DiagnosticFinalizer', () => {
  it('sets COMPLETED when all samples succeeded', async () => {
    const prisma = mockPrisma()
    prisma.diagnosticSample.groupBy.mockResolvedValue([
      { status: 'SUCCEEDED', _count: { id: 10 } },
    ])
    prisma.diagnosticRun.findFirst.mockResolvedValue({
      id: 'run-1', totalUnits: 10, status: 'RUNNING',
    })
    prisma.diagnosticRun.update.mockResolvedValue({ id: 'run-1', status: 'COMPLETED' })

    const finalizer = createFinalizer({ prisma } as any)
    const result = await finalizer.finalize('run-1')

    expect(result.status).toBe('COMPLETED')
    expect(prisma.diagnosticRun.updateMany).toHaveBeenCalled()
  })

  it('sets PARTIAL when some samples succeeded', async () => {
    const prisma = mockPrisma()
    prisma.diagnosticSample.groupBy.mockResolvedValue([
      { status: 'SUCCEEDED', _count: { id: 6 } },
      { status: 'FAILED', _count: { id: 4 } },
    ])
    prisma.diagnosticRun.findFirst.mockResolvedValue({
      id: 'run-1', totalUnits: 10, status: 'RUNNING',
    })
    prisma.diagnosticRun.update.mockResolvedValue({ id: 'run-1', status: 'PARTIAL' })

    const finalizer = createFinalizer({ prisma } as any)
    const result = await finalizer.finalize('run-1')

    expect(result.status).toBe('PARTIAL')
  })

  it('sets FAILED when all samples failed', async () => {
    const prisma = mockPrisma()
    prisma.diagnosticSample.groupBy.mockResolvedValue([
      { status: 'FAILED', _count: { id: 10 } },
    ])
    prisma.diagnosticRun.findFirst.mockResolvedValue({
      id: 'run-1', totalUnits: 10, status: 'RUNNING',
    })
    prisma.diagnosticRun.update.mockResolvedValue({ id: 'run-1', status: 'FAILED' })

    const finalizer = createFinalizer({ prisma } as any)
    const result = await finalizer.finalize('run-1')

    expect(result.status).toBe('FAILED')
  })

  it('exits early if samples still running', async () => {
    const prisma = mockPrisma()
    prisma.diagnosticSample.groupBy.mockResolvedValue([
      { status: 'SUCCEEDED', _count: { id: 5 } },
      { status: 'RUNNING', _count: { id: 3 } },
      { status: 'PENDING', _count: { id: 2 } },
    ])
    prisma.diagnosticRun.findFirst.mockResolvedValue({
      id: 'run-1', totalUnits: 10, status: 'RUNNING',
    })

    const finalizer = createFinalizer({ prisma } as any)
    const result = await finalizer.finalize('run-1')

    expect(result).toBeNull()
    expect(prisma.diagnosticRun.update).not.toHaveBeenCalled()
  })
})
