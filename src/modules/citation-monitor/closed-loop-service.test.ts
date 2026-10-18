import { describe, it, expect, vi } from 'vitest'
import {
  createClosedLoopService,
  PAGE_MAPPING_INVALID_MESSAGE,
  PAGE_MAPPING_MISSING_MESSAGE,
  DUPLICATE_ACTIVE_TASK_MESSAGE,
} from './closed-loop-service.js'

/** 任务服务 mock：建任务返回固定 id，更新可断言 */
function makeTaskService() {
  return {
    create: vi.fn(async (input: any) => ({ id: 'task-1', ...input })),
  } as any
}

function makePrisma(opts: {
  query?: any
  page?: any
  inFlight?: any
  baselines?: Map<string, any>
  updates?: any[]
} = {}) {
  const updates = opts.updates ?? []
  return {
    citationQuery: {
      findFirst: vi.fn(async () => opts.query ?? null),
    },
    contentPage: {
      findFirst: vi.fn(async () => opts.page ?? null),
    },
    optimizationTask: {
      findFirst: vi.fn(async () => opts.inFlight ?? null),
      update: vi.fn(async ({ data }: any) => {
        updates.push(data)
        return { id: 'task-1', status: 'PENDING', ...data }
      }),
    },
    citationRun: { findMany: vi.fn(async () => []) },
    citationEvent: { findMany: vi.fn(async () => []) },
    // loadQueryBaselines 走 prisma.citationQuery.findMany（ACTIVE 查询清单）
    _baselines: opts.baselines,
  } as any
}

/** 基线装载走 citationQuery.findMany；这里直接给一个已装配的 map */
function makePrismaWithBaseline(baseline: any, extra: Record<string, any> = {}) {
  const prisma: any = {
    citationQuery: {
      findFirst: vi.fn(async () => extra.query ?? null),
      findMany: vi.fn(async () => [
        { id: extra.query?.id ?? 'q1', queryText: 'Q', mappedPageUrl: extra.query?.mappedPageUrl ?? 'https://example.com/a' },
      ]),
    },
    contentPage: { findFirst: vi.fn(async () => extra.page ?? null) },
    optimizationTask: {
      findFirst: vi.fn(async () => extra.inFlight ?? null),
      update: vi.fn(async ({ data }: any) => ({ id: 'task-1', status: 'PENDING', ...data })),
    },
    citationRun: {
      findMany: vi.fn(async () =>
        baseline
          ? [{ id: baseline.runId, finishedAt: new Date(baseline.finishedAt), startedAt: new Date(baseline.finishedAt), status: 'COMPLETED' }]
          : [],
      ),
    },
    citationEvent: {
      findMany: vi.fn(async () => baseline?.events ?? []),
    },
  }
  return prisma
}

function makeDeps(overrides: Record<string, any> = {}) {
  const taskService = makeTaskService()
  const rewriter = {
    rewriteForQuery: vi.fn(async () => '改写后的建议稿正文'),
    rewrite: vi.fn(),
    rewriteBatch: vi.fn(),
  }
  const atomizer = {
    atomize: vi.fn(async (text: string) =>
      text === '改写后的建议稿正文'
        ? [{ text: '建议稿首段。', subject: 's', predicate: 'p', object: 'o', anchors: ['2024'] }]
        : [{ text: '原始首段。', subject: 's', predicate: 'p', object: 'o', anchors: [] }],
    ),
  }
  const citability = {
    score: vi.fn((i: any) => ({
      total: i.text.includes('建议稿') ? 80 : 40,
      lengthScore: 0, frontLoadBonus: false, hasDefinitionPattern: false, hasAttribution: false, hasUniqueData: false,
    })),
    scorePassages: vi.fn((inputs: any[]) => ({
      scores: inputs.map((i) => ({ total: i.text.includes('建议稿') ? 80 : 40 })),
      average: inputs.some((i) => i.text.includes('建议稿')) ? 80 : 40,
    })),
  }
  const prisma = overrides.prisma ?? makePrisma()
  return {
    prisma,
    deps: {
      prisma,
      taskService,
      rewriter,
      atomizer,
      citability,
      now: () => new Date('2026-10-19T00:00:00Z'),
    } as any,
    taskService,
    rewriter,
    atomizer,
    citability,
  }
}

const QUERY = { id: 'q1', queryText: 'AI 设计工具哪个好', status: 'ACTIVE', mappedPageUrl: 'https://example.com/a' }
const PAGE = { id: 'page-1', currentContent: '原始页面正文' }

const BASELINE = {
  runId: 'run-1',
  finishedAt: '2026-10-18T00:00:00.000Z',
  events: [
    {
      id: 'e1', queryId: 'q1', platform: 'openai', runId: 'run-1', status: 'OK',
      brandMentioned: false, brandSourceCited: false, rankInAnswer: null, sovScore: 0.05,
      capturedAt: new Date('2026-10-18T00:00:00.000Z'),
      competitors: [{ brand: 'Acme', mentioned: true, rank: 1 }],
    },
  ],
}

describe('closedLoop.optimizeFromWeakPoint（M2 §3.3）', () => {
  it('正常路径：建任务 + 生成建议稿 + result.context 齐备', async () => {
    const prisma = makePrismaWithBaseline(BASELINE, { query: QUERY, page: PAGE })
    const { deps, taskService, rewriter } = makeDeps({ prisma })
    const svc = createClosedLoopService(deps)

    const result = await svc.optimizeFromWeakPoint({ workspaceId: 'w1', queryId: 'q1', brand: 'zoomer AI' })

    expect(taskService.create).toHaveBeenCalledWith({
      workspaceId: 'w1',
      type: 'OPTIMIZE_FOR_QUERY',
      pageId: 'page-1',
      queryId: 'q1',
    })
    expect(rewriter.rewriteForQuery).toHaveBeenCalledWith('原始页面正文', 'AI 设计工具哪个好', 'zoomer AI')
    expect(result.suggestion).toBe('改写后的建议稿正文')

    const update = prisma.optimizationTask.update.mock.calls[0][0]
    expect(update.data.result.suggestion).toBe('改写后的建议稿正文')
    expect(update.data.result.context).toMatchObject({
      queryText: 'AI 设计工具哪个好',
      baselineSovMean: 0.05,
      baselineMentionRate: 0,
      topCompetitor: 'Acme',
      runId: 'run-1',
    })
  })

  it('评分：整页切分后 scorePassages 求均值（原文 vs 建议稿）', async () => {
    const prisma = makePrismaWithBaseline(BASELINE, { query: QUERY, page: PAGE })
    const { deps, citability } = makeDeps({ prisma })
    const svc = createClosedLoopService(deps)

    const result = await svc.optimizeFromWeakPoint({ workspaceId: 'w1', queryId: 'q1', brand: 'b' })
    expect(result.beforeScore).toBe(40)
    expect(result.afterScore).toBe(80)
    // 两次评分各一次 scorePassages（不引入新切分器）
    expect(citability.scorePassages).toHaveBeenCalledTimes(2)
  })

  it('幂等：已有 PENDING/IN_PROGRESS/REVIEWED/AWAITING 任务 → 拒，零 LLM 调用', async () => {
    for (const status of ['PENDING', 'IN_PROGRESS', 'REVIEWED', 'AWAITING_VERIFICATION']) {
      const prisma = makePrismaWithBaseline(BASELINE, { query: QUERY, page: PAGE, inFlight: { id: 'task-x' } })
      const { deps, taskService, rewriter } = makeDeps({ prisma })
      const svc = createClosedLoopService(deps)
      await expect(svc.optimizeFromWeakPoint({ workspaceId: 'w1', queryId: 'q1', brand: 'b' })).rejects.toThrow(
        DUPLICATE_ACTIVE_TASK_MESSAGE,
      )
      expect(rewriter.rewriteForQuery).not.toHaveBeenCalled()
      expect(taskService.create).not.toHaveBeenCalled()
      // 幂等判定确实按状态集合查
      expect(prisma.optimizationTask.findFirst.mock.calls[0][0].where.status.in).toEqual([
        'PENDING', 'IN_PROGRESS', 'REVIEWED', 'AWAITING_VERIFICATION',
      ])
    }
  })

  it('FAILED/VERIFIED 历史任务不阻断重建', async () => {
    const prisma = makePrismaWithBaseline(BASELINE, { query: QUERY, page: PAGE, inFlight: null })
    const { deps } = makeDeps({ prisma })
    const svc = createClosedLoopService(deps)
    await expect(svc.optimizeFromWeakPoint({ workspaceId: 'w1', queryId: 'q1', brand: 'b' })).resolves.toBeDefined()
  })

  it('query 须 ACTIVE：PAUSED 拒绝，零 LLM 调用', async () => {
    const prisma = makePrismaWithBaseline(BASELINE, { query: { ...QUERY, status: 'PAUSED' }, page: PAGE })
    const { deps, rewriter } = makeDeps({ prisma })
    const svc = createClosedLoopService(deps)
    await expect(svc.optimizeFromWeakPoint({ workspaceId: 'w1', queryId: 'q1', brand: 'b' })).rejects.toThrow(/暂停/)
    expect(rewriter.rewriteForQuery).not.toHaveBeenCalled()
  })

  it('查询不存在 → 拒', async () => {
    const prisma = makePrismaWithBaseline(null, { query: null, page: null })
    const { deps } = makeDeps({ prisma })
    const svc = createClosedLoopService(deps)
    await expect(svc.optimizeFromWeakPoint({ workspaceId: 'w1', queryId: 'nope', brand: 'b' })).rejects.toThrow(/不存在/)
  })

  it('未映射页面 → 拒（引导去映射），零 LLM 调用', async () => {
    const prisma = makePrismaWithBaseline(BASELINE, { query: { ...QUERY, mappedPageUrl: null }, page: PAGE })
    const { deps, rewriter } = makeDeps({ prisma })
    const svc = createClosedLoopService(deps)
    await expect(svc.optimizeFromWeakPoint({ workspaceId: 'w1', queryId: 'q1', brand: 'b' })).rejects.toThrow(
      PAGE_MAPPING_MISSING_MESSAGE,
    )
    expect(rewriter.rewriteForQuery).not.toHaveBeenCalled()
  })

  it('映射失效（页面不存在）→ 拒并给出规格文案，零 LLM 调用', async () => {
    const prisma = makePrismaWithBaseline(BASELINE, { query: QUERY, page: null })
    const { deps, rewriter } = makeDeps({ prisma })
    const svc = createClosedLoopService(deps)
    await expect(svc.optimizeFromWeakPoint({ workspaceId: 'w1', queryId: 'q1', brand: 'b' })).rejects.toThrow(
      PAGE_MAPPING_INVALID_MESSAGE,
    )
    expect(rewriter.rewriteForQuery).not.toHaveBeenCalled()
  })

  it('生成抛错 → 任务置 FAILED 带原因（不留半态 PENDING），错误上抛', async () => {
    const prisma = makePrismaWithBaseline(BASELINE, { query: QUERY, page: PAGE })
    const { deps, rewriter } = makeDeps({ prisma })
    rewriter.rewriteForQuery = vi.fn(async () => {
      throw new Error('LLM 503')
    }) as any
    const svc = createClosedLoopService(deps)

    await expect(svc.optimizeFromWeakPoint({ workspaceId: 'w1', queryId: 'q1', brand: 'b' })).rejects.toThrow(/LLM 503/)
    const failUpdate = prisma.optimizationTask.update.mock.calls.at(-1)![0]
    expect(failUpdate.data.status).toBe('FAILED')
    expect(failUpdate.data.result.error).toContain('LLM 503')
  })

  it('生成空稿 → 同样走 FAILED 路径（不留空建议稿）', async () => {
    const prisma = makePrismaWithBaseline(BASELINE, { query: QUERY, page: PAGE })
    const { deps, rewriter } = makeDeps({ prisma })
    rewriter.rewriteForQuery = vi.fn(async () => '   ') as any
    const svc = createClosedLoopService(deps)

    await expect(svc.optimizeFromWeakPoint({ workspaceId: 'w1', queryId: 'q1', brand: 'b' })).rejects.toThrow()
    expect(prisma.optimizationTask.update.mock.calls.at(-1)![0].data.status).toBe('FAILED')
  })

  it('无历史 Run：基线字段为 null，仍可生成（基线空不阻断）', async () => {
    const prisma = makePrismaWithBaseline(null, { query: QUERY, page: PAGE })
    const { deps } = makeDeps({ prisma })
    const svc = createClosedLoopService(deps)
    const result = await svc.optimizeFromWeakPoint({ workspaceId: 'w1', queryId: 'q1', brand: 'b' })
    const ctx = prisma.optimizationTask.update.mock.calls[0][0].data.result.context
    expect(ctx).toMatchObject({ baselineSovMean: null, baselineMentionRate: null, topCompetitor: null, runId: null })
    expect(result.suggestion).toBeTruthy()
  })

  it('页面查询按 workspaceId + url 双重限定（不跨工作区取页）', async () => {
    const prisma = makePrismaWithBaseline(BASELINE, { query: QUERY, page: PAGE })
    const { deps } = makeDeps({ prisma })
    const svc = createClosedLoopService(deps)
    await svc.optimizeFromWeakPoint({ workspaceId: 'w1', queryId: 'q1', brand: 'b' })
    expect(prisma.contentPage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: 'w1', url: 'https://example.com/a' } }),
    )
  })

  it('查询按 workspaceId 限定（跨工作区查不到）', async () => {
    const prisma = makePrismaWithBaseline(BASELINE, { query: null, page: PAGE })
    const { deps } = makeDeps({ prisma })
    const svc = createClosedLoopService(deps)
    await expect(svc.optimizeFromWeakPoint({ workspaceId: 'w2', queryId: 'q1', brand: 'b' })).rejects.toThrow(/不存在/)
    expect(prisma.citationQuery.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'q1', workspaceId: 'w2' } }),
    )
  })
})
