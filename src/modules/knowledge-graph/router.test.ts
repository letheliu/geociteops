import { describe, it, expect, vi } from 'vitest'
import { kgRouter } from './router.js'

function mockCtx(services: any, workspaceId = 'w1') {
  // 任务 9：Context 双通道形状——补 actor/requestMeta/status mock 字段
  return {
    workspace: { id: workspaceId, status: 'ACTIVE' },
    actor: { kind: 'apiKey', credential: { id: 'cred-1', workspaceId } },
    requestMeta: { ip: '127.0.0.1', requestId: 'req-1', headers: { 'x-geo-csrf': 'test' } },
    services,
  } as any
}

describe('kgRouter', () => {
  const kg = {
    addEntity: vi.fn().mockResolvedValue({ id: 'e1' }),
    addRelation: vi.fn().mockResolvedValue({ id: 'r1' }),
    removeEntity: vi.fn().mockResolvedValue(undefined),
    listEntities: vi.fn().mockResolvedValue([]),
    listRelations: vi.fn().mockResolvedValue([]),
    getEntity: vi.fn().mockResolvedValue(null),
    extractFromPage: vi.fn().mockResolvedValue({ id: 'task-1' }),
    exportGraph: vi.fn().mockResolvedValue('{}'),
  }
  const services = { kg }

  it('addEntity 路由注入 workspaceId', async () => {
    const caller = kgRouter.createCaller(mockCtx(services))
    await caller.addEntity({ name: 'X', type: 'Y', properties: {} })
    expect(kg.addEntity).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', name: 'X' }))
  })

  it('addRelation 路由注入 workspaceId', async () => {
    const caller = kgRouter.createCaller(mockCtx(services))
    await caller.addRelation({ fromName: 'A', toName: 'B', relationType: 'competitor' })
    expect(kg.addRelation).toHaveBeenCalledWith({ workspaceId: 'w1', fromName: 'A', toName: 'B', relationType: 'competitor' })
  })

  it('removeEntity 路由', async () => {
    const caller = kgRouter.createCaller(mockCtx(services))
    await caller.removeEntity({ id: 'e1' })
    expect(kg.removeEntity).toHaveBeenCalledWith('e1')
  })

  it('listEntities 路由注入 workspaceId', async () => {
    const caller = kgRouter.createCaller(mockCtx(services))
    await caller.listEntities({ type: 'SoftwareApplication' })
    expect(kg.listEntities).toHaveBeenCalledWith('w1', { type: 'SoftwareApplication' })
  })

  it('listRelations 路由注入 workspaceId', async () => {
    const caller = kgRouter.createCaller(mockCtx(services))
    await caller.listRelations({ fromId: 'e1' })
    expect(kg.listRelations).toHaveBeenCalledWith('w1', { fromId: 'e1' })
  })

  it('getEntity 路由注入 workspaceId', async () => {
    const caller = kgRouter.createCaller(mockCtx(services))
    await caller.getEntity({ id: 'e1' })
    expect(kg.getEntity).toHaveBeenCalledWith('w1', 'e1')
  })

  it('extractFromPage 路由', async () => {
    const caller = kgRouter.createCaller(mockCtx(services))
    await caller.extractFromPage({ pageId: 'page-1' })
    expect(kg.extractFromPage).toHaveBeenCalledWith('page-1')
  })

  it('export 路由', async () => {
    const caller = kgRouter.createCaller(mockCtx(services))
    await caller.export({ format: 'jsonld' })
    expect(kg.exportGraph).toHaveBeenCalledWith({ workspaceId: 'w1', format: 'jsonld', entityIds: undefined })
  })
})
