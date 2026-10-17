import { describe, it, expect, vi } from 'vitest'
import { createActionService } from './action-service.js'
import { DiagnosticError } from './errors.js'

describe('ActionService', () => {
  it('lists actions filtered by workspace', async () => {
    const prisma: any = {
      diagnosticAction: { findMany: vi.fn().mockResolvedValue([]) },
    }
    const svc = createActionService({ prisma, taskService: {} as any } as any)
    await svc.list('ws-1', 'run-1')
    expect(prisma.diagnosticAction.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1', runId: 'run-1' },
      orderBy: [{ horizon: 'asc' }, { priority: 'asc' }],
    })
  })

  it('accepts PROPOSED action', async () => {
    const prisma: any = {
      diagnosticAction: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'action-1', workspaceId: 'ws-1', runId: 'run-1', status: 'PROPOSED',
        }),
        update: vi.fn().mockResolvedValue({ id: 'action-1', status: 'ACCEPTED' }),
      },
    }
    const svc = createActionService({ prisma, taskService: {} as any } as any)
    const result = await svc.accept('ws-1', 'action-1')
    expect(result.status).toBe('ACCEPTED')
  })

  it('rejects accepting non-PROPOSED action', async () => {
    const prisma: any = {
      diagnosticAction: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'action-1', workspaceId: 'ws-1', status: 'CONVERTED',
        }),
      },
    }
    const svc = createActionService({ prisma, taskService: {} as any } as any)
    await expect(svc.accept('ws-1', 'action-1')).rejects.toThrow()
  })

  it('dismisses action', async () => {
    const prisma: any = {
      diagnosticAction: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'action-1', workspaceId: 'ws-1', status: 'PROPOSED',
        }),
        update: vi.fn().mockResolvedValue({ id: 'action-1', status: 'DISMISSED' }),
      },
    }
    const svc = createActionService({ prisma, taskService: {} as any } as any)
    const result = await svc.dismiss('ws-1', 'action-1', 'not needed')
    expect(result.status).toBe('DISMISSED')
  })

  it('converts ACCEPTED action to OptimizationTask', async () => {
    const taskService: any = {
      create: vi.fn().mockResolvedValue({ id: 'task-1' }),
    }
    const prisma: any = {
      diagnosticAction: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'action-1', workspaceId: 'ws-1', runId: 'run-1',
          status: 'ACCEPTED', actionType: 'OPTIMIZE_EXISTING_PAGE',
          targetPageUrl: 'https://example.com/page',
          targetRunQueryIds: ['rq-1'],
          optimizationTaskId: null,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn().mockImplementation(async (fn: any) => {
        if (typeof fn === 'function') return fn(prisma)
        return fn
      }),
    }
    const svc = createActionService({ prisma, taskService } as any)
    const result = await svc.convert('ws-1', 'action-1')
    expect(result.optimizationTaskId).toBe('task-1')
    expect(taskService.create).toHaveBeenCalled()
  })

  it('rejects converting non-ACCEPTED action', async () => {
    const prisma: any = {
      diagnosticAction: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'action-1', workspaceId: 'ws-1', status: 'PROPOSED',
        }),
      },
    }
    const svc = createActionService({ prisma, taskService: {} as any } as any)
    await expect(svc.convert('ws-1', 'action-1')).rejects.toThrow()
  })

  it('is idempotent for already converted action', async () => {
    const prisma: any = {
      diagnosticAction: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'action-1', workspaceId: 'ws-1', status: 'CONVERTED',
          optimizationTaskId: 'task-1',
        }),
      },
    }
    const svc = createActionService({ prisma, taskService: {} as any } as any)
    const result = await svc.convert('ws-1', 'action-1')
    expect(result.optimizationTaskId).toBe('task-1')
  })
})
