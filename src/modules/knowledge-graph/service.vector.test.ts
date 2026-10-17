import { describe, it, expect, vi } from 'vitest'
import { createKgService } from './service.js'
import type { PrismaClient, KgEntity } from '@prisma/client'
import type { LlmProvider } from '../../core/llm/types.js'
import type { KgRepositoryService } from './repository.js'
import type { KgExtractorService } from './extractor.js'
import type { GraphExporterService } from './exporter.js'

function mockLlm(): LlmProvider {
  return {
    name: 'mock',
    chat: vi.fn(),
    embed: vi.fn().mockResolvedValue([0.5]),
    embedBatch: vi.fn(),
  }
}

/** 构造可控的 repository mock：可控制 searchSimilarEntities 返回、findEntityById 回填。 */
function mockDeps(overrides: Partial<{
  searchHits: (name: string) => any[]
}> = {}) {
  const store = new Map<string, KgEntity>()
  const byId = new Map<string, KgEntity>()

  const repository: KgRepositoryService = {
    findEntityByName: vi.fn(async (_ws: string, name: string) => store.get(name) ?? null),
    findEntityById: vi.fn(async (_ws: string, id: string) => byId.get(id) ?? null),
    findEntities: vi.fn(),
    addEntity: vi.fn(async (input: any) => {
      const e = { id: `e-${store.size + 1}`, ...input } as KgEntity
      store.set(input.name, e)
      byId.set(e.id, e)
      return e
    }),
    mergeEntityProperties: vi.fn(async (id: string, props: Record<string, unknown>) => {
      const e = byId.get(id)!
      const merged = { ...(e.properties as any), ...props }
      const updated = { ...e, properties: merged }
      byId.set(id, updated)
      store.set(updated.name, updated)
      return updated
    }),
    removeEntity: vi.fn(),
    indexEntity: vi.fn(),
    searchSimilarEntities: vi.fn(async (_ws: string, _v: number[], _topK: number) => overrides.searchHits?.('') ?? []),
    removeEntityVector: vi.fn(),
    findRelations: vi.fn(),
    addRelation: vi.fn(async (input: any) => ({ id: 'rel-1', ...input } as any)),
  }
  return {
    prisma: {} as PrismaClient,
    repository,
    extractor: { extractFromPage: vi.fn() } as unknown as KgExtractorService,
    exporter: { export: vi.fn() } as unknown as GraphExporterService,
    // 辅助：直接往 store 注入已存在实体
    seedEntity(name: string, id: string) {
      const e = { id, workspaceId: 'w1', name, type: 'T', properties: { seeded: true } } as KgEntity
      store.set(name, e)
      byId.set(id, e)
      return e
    },
    store,
    byId,
  }
}

describe('KgService 实体消歧（落点 C）', () => {
  it('精确名已存在 → action=exists，不新建不索引', async () => {
    const llm = mockLlm()
    const deps = mockDeps()
    deps.seedEntity('GPT-4', 'e-existing')

    const svc = createKgService({ ...deps, llm })
    const entity = await svc.addEntity({ workspaceId: 'w1', name: 'GPT-4', type: 'Model', properties: {} })

    expect(entity.id).toBe('e-existing')
    // 精确命中后不应再走向量召回 / 新建 / 索引
    expect(deps.repository.searchSimilarEntities).not.toHaveBeenCalled()
    expect(deps.repository.addEntity).not.toHaveBeenCalled()
    expect(deps.repository.indexEntity).not.toHaveBeenCalled()
  })

  it('无精确名但有高相似度实体 → 合并 properties（异名同义消歧）', async () => {
    const llm = mockLlm()
    const deps = mockDeps({
      // 模拟向量召回命中已有实体 e-1，相似度 0.92（>= 阈值 0.85）
      searchHits: () => [{ id: 'e-1', score: 0.92, metadata: { workspaceId: 'w1' } }],
    })
    deps.seedEntity('OpenAI GPT-4', 'e-1')

    const svc = createKgService({ ...deps, llm })
    const proposals = {
      entities: [{ name: 'GPT4', type: 'Model', properties: { alias: 'GPT-4' } }],
      relations: [],
      sourcePageUrl: 'https://x.com',
      extractedAt: '2026-06-14T00:00:00Z',
    } as any

    const result = await svc.persistProposals('w1', proposals)
    expect(result.entitiesMerged).toBe(1)
    expect(result.entitiesCreated).toBe(0)
    // 合并调用，且未新建
    expect(deps.repository.mergeEntityProperties).toHaveBeenCalledWith('e-1', { alias: 'GPT-4' })
    expect(deps.repository.addEntity).not.toHaveBeenCalled()
  })

  it('相似度低于阈值 → 新建并索引（视为不同实体）', async () => {
    const llm = mockLlm()
    const deps = mockDeps({
      searchHits: () => [{ id: 'e-1', score: 0.6, metadata: {} }], // 0.6 < 0.85
    })

    const svc = createKgService({ ...deps, llm })
    const entity = await svc.addEntity({ workspaceId: 'w1', name: 'NewEntity', type: 'T', properties: {} })

    expect(entity.id).toMatch(/^e-/)
    expect(deps.repository.addEntity).toHaveBeenCalled()
    // 新建后用 name embed 并索引
    expect(llm.embed).toHaveBeenCalledWith('NewEntity')
    expect(deps.repository.indexEntity).toHaveBeenCalled()
  })

  it('无 llm 时退回原行为：精确名查重，未命中直接新建', async () => {
    const deps = mockDeps()
    const svc = createKgService(deps) // 无 llm
    const entity = await svc.addEntity({ workspaceId: 'w1', name: 'X', type: 'T', properties: {} })

    expect(entity.id).toMatch(/^e-/)
    expect(deps.repository.searchSimilarEntities).not.toHaveBeenCalled()
    expect(deps.repository.indexEntity).not.toHaveBeenCalled()
  })

  it('embed 失败时容错：退回直接新建，不阻塞', async () => {
    const llm: LlmProvider = {
      name: 'm', chat: vi.fn(),
      embed: vi.fn().mockRejectedValue(new Error('embedding API down')),
      embedBatch: vi.fn(),
    }
    const deps = mockDeps()
    const svc = createKgService({ ...deps, llm })

    const entity = await svc.addEntity({ workspaceId: 'w1', name: 'X', type: 'T', properties: {} })
    expect(entity.id).toMatch(/^e-/)
    expect(deps.repository.addEntity).toHaveBeenCalled()
  })

  it('removeEntity 同步删除向量库记录', async () => {
    const deps = mockDeps()
    const svc = createKgService(deps)
    await svc.removeEntity('e-9')
    expect(deps.repository.removeEntityVector).toHaveBeenCalledWith('e-9')
    expect(deps.repository.removeEntity).toHaveBeenCalledWith('e-9')
  })
})
