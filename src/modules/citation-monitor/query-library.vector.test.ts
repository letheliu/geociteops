import { describe, it, expect, vi } from 'vitest'
import { createQueryLibraryService } from './query-library.js'
import type { LlmProvider } from '../../core/llm/types.js'
import type { VectorStore, SearchHit } from '../../core/vector/store.js'

/** 构造一个记录所有调用、可断言的 vector mock。 */
function mockVector(): VectorStore & { calls: Record<string, any[][]> } {
  const calls: Record<string, any[][]> = { upsert: [], search: [], delete: [] }
  return {
    COLLECTIONS: { queries: 'queries', entities: 'entities', atoms: 'atoms' },
    async upsert(collection, records) {
      calls.upsert.push([collection, records])
    },
    async search(collection, query, topK, filter) {
      calls.search.push([collection, query, topK, filter])
      return []
    },
    async delete(collection, ids) {
      calls.delete.push([collection, ids])
    },
    closeAll() {},
    calls,
  } as any
}

function mockPrisma() {
  let n = 0
  return {
    citationQuery: {
      create: vi.fn().mockImplementation(async (args: any) => ({
        id: `q-${++n}`,
        workspaceId: args.data.workspaceId,
        queryText: args.data.queryText,
        source: args.data.source,
        cluster: args.data.cluster,
        status: 'ACTIVE',
      })),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
  } as any
}

describe('query library 向量化（落点 A）', () => {
  it('addQuery 后向 queries collection 写入向量，含 workspaceId/sourceType metadata', async () => {
    const prisma = mockPrisma()
    const llm: LlmProvider = {
      name: 'mock',
      chat: vi.fn(),
      embed: vi.fn().mockResolvedValue([0.1, 0.2]),
      embedBatch: vi.fn(),
    }
    const vector = mockVector()

    const svc = createQueryLibraryService(prisma, llm, vector)
    const q = await svc.addQuery({ workspaceId: 'w1', queryText: 'AI工具', source: 'MANUAL', cluster: 'tools' })

    expect(llm.embed).toHaveBeenCalledWith('AI工具')
    expect(vector.calls.upsert).toHaveLength(1)
    expect(vector.calls.upsert[0][0]).toBe('queries')
    const rec = vector.calls.upsert[0][1][0]
    expect(rec.id).toBe(q.id)
    expect(rec.metadata).toMatchObject({ workspaceId: 'w1', sourceType: 'MANUAL', cluster: 'tools' })
  })

  it('generateQueries 用 embedBatch 一次性批量索引，非逐条 embed', async () => {
    const prisma = mockPrisma()
    const llm: LlmProvider = {
      name: 'mock',
      chat: vi.fn().mockResolvedValue({ text: JSON.stringify(['Q1', 'Q2', 'Q3']) }),
      embed: vi.fn(),
      embedBatch: vi.fn().mockResolvedValue([[0.1], [0.2], [0.3]]),
    }
    const vector = mockVector()

    const svc = createQueryLibraryService(prisma, llm, vector)
    await svc.generateQueries({ workspaceId: 'w1', topic: 'AI', count: 3 })

    // 关键：用 embedBatch 一次拿 3 个向量，upsert 一次批量写
    expect(llm.embedBatch).toHaveBeenCalledTimes(1)
    expect(llm.embedBatch).toHaveBeenCalledWith(['Q1', 'Q2', 'Q3'])
    expect(vector.calls.upsert).toHaveLength(1)
    expect(vector.calls.upsert[0][1]).toHaveLength(3)
    // embed（单条）不应被调用
    expect(llm.embed).not.toHaveBeenCalled()
  })

  it('deleteQuery 同步删除向量库记录', async () => {
    const prisma = mockPrisma()
    const llm: LlmProvider = { name: 'm', chat: vi.fn(), embed: vi.fn(), embedBatch: vi.fn() }
    const vector = mockVector()
    const svc = createQueryLibraryService(prisma, llm, vector)

    await svc.deleteQuery('q-99')
    expect(vector.calls.delete).toEqual([['queries', ['q-99']]])
  })

  it('findSimilarQueries 调用 embed + search，并按 workspaceId 过滤', async () => {
    const prisma = mockPrisma()
    const llm: LlmProvider = {
      name: 'm', chat: vi.fn(),
      embed: vi.fn().mockResolvedValue([0.5]),
      embedBatch: vi.fn(),
    }
    const hits: SearchHit[] = [{ id: 'q-1', score: 0.95, metadata: { workspaceId: 'w1' } }]
    const vector: VectorStore = {
      COLLECTIONS: { queries: 'queries', entities: 'entities', atoms: 'atoms' },
      upsert: vi.fn(),
      search: vi.fn().mockResolvedValue(hits),
      delete: vi.fn(),
      closeAll: vi.fn(),
    }
    const svc = createQueryLibraryService(prisma, llm, vector)

    const result = await svc.findSimilarQueries('w1', 'AI 设计', 5)
    expect(llm.embed).toHaveBeenCalledWith('AI 设计')
    expect(vector.search).toHaveBeenCalledWith('queries', [0.5], 5, { workspaceId: 'w1' })
    expect(result).toBe(hits)
  })

  it('embed 失败时不阻塞 addQuery（容错，query 已落 PG）', async () => {
    const prisma = mockPrisma()
    const llm: LlmProvider = {
      name: 'm', chat: vi.fn(),
      embed: vi.fn().mockRejectedValue(new Error('network down')),
      embedBatch: vi.fn(),
    }
    const vector = mockVector()
    const svc = createQueryLibraryService(prisma, llm, vector)

    // 不应抛错
    const q = await svc.addQuery({ workspaceId: 'w1', queryText: 'x', source: 'MANUAL' })
    expect(q.id).toBeDefined()
    expect(prisma.citationQuery.create).toHaveBeenCalled()
  })

  it('无 vector 参数时退回纯 PG 行为，不调用任何向量方法', async () => {
    const prisma = mockPrisma()
    const llm: LlmProvider = {
      name: 'm',
      chat: vi.fn().mockResolvedValue({ text: JSON.stringify(['Q1']) }),
      embed: vi.fn(),
      embedBatch: vi.fn(),
    }
    const svc = createQueryLibraryService(prisma, llm)
    const result = await svc.generateQueries({ workspaceId: 'w1', topic: 'AI', count: 1 })
    expect(result).toHaveLength(1)
    expect(llm.embedBatch).not.toHaveBeenCalled()
  })
})
