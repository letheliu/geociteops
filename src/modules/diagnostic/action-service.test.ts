import { describe, it, expect, vi } from 'vitest'
import { createActionService } from './action-service.js'
import { DiagnosticError } from './errors.js'
import {
  OptimizationsNotAllowedError,
  OPTIMIZATIONS_DENIED_MESSAGE,
} from '../../platform/billing/entitlement-guard.js'

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

// ---------------------------------------------------------------------------
// M2 §3.3 优化门禁：actions.convert 入口。断言在写库前拒绝——
// taskService.create 零调用、action 状态零改写、事务零开启。
// ---------------------------------------------------------------------------

describe('ActionService 优化门禁（M2 §3.3）', () => {
  function deniedDeps() {
    const taskService: any = { create: vi.fn().mockResolvedValue({ id: 'task-1' }) }
    const prisma: any = {
      workspace: { findUnique: vi.fn(async () => ({ id: 'ws-1', organizationId: 'org-trial' })) },
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
      $transaction: vi.fn().mockImplementation(async (fn: any) => fn(prisma)),
    }
    const guard = {
      assertOptimizationsAllowed: vi.fn(async () => {
        throw new OptimizationsNotAllowedError('org-trial')
      }),
    }
    const billing: any = { guard, meter: {} }
    return { prisma, taskService, guard, svc: createActionService({ prisma, taskService, billing }) }
  }

  it('被拒：不建任务、不改 action 状态、不开事务', async () => {
    const { svc, prisma, taskService, guard } = deniedDeps()
    await expect(svc.convert('ws-1', 'action-1')).rejects.toThrow(OPTIMIZATIONS_DENIED_MESSAGE)
    expect(guard.assertOptimizationsAllowed).toHaveBeenCalledWith('org-trial')
    expect(taskService.create).not.toHaveBeenCalled()
    expect(prisma.diagnosticAction.update).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('放行：正常建任务并改写 action 状态', async () => {
    const { prisma, taskService } = deniedDeps()
    const guard = { assertOptimizationsAllowed: vi.fn(async () => {}) }
    const svc = createActionService({ prisma, taskService, billing: { guard, meter: {} } as any })
    const result = await svc.convert('ws-1', 'action-1')
    expect(result.optimizationTaskId).toBe('task-1')
    expect(taskService.create).toHaveBeenCalled()
  })
})
