import { describe, it, expect, vi } from 'vitest'
import { diagnosticRouter } from './router.js'

function mockServices() {
  return {
    diagnostic: {
      projectService: {
        list: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue({ id: 'p-1' }),
        create: vi.fn().mockResolvedValue({ id: 'p-1' }),
        update: vi.fn().mockResolvedValue({ id: 'p-1' }),
        activate: vi.fn().mockResolvedValue({ id: 'p-1', status: 'ACTIVE' }),
        archive: vi.fn().mockResolvedValue({ id: 'p-1', status: 'ARCHIVED' }),
      },
      queryPlanner: {
        list: vi.fn().mockResolvedValue([]),
        generate: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: 'q-1' }),
        update: vi.fn().mockResolvedValue({ id: 'q-1' }),
        bulkConfirm: vi.fn().mockResolvedValue(2),
        disable: vi.fn().mockResolvedValue({ id: 'q-1', status: 'DISABLED' }),
        findSimilar: vi.fn().mockResolvedValue([]),
      },
      runService: {
        list: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue({ id: 'r-1' }),
        createDraft: vi.fn().mockResolvedValue({ id: 'r-1', status: 'DRAFT' }),
        updateDraft: vi.fn().mockResolvedValue({ id: 'r-1' }),
        validate: vi.fn().mockResolvedValue({ valid: true, errors: [], warnings: [], totalUnits: 10 }),
        markReady: vi.fn().mockResolvedValue({ id: 'r-1', status: 'READY' }),
        start: vi.fn().mockResolvedValue({ id: 'r-1', status: 'RUNNING' }),
        cancel: vi.fn().mockResolvedValue({ id: 'r-1', status: 'CANCELLED' }),
        retryDispatch: vi.fn().mockResolvedValue({}),
        retryFailed: vi.fn().mockResolvedValue({}),
        createRetest: vi.fn().mockResolvedValue({ id: 'r-2', runType: 'RETEST' }),
      },
      reportService: {
        get: vi.fn().mockResolvedValue({ runId: 'r-1', metrics: {} }),
        compare: vi.fn().mockResolvedValue({ strictlyComparable: true }),
      },
      actionService: {
        list: vi.fn().mockResolvedValue([]),
        accept: vi.fn().mockResolvedValue({ id: 'a-1', status: 'ACCEPTED' }),
        dismiss: vi.fn().mockResolvedValue({ id: 'a-1', status: 'DISMISSED' }),
        convert: vi.fn().mockResolvedValue({ id: 'a-1', status: 'CONVERTED', optimizationTaskId: 'task-1' }),
      },
    },
  }
}

describe('DiagnosticRouter', () => {
  it('projects.list injects workspaceId', async () => {
    const services = mockServices()
    const caller = diagnosticRouter.createCaller({
      workspace: { id: 'ws-1', status: 'ACTIVE' },
      // 任务 9：Context 双通道形状——补 actor/requestMeta mock 字段
      actor: { kind: 'apiKey', credential: { id: 'cred-1', workspaceId: 'ws-1' } },
      requestMeta: { ip: '127.0.0.1', requestId: 'req-1', headers: { 'x-geo-csrf': 'test' } },
      services,
    } as any)
    await caller.projects.list({})
    expect(services.diagnostic.projectService.list).toHaveBeenCalledWith('ws-1', undefined)
  })

  it('projects.create validates input', async () => {
    const services = mockServices()
    const caller = diagnosticRouter.createCaller({
      workspace: { id: 'ws-1', status: 'ACTIVE' },
      // 任务 9：Context 双通道形状——补 actor/requestMeta mock 字段
      actor: { kind: 'apiKey', credential: { id: 'cred-1', workspaceId: 'ws-1' } },
      requestMeta: { ip: '127.0.0.1', requestId: 'req-1', headers: { 'x-geo-csrf': 'test' } },
      services,
    } as any)
    const result = await caller.projects.create({ name: 'Test', brandName: 'Acme', targetAudiences: ['devs'], coreScenarios: ['search'] })
    expect(result.id).toBe('p-1')
  })

  it('queries.bulkConfirm injects workspaceId', async () => {
    const services = mockServices()
    const caller = diagnosticRouter.createCaller({
      workspace: { id: 'ws-1', status: 'ACTIVE' },
      // 任务 9：Context 双通道形状——补 actor/requestMeta mock 字段
      actor: { kind: 'apiKey', credential: { id: 'cred-1', workspaceId: 'ws-1' } },
      requestMeta: { ip: '127.0.0.1', requestId: 'req-1', headers: { 'x-geo-csrf': 'test' } },
      services,
    } as any)
    await caller.queries.bulkConfirm({ projectId: 'p-1', queryIds: ['q1', 'q2'] })
    expect(services.diagnostic.queryPlanner.bulkConfirm).toHaveBeenCalledWith('ws-1', 'p-1', ['q1', 'q2'])
  })

  it('runs.validate injects workspaceId', async () => {
    const services = mockServices()
    const caller = diagnosticRouter.createCaller({
      workspace: { id: 'ws-1', status: 'ACTIVE' },
      // 任务 9：Context 双通道形状——补 actor/requestMeta mock 字段
      actor: { kind: 'apiKey', credential: { id: 'cred-1', workspaceId: 'ws-1' } },
      requestMeta: { ip: '127.0.0.1', requestId: 'req-1', headers: { 'x-geo-csrf': 'test' } },
      services,
    } as any)
    await caller.runs.validate({ runId: 'r-1' })
    expect(services.diagnostic.runService.validate).toHaveBeenCalledWith('ws-1', 'r-1')
  })

  it('reports.get injects workspaceId', async () => {
    const services = mockServices()
    const caller = diagnosticRouter.createCaller({
      workspace: { id: 'ws-1', status: 'ACTIVE' },
      // 任务 9：Context 双通道形状——补 actor/requestMeta mock 字段
      actor: { kind: 'apiKey', credential: { id: 'cred-1', workspaceId: 'ws-1' } },
      requestMeta: { ip: '127.0.0.1', requestId: 'req-1', headers: { 'x-geo-csrf': 'test' } },
      services,
    } as any)
    await caller.reports.get({ runId: 'r-1' })
    expect(services.diagnostic.reportService.get).toHaveBeenCalledWith('ws-1', 'r-1')
  })

  it('actions.accept injects workspaceId', async () => {
    const services = mockServices()
    const caller = diagnosticRouter.createCaller({
      workspace: { id: 'ws-1', status: 'ACTIVE' },
      // 任务 9：Context 双通道形状——补 actor/requestMeta mock 字段
      actor: { kind: 'apiKey', credential: { id: 'cred-1', workspaceId: 'ws-1' } },
      requestMeta: { ip: '127.0.0.1', requestId: 'req-1', headers: { 'x-geo-csrf': 'test' } },
      services,
    } as any)
    await caller.actions.accept({ actionId: 'a-1' })
    expect(services.diagnostic.actionService.accept).toHaveBeenCalledWith('ws-1', 'a-1')
  })

  it('actions.convert injects workspaceId', async () => {
    const services = mockServices()
    const caller = diagnosticRouter.createCaller({
      workspace: { id: 'ws-1', status: 'ACTIVE' },
      // 任务 9：Context 双通道形状——补 actor/requestMeta mock 字段
      actor: { kind: 'apiKey', credential: { id: 'cred-1', workspaceId: 'ws-1' } },
      requestMeta: { ip: '127.0.0.1', requestId: 'req-1', headers: { 'x-geo-csrf': 'test' } },
      services,
    } as any)
    await caller.actions.convert({ actionId: 'a-1' })
    expect(services.diagnostic.actionService.convert).toHaveBeenCalledWith('ws-1', 'a-1')
  })
})
