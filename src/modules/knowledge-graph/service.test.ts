import { describe, it, expect, vi } from 'vitest'
import { createKgService } from './service.js'
import type { PrismaClient, KgEntity, KgRelation } from '@prisma/client'
import type { KgRepositoryService } from './repository.js'
import type { KgExtractorService } from './extractor.js'
import type { GraphExporterService } from './exporter.js'
import type { KgProposalSet } from './types.js'

function mockDeps() {
  const prisma = {} as PrismaClient
  // 用一个内存 store 模拟数据库：addEntity 后能被 findEntityByName 查到
  const store = new Map<string, any>()
  const repository: KgRepositoryService = {
    findEntityByName: vi.fn().mockImplementation(async (_ws: string, name: string) => store.get(name) ?? null),
    findEntityById: vi.fn(),
    findEntities: vi.fn(),
    addEntity: vi.fn().mockImplementation(async (input) => {
      const e = { id: 'new', ...input }
      store.set(input.name, e)
      return e
    }),
    mergeEntityProperties: vi.fn(),
    removeEntity: vi.fn(),
    indexEntity: vi.fn(),
    searchSimilarEntities: vi.fn().mockResolvedValue([]),
    removeEntityVector: vi.fn(),
    findRelations: vi.fn(),
    addRelation: vi.fn().mockImplementation(async (input) => ({ id: 'rel-1', ...input } as any)),
  }
  const extractor: KgExtractorService = {
    extractFromPage: vi.fn().mockResolvedValue({ proposals: {} as any, task: { id: 'task-1' } as any }),
  }
  const exporter: GraphExporterService = {
    export: vi.fn().mockResolvedValue('{"@graph":[]}'),
  }
  return { prisma, repository, extractor, exporter }
}

describe('KgService', () => {
  it('addEntity / addRelation 透传 repository', async () => {
    const deps = mockDeps()
    const svc = createKgService(deps)
    const entity = await svc.addEntity({ workspaceId: 'w1', name: 'X', type: 'Y', properties: {} })
    expect(deps.repository.addEntity).toHaveBeenCalled()
    expect(entity.id).toBe('new')
  })

  it('removeEntity 透传 repository', async () => {
    const deps = mockDeps()
    const svc = createKgService(deps)
    await svc.removeEntity('e1')
    expect(deps.repository.removeEntity).toHaveBeenCalledWith('e1')
  })

  it('extractFromPage 透传 extractor', async () => {
    const deps = mockDeps()
    const svc = createKgService(deps)
    await svc.extractFromPage('page-1')
    expect(deps.extractor.extractFromPage).toHaveBeenCalledWith('page-1')
  })

  it('persistProposals 跳过已存在实体，持久化新实体和两端完整的关系', async () => {
    const deps = mockDeps()
    // 预设 'existing' 已存在（mockDeps 的 store 仍维护 addEntity 后的查询能力）
    ;(deps.repository.findEntityByName as any).mockImplementation(async (_ws: string, name: string) => {
      if (name === 'existing') return { id: 'ex-1', name: 'existing' }
      // 通过原始 mock 拿默认实现（从 store 查）
      const originalImpl = (deps.repository.addEntity as any).getMockImplementation()
      // 直接读 mock 内部不可行，这里用简化方式：addEntity 把 newOne 写到 store 后再查
      return null
    })
    // 修补：让 addEntity 后 newOne 仍能查到 —— 通过同一个 findEntityByName
    ;(deps.repository.addEntity as any).mockImplementation(async (input: any) => {
      const e = { id: 'new', ...input }
      // 把 'new' 同时注入 findEntityByName 的查找路径
      ;(deps.repository.findEntityByName as any).mockImplementation(async (_ws: string, name: string) => {
        if (name === 'existing') return { id: 'ex-1', name: 'existing' }
        if (name === input.name) return e
        return null
      })
      return e
    })
    const svc = createKgService(deps)
    const proposals: KgProposalSet = {
      entities: [
        { name: 'existing', type: 'X', properties: {} },
        { name: 'newOne', type: 'Y', properties: {} },
      ],
      relations: [
        { fromName: 'existing', toName: 'newOne', relationType: 'competitor' },
        { fromName: 'missingOne', toName: 'newOne', relationType: 'competitor' },
      ],
      sourcePageUrl: 'https://x.com',
      extractedAt: '2026-06-14T00:00:00Z',
    }
    const result = await svc.persistProposals('w1', proposals)
    expect(result.entitiesCreated).toBe(1)
    expect(result.entitiesSkipped).toBe(1)
    expect(result.relationsCreated).toBe(1)
    expect(result.relationsSkipped).toBe(1)
  })

  it('listEntities / listRelations / getEntity / exportGraph 透传', async () => {
    const deps = mockDeps()
    const svc = createKgService(deps)
    await svc.listEntities('w1')
    expect(deps.repository.findEntities).toHaveBeenCalled()
    await svc.exportGraph({ workspaceId: 'w1', format: 'jsonld' })
    expect(deps.exporter.export).toHaveBeenCalled()
  })

  it('addRelation 透传时携带 workspaceId', async () => {
    const deps = mockDeps()
    const svc = createKgService(deps)
    await svc.addRelation({ workspaceId: 'w1', fromName: 'A', toName: 'B', relationType: 'competitor' })
    expect(deps.repository.addRelation).toHaveBeenCalledWith({
      workspaceId: 'w1', fromName: 'A', toName: 'B', relationType: 'competitor',
    })
  })

  it('listRelations 透传时携带 workspaceId', async () => {
    const deps = mockDeps()
    const svc = createKgService(deps)
    await svc.listRelations('w1', { fromId: 'e1' })
    expect(deps.repository.findRelations).toHaveBeenCalledWith('w1', { fromId: 'e1' })
  })

  it('getEntity 透传时携带 workspaceId', async () => {
    const deps = mockDeps()
    const svc = createKgService(deps)
    await svc.getEntity('w1', 'e1')
    expect(deps.repository.findEntityById).toHaveBeenCalledWith('w1', 'e1')
  })
})
