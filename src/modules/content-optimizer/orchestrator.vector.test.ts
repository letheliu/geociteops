import { describe, it, expect, vi } from 'vitest'
import { createOrchestrator } from './orchestrator.js'
import type { LlmProvider } from '../../core/llm/types.js'
import type { VectorStore } from '../../core/vector/store.js'
import type { ScoredAtom, FaqPair } from './types.js'

function makeScoredAtom(text: string): ScoredAtom {
  return {
    text, subject: 's', predicate: 'p', object: 'o', anchors: ['1'],
    score: { total: 85, hasNumericAnchor: true, hasEntityAnchor: true, isSelfContained: true, hasDefinition: true },
  }
}

function baseDeps() {
  const atoms = [makeScoredAtom('段落A'), makeScoredAtom('段落B')]
  return {
    atomizer: { atomize: vi.fn().mockResolvedValue(atoms) },
    scoring: {
      scoreAtoms: vi.fn().mockReturnValue(atoms),
      scorePage: vi.fn().mockReturnValue(85),
      scorePageComposite: vi.fn().mockReturnValue(80),
    },
    rewriter: { rewriteBatch: vi.fn().mockImplementation(async (a: ScoredAtom[]) => a) },
    faqGenerator: { generate: vi.fn().mockResolvedValue([] as FaqPair[]) },
    taskService: { create: vi.fn().mockResolvedValue({ id: 't-1' }) },
    eeat: { score: vi.fn() },
    citability: { score: vi.fn(), scorePassages: vi.fn().mockReturnValue({ scores: [], average: 60 }) },
    prisma: {
      contentPage: { upsert: vi.fn(), findUnique: vi.fn().mockResolvedValue(null) },
      contentAtom: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
        findMany: vi.fn().mockResolvedValue([
          { id: 'atom-1', atomText: '段落A' },
          { id: 'atom-2', atomText: '段落B' },
        ]),
      },
    },
  }
}

describe('Orchestrator ContentAtom 向量化（落点 B）', () => {
  it('optimize 时把 atoms 落 PG 并批量写入向量库', async () => {
    const deps = baseDeps()
    const llm: LlmProvider = {
      name: 'm', chat: vi.fn(),
      embed: vi.fn(), embedBatch: vi.fn().mockResolvedValue([[0.1], [0.2]]),
    }
    const vector: VectorStore = {
      COLLECTIONS: { queries: 'queries', entities: 'entities', atoms: 'atoms' },
      upsert: vi.fn(),
      search: vi.fn(),
      delete: vi.fn(),
      closeAll: vi.fn(),
    }
    const orch = createOrchestrator({ ...deps, llm, vector } as any)

    await orch.optimize({ workspaceId: 'w1', content: 'x', pageId: 'page-1' })

    // PG 落库：先删后建
    expect(deps.prisma.contentAtom.deleteMany).toHaveBeenCalledWith({ where: { pageId: 'page-1' } })
    expect(deps.prisma.contentAtom.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([expect.objectContaining({ pageId: 'page-1' })]),
      }),
    )
    // 向量库：用 findMany 取回 id 后，embedBatch + 一次 upsert
    expect(llm.embedBatch).toHaveBeenCalledWith(['段落A', '段落B'])
    expect(vector.upsert).toHaveBeenCalledWith(
      'atoms',
      expect.arrayContaining([
        expect.objectContaining({ id: 'atom-1', metadata: { workspaceId: 'w1', sourceType: 'content' } }),
      ]),
    )
  })

  it('无 vector/llm 时只落 PG，不调 embedBatch', async () => {
    const deps = baseDeps()
    const llm: LlmProvider = { name: 'm', chat: vi.fn(), embed: vi.fn(), embedBatch: vi.fn() }
    const orch = createOrchestrator({ ...deps, llm } as any) // 无 vector

    await orch.optimize({ workspaceId: 'w1', content: 'x', pageId: 'page-1' })

    expect(deps.prisma.contentAtom.createMany).toHaveBeenCalled()
    expect(llm.embedBatch).not.toHaveBeenCalled()
  })

  it('embedBatch 失败不阻塞优化主流程（result 仍返回）', async () => {
    const deps = baseDeps()
    const llm: LlmProvider = {
      name: 'm', chat: vi.fn(),
      embed: vi.fn(), embedBatch: vi.fn().mockRejectedValue(new Error('embed down')),
    }
    const vector: VectorStore = {
      COLLECTIONS: { queries: 'queries', entities: 'entities', atoms: 'atoms' },
      upsert: vi.fn(), search: vi.fn(), delete: vi.fn(), closeAll: vi.fn(),
    }
    const orch = createOrchestrator({ ...deps, llm, vector } as any)

    const result = await orch.optimize({ workspaceId: 'w1', content: 'x', pageId: 'page-1' })
    expect(result.atoms).toHaveLength(2)
    expect(vector.upsert).not.toHaveBeenCalled()
  })

  it('findSimilarAtoms 调 embed + search，按 workspaceId 过滤', async () => {
    const deps = baseDeps()
    const llm: LlmProvider = {
      name: 'm', chat: vi.fn(),
      embed: vi.fn().mockResolvedValue([0.5]), embedBatch: vi.fn(),
    }
    const hits = [{ id: 'atom-9', score: 0.9, metadata: {} }]
    const vector: VectorStore = {
      COLLECTIONS: { queries: 'queries', entities: 'entities', atoms: 'atoms' },
      upsert: vi.fn(), search: vi.fn().mockResolvedValue(hits), delete: vi.fn(), closeAll: vi.fn(),
    }
    const orch = createOrchestrator({ ...deps, llm, vector } as any)

    const result = await orch.findSimilarAtoms('w1', '查询文本', 5)
    expect(llm.embed).toHaveBeenCalledWith('查询文本')
    expect(vector.search).toHaveBeenCalledWith('atoms', [0.5], 5, { workspaceId: 'w1' })
    expect(result).toBe(hits)
  })

  it('findSimilarAtoms 无 llm/vector 时抛错', async () => {
    const deps = baseDeps()
    const orch = createOrchestrator({ ...deps } as any)
    await expect(orch.findSimilarAtoms('w1', 'x')).rejects.toThrow()
  })
})
