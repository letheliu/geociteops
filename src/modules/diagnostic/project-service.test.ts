import { describe, it, expect, vi } from 'vitest'
import { createProjectService, type DiagnosticProjectServiceDeps } from './project-service.js'
import { DiagnosticError } from './errors.js'

function mockDeps(): DiagnosticProjectServiceDeps {
  const prisma = {
    diagnosticProject: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    diagnosticQuery: {
      count: vi.fn(),
    },
    diagnosticRun: {
      count: vi.fn(),
    },
  } as any
  return { prisma }
}

describe('ProjectService', () => {
  it('creates a project with normalized domain', async () => {
    const deps = mockDeps()
    const svc = createProjectService(deps)
    deps.prisma.diagnosticProject.create.mockResolvedValue({
      id: 'project-1', workspaceId: 'ws-1', name: 'Test',
      brandName: 'Acme', brandAliases: [], brandDomain: 'acme.com',
      targetAudiences: ['devs'], coreScenarios: ['search'],
      competitors: [], status: 'DRAFT',
      createdAt: new Date(), updatedAt: new Date(),
    })

    const result = await svc.create('ws-1', {
      name: 'Test', brandName: 'Acme', brandAliases: [],
      brandDomain: 'https://WWW.Acme.com/', targetAudiences: ['devs'],
      coreScenarios: ['search'], competitors: [],
    })
    expect(result.brandDomain).toBe('acme.com')
  })

  it('get queries with workspaceId filter', async () => {
    const deps = mockDeps()
    const svc = createProjectService(deps)
    deps.prisma.diagnosticProject.findFirst.mockResolvedValue(null)

    await expect(svc.get('ws-1', 'project-1')).rejects.toThrow(DiagnosticError)
    expect(deps.prisma.diagnosticProject.findFirst).toHaveBeenCalledWith({
      where: { id: 'project-1', workspaceId: 'ws-1' },
    })
  })

  it('returns NOT_FOUND for other workspace', async () => {
    const deps = mockDeps()
    const svc = createProjectService(deps)
    deps.prisma.diagnosticProject.findFirst.mockResolvedValue(null)

    await expect(svc.get('ws-1', 'project-1')).rejects.toThrow(DiagnosticError)
  })

  it('list filters by workspaceId and optional status', async () => {
    const deps = mockDeps()
    const svc = createProjectService(deps)
    deps.prisma.diagnosticProject.findMany.mockResolvedValue([])

    await svc.list('ws-1')
    expect(deps.prisma.diagnosticProject.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1' },
      orderBy: { updatedAt: 'desc' },
    })

    await svc.list('ws-1', 'ACTIVE')
    expect(deps.prisma.diagnosticProject.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1', status: 'ACTIVE' },
      orderBy: { updatedAt: 'desc' },
    })
  })

  it('update rejects if project not found', async () => {
    const deps = mockDeps()
    const svc = createProjectService(deps)
    deps.prisma.diagnosticProject.findFirst.mockResolvedValue(null)

    await expect(svc.update('ws-1', 'project-1', { name: 'New' }))
      .rejects.toThrow(DiagnosticError)
  })

  it('activate requires at least one confirmed query', async () => {
    const deps = mockDeps()
    const svc = createProjectService(deps)
    deps.prisma.diagnosticProject.findFirst.mockResolvedValue({
      id: 'project-1', workspaceId: 'ws-1', status: 'DRAFT',
    })
    deps.prisma.diagnosticQuery.count.mockResolvedValue(0)

    await expect(svc.activate('ws-1', 'project-1'))
      .rejects.toThrow('NO_CONFIRMED_QUERIES')
  })

  it('activate rejects if project has DRAFT status with no confirmed queries', async () => {
    const deps = mockDeps()
    const svc = createProjectService(deps)
    deps.prisma.diagnosticProject.findFirst.mockResolvedValue({
      id: 'project-1', workspaceId: 'ws-1', status: 'DRAFT',
    })
    deps.prisma.diagnosticQuery.count.mockResolvedValue(0)

    await expect(svc.activate('ws-1', 'project-1'))
      .rejects.toThrow('NO_CONFIRMED_QUERIES')
  })

  it('archive rejects if project has running runs', async () => {
    const deps = mockDeps()
    const svc = createProjectService(deps)
    deps.prisma.diagnosticProject.findFirst.mockResolvedValue({
      id: 'project-1', workspaceId: 'ws-1',
    })
    deps.prisma.diagnosticRun.count.mockResolvedValue(1)

    await expect(svc.archive('ws-1', 'project-1'))
      .rejects.toThrow('RUNNING')
  })

  it('archive succeeds when no running runs', async () => {
    const deps = mockDeps()
    const svc = createProjectService(deps)
    deps.prisma.diagnosticProject.findFirst.mockResolvedValue({
      id: 'project-1', workspaceId: 'ws-1',
    })
    deps.prisma.diagnosticRun.count.mockResolvedValue(0)
    deps.prisma.diagnosticProject.update.mockResolvedValue({
      id: 'project-1', status: 'ARCHIVED',
    })

    const result = await svc.archive('ws-1', 'project-1')
    expect(result).toBeDefined()
    expect(deps.prisma.diagnosticProject.update).toHaveBeenCalled()
  })
})
