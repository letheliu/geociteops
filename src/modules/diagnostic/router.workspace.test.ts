import { describe, it, expect, vi } from 'vitest'
import { DiagnosticError } from './errors.js'

// This test verifies that services always receive workspaceId and filter by it
describe('Workspace isolation', () => {
  it('projectService.get uses workspaceId filter', async () => {
    const prisma: any = {
      diagnosticProject: { findFirst: vi.fn().mockResolvedValue(null) },
    }
    const { createProjectService } = await import('./project-service.js')
    const svc = createProjectService({ prisma })

    await expect(svc.get('ws-1', 'project-1')).rejects.toThrow(DiagnosticError)
    expect(prisma.diagnosticProject.findFirst).toHaveBeenCalledWith({
      where: { id: 'project-1', workspaceId: 'ws-1' },
    })
  })

  it('runService.get uses workspaceId filter', async () => {
    const prisma: any = {
      diagnosticRun: { findFirst: vi.fn().mockResolvedValue(null) },
    }
    const { createRunService } = await import('./run-service.js')
    const svc = createRunService({ prisma, registry: { get: vi.fn(), getRegisteredPlatforms: vi.fn() } } as any)

    await expect(svc.get('ws-1', 'run-1')).rejects.toThrow(DiagnosticError)
    expect(prisma.diagnosticRun.findFirst).toHaveBeenCalledWith({
      where: { id: 'run-1', workspaceId: 'ws-1' },
    })
  })

  it('actionService lists filtered by workspaceId', async () => {
    const prisma: any = {
      diagnosticAction: { findMany: vi.fn().mockResolvedValue([]) },
    }
    const { createActionService } = await import('./action-service.js')
    const svc = createActionService({ prisma, taskService: {} as any } as any)

    await svc.list('ws-1', 'run-1')
    expect(prisma.diagnosticAction.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1', runId: 'run-1' },
      orderBy: [{ horizon: 'asc' }, { priority: 'asc' }],
    })
  })

  it('reportService.get throws NOT_FOUND for wrong workspace', async () => {
    const prisma: any = {
      diagnosticRun: { findFirst: vi.fn().mockResolvedValue(null) },
    }
    const { createReportService } = await import('./report-service.js')
    const svc = createReportService({ prisma } as any)

    await expect(svc.get('ws-2', 'run-1')).rejects.toThrow(DiagnosticError)
  })
})
