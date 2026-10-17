import { describe, it, expect, vi, beforeEach } from 'vitest'
import { citationRouter } from './router.js'

function createCaller(ctx: any) {
  return citationRouter.createCaller(ctx)
}

describe('citation router', () => {
  const mockMonitor = { runOnce: vi.fn().mockResolvedValue([{ id: 'ev1' }]) }
  const mockQueryLibrary = {
    listActive: vi.fn().mockResolvedValue([{ id: 'q1' }]),
    addQuery: vi.fn().mockResolvedValue({ id: 'q2' }),
    generateQueries: vi.fn().mockResolvedValue([{ id: 'q3' }]),
  }
  const mockPrisma = {
    citationEvent: {
      findMany: vi.fn().mockResolvedValue([
        { platform: 'openai', brandMentioned: true, sovScore: 0.5, capturedAt: new Date() },
      ]),
    },
  }

  const ctx = {
    workspace: { id: 'w1', defaultBrandName: 'zoomer AI', status: 'ACTIVE' },
    // 任务 9：Context 双通道形状——补 actor/requestMeta mock 字段（x-geo-csrf 供 mutation 放行）
    actor: { kind: 'apiKey', credential: { id: 'cred-1', workspaceId: 'w1' } },
    requestMeta: { ip: '127.0.0.1', requestId: 'req-1', headers: { 'x-geo-csrf': 'test' } },
    services: {
      monitor: mockMonitor,
      queryLibrary: mockQueryLibrary,
      prisma: mockPrisma,
    },
  } as any

  beforeEach(() => vi.clearAllMocks())

  it('trackQuery 触发监测', async () => {
    const caller = createCaller(ctx)
    const result = await caller.trackQuery({
      query: 'AI设计工具',
      brand: 'zoomer AI',
      platforms: ['openai'],
    })
    expect(mockMonitor.runOnce).toHaveBeenCalled()
    expect(result.events).toHaveLength(1)
  })

  it('queries.add 添加 query', async () => {
    const caller = createCaller(ctx)
    await caller.queries.add({
      queryText: '新 query',
      source: 'manual',
    })
    expect(mockQueryLibrary.addQuery).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w1', queryText: '新 query' }),
    )
  })

  it('getReport 返回时间范围内事件', async () => {
    const caller = createCaller(ctx)
    const result = await caller.getReport({
      dateRange: { start: '2026-06-01', end: '2026-06-13' },
    })
    expect(mockPrisma.citationEvent.findMany).toHaveBeenCalled()
    expect(result.events).toHaveLength(1)
  })
})
