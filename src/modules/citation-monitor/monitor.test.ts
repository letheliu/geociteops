import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMonitor } from './monitor.js'
import type { PlatformResult } from './platform-adapters/types.js'

function mockPrisma() {
  return {
    citationEvent: {
      create: vi.fn().mockImplementation(async (args: any) => ({
        id: 'ev-1',
        ...args.data,
      })),
    },
    workspace: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'w1',
        defaultBrandName: 'zoomer AI',
        domain: 'zoomer.top',
        platformConfig: {
          openai: { OPENAI_API_KEY: 'sk-test' },
        },
      }),
    },
  } as any
}

function mockQueryLibrary(queries: any[]) {
  return {
    listActive: vi.fn().mockResolvedValue(queries),
    addQuery: vi.fn(),
    pauseQuery: vi.fn(),
    deleteQuery: vi.fn(),
    generateQueries: vi.fn(),
  } as any
}

function mockAdapter(result: PlatformResult) {
  return {
    name: 'openai',
    query: vi.fn().mockResolvedValue(result),
  } as any
}

describe('monitor', () => {
  let prisma: ReturnType<typeof mockPrisma>

  beforeEach(() => {
    prisma = mockPrisma()
  })

  it('对每个 query 调用 adapter 并写入 CitationEvent', async () => {
    const queries = [
      { id: 'q1', workspaceId: 'w1', queryText: 'AI设计工具', status: 'ACTIVE' },
    ]
    const adapter = mockAdapter({
      answer: '推荐 zoomer AI',
      sourceCitations: [],
      groundingSources: [],
      answerMentions: [],
    })
    const registry = { get: vi.fn().mockReturnValue(adapter), list: vi.fn().mockReturnValue(['openai']) } as any
    const monitor = createMonitor({
      prisma,
      registry,
      queryLibrary: mockQueryLibrary(queries),
      competitors: ['figma'],
    })

    const events = await monitor.runOnce({ workspaceId: 'w1', platforms: ['openai'] })

    expect(events).toHaveLength(1)
    expect(adapter.query).toHaveBeenCalledWith('AI设计工具', { OPENAI_API_KEY: 'sk-test' })
    expect(prisma.citationEvent.create).toHaveBeenCalled()
    const data = prisma.citationEvent.create.mock.calls[0][0].data
    expect(data.workspaceId).toBe('w1')
    expect(data.queryId).toBe('q1')
    expect(data.platform).toBe('openai')
    expect(data.brandMentioned).toBe(true)
    expect(data.sovScore).toBe(1)
  })

  it('注入 resolveConfig 时，adapter 凭证来自解密后的配置', async () => {
    const queries = [
      { id: 'q1', workspaceId: 'w1', queryText: 'AI设计工具', status: 'ACTIVE' },
    ]
    const adapter = mockAdapter({
      answer: '推荐 zoomer AI',
      sourceCitations: [],
      groundingSources: [],
      answerMentions: [],
    })
    const registry = { get: vi.fn().mockReturnValue(adapter), list: vi.fn().mockReturnValue(['openai']) } as any
    const resolveConfig = vi.fn().mockResolvedValue({
      openai: { OPENAI_API_KEY: 'sk-decrypted' },
      competitors: ['figma'],
    })
    const monitor = createMonitor({
      prisma,
      registry,
      queryLibrary: mockQueryLibrary(queries),
      competitors: [],
      resolveConfig,
    })

    await monitor.runOnce({ workspaceId: 'w1', platforms: ['openai'] })

    expect(resolveConfig).toHaveBeenCalledWith('w1')
    // 凭证来自 resolveConfig 返回的解密对象，而非库里的密文 platformConfig
    expect(adapter.query).toHaveBeenCalledWith('AI设计工具', { OPENAI_API_KEY: 'sk-decrypted' })
    // competitors 读取路径不变：解密配置中的 competitors 参与合并
    const data = prisma.citationEvent.create.mock.calls[0][0].data
    expect(data.competitors).toEqual(
      expect.arrayContaining([expect.objectContaining({ brand: 'figma' })])
    )
  })

  it('adapter 抛错时记录失败但不中断整体', async () => {
    const queries = [
      { id: 'q1', workspaceId: 'w1', queryText: 'Q1', status: 'ACTIVE' },
      { id: 'q2', workspaceId: 'w1', queryText: 'Q2', status: 'ACTIVE' },
    ]
    const failing = { name: 'openai', query: vi.fn().mockRejectedValue(new Error('boom')) } as any
    const registry = { get: vi.fn().mockReturnValue(failing), list: vi.fn().mockReturnValue(['openai']) } as any
    const monitor = createMonitor({
      prisma,
      registry,
      queryLibrary: mockQueryLibrary(queries),
      competitors: [],
    })

    const events = await monitor.runOnce({ workspaceId: 'w1', platforms: ['openai'] })
    expect(events).toHaveLength(0)
    expect(failing.query).toHaveBeenCalledTimes(2)
  })

  it('写入新增的 source citation 字段', async () => {
    const queries = [
      { id: 'q1', workspaceId: 'w1', queryText: 'AI设计工具', status: 'ACTIVE' },
    ]
    const adapter = mockAdapter({
      answer: 'Notion 和 zoomer AI 都可以考虑',
      sourceCitations: [
        { url: 'https://notion.so', position: 1, sourceType: 'api_citation' },
        { url: 'https://zoomer.top/features', position: 2, sourceType: 'api_citation' },
      ],
      groundingSources: [],
      answerMentions: [],
    })
    const registry = { get: vi.fn().mockReturnValue(adapter), list: vi.fn().mockReturnValue(['openai']) } as any
    const monitor = createMonitor({
      prisma,
      registry,
      queryLibrary: mockQueryLibrary(queries),
      competitors: ['Notion'],
    })

    await monitor.runOnce({ workspaceId: 'w1', platforms: ['openai'] })

    const data = prisma.citationEvent.create.mock.calls[0][0].data
    expect(data.brandSourceCited).toBe(true)
    expect(data.sourceRank).toBe(2)
    expect(data.sourceCitations).toHaveLength(2)
    expect(data.groundingSources).toEqual([])
    expect(data.analysis).toBeDefined()
  })
})
