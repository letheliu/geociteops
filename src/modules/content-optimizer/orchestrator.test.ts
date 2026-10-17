import { describe, it, expect, vi } from 'vitest'
import { createOrchestrator } from './orchestrator.js'
import type { Atom, ScoredAtom, FaqPair } from './types.js'

function makeScoredAtom(text: string, total: number): ScoredAtom {
  return {
    text,
    subject: 'x',
    predicate: 'y',
    object: 'z',
    anchors: ['123'],
    score: {
      total,
      hasNumericAnchor: total >= 35,
      hasEntityAnchor: total >= 60,
      isSelfContained: true,
      hasDefinition: total >= 75,
    },
  }
}

describe('Orchestrator', () => {
  const mockAtoms: Atom[] = [
    { text: '段落1', subject: 'a', predicate: 'b', object: 'c', anchors: ['123'] },
  ]

  function makeDeps(overrides: any = {}) {
    const defaultScored: ScoredAtom[] = [makeScoredAtom('段落1', 85)]
    const defaultFaqs: FaqPair[] = [
      { question: 'Q?', answer: 'A', source: 'llm_generated' },
    ]

    return {
      atomizer: {
        atomize: vi.fn().mockResolvedValue(mockAtoms),
        ...overrides.atomizer,
      },
      scoring: {
        scoreAtoms: vi.fn().mockReturnValue(defaultScored),
        scorePage: vi.fn().mockReturnValue(85),
        scorePageComposite: vi.fn().mockReturnValue(80),
        ...overrides.scoring,
      },
      rewriter: {
        rewriteBatch: vi.fn().mockImplementation(async (atoms: ScoredAtom[]) => atoms),
        ...overrides.rewriter,
      },
      faqGenerator: {
        generate: vi.fn().mockResolvedValue(defaultFaqs),
        ...overrides.faqGenerator,
      },
      taskService: {
        create: vi.fn().mockResolvedValue({ id: 'task-1' }),
        ...overrides.taskService,
      },
      eeat: {
        score: vi.fn().mockReturnValue({
          total: 70,
          experience: 20,
          expertise: 15,
          authoritativeness: 20,
          trustworthiness: 15,
          whoHowWhyPassed: true,
        }),
        ...overrides.eeat,
      },
      citability: {
        score: vi.fn().mockReturnValue({
          total: 60,
          lengthScore: 30,
          frontLoadBonus: false,
          hasDefinitionPattern: true,
          hasAttribution: true,
          hasUniqueData: false,
        }),
        scorePassages: vi.fn().mockReturnValue({
          scores: [{ total: 60, lengthScore: 30, frontLoadBonus: false, hasDefinitionPattern: true, hasAttribution: true, hasUniqueData: false }],
          average: 60,
        }),
        ...overrides.citability,
      },
      prisma: {
        contentPage: {
          upsert: vi.fn().mockResolvedValue({ id: 'page-1' }),
          findUnique: vi.fn().mockResolvedValue(null),
        },
        contentAtom: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          findMany: vi.fn().mockResolvedValue([]),
        },
        ...overrides.prisma,
      },
      // 任务 9：pages 下沉为 page service（maxPages 检查点在 service 内）
      pages: {
        upsert: vi.fn().mockResolvedValue({ id: 'page-1' }),
        ...overrides.pages,
      },
    }
  }

  it('完整流水线：atomize → score → rewrite → citability → eeat → faq → 组装结果', async () => {
    const deps = makeDeps()
    const orchestrator = createOrchestrator(deps as any)

    const result = await orchestrator.optimize({
      workspaceId: 'w1',
      content: '原始内容',
    })

    expect(deps.atomizer.atomize).toHaveBeenCalledWith('原始内容')
    expect(deps.scoring.scoreAtoms).toHaveBeenCalled()
    expect(deps.rewriter.rewriteBatch).toHaveBeenCalled()
    expect(deps.citability.scorePassages).toHaveBeenCalled()
    expect(deps.faqGenerator.generate).toHaveBeenCalled()
    expect(result.atoms).toHaveLength(1)
    expect(result.faqs).toHaveLength(1)
    expect(result.overallScore).toBe(80)
  })

  it('composite 评分使用 atom + citability + eeat', async () => {
    const deps = makeDeps()
    const orchestrator = createOrchestrator(deps as any)

    await orchestrator.optimize({
      workspaceId: 'w1',
      content: 'test',
      eeatInput: {
        hasOriginalResearch: true,
        hasCaseStudies: true,
        hasAuthorByline: true,
        hasAuthorCredentials: true,
        hasExternalCitations: true,
        hasBrandMentions: true,
        hasContactInfo: true,
        hasHttps: true,
        hasDateStamps: true,
        hasCorrectionsPolicy: true,
      },
    })

    expect(deps.scoring.scorePageComposite).toHaveBeenCalledWith(85, 60, 70)
  })

  it('传入 eeatInput 时调用 eeat.score', async () => {
    const deps = makeDeps()
    const orchestrator = createOrchestrator(deps as any)

    const eeatInput = {
      hasOriginalResearch: true,
      hasCaseStudies: true,
      hasAuthorByline: true,
      hasAuthorCredentials: true,
      hasExternalCitations: true,
      hasBrandMentions: true,
      hasContactInfo: true,
      hasHttps: true,
      hasDateStamps: true,
      hasCorrectionsPolicy: true,
    }

    await orchestrator.optimize({
      workspaceId: 'w1',
      content: 'test',
      eeatInput,
    })

    expect(deps.eeat.score).toHaveBeenCalledWith(eeatInput)
  })

  it('不传 eeatInput 时 eeat 分数为 0', async () => {
    const deps = makeDeps()
    const orchestrator = createOrchestrator(deps as any)

    await orchestrator.optimize({
      workspaceId: 'w1',
      content: 'test',
    })

    expect(deps.eeat.score).not.toHaveBeenCalled()
    expect(deps.scoring.scorePageComposite).toHaveBeenCalledWith(85, 60, 0)
  })

  it('report 包含 citabilityScore 和 eeatScore', async () => {
    const deps = makeDeps()
    const orchestrator = createOrchestrator(deps as any)

    const result = await orchestrator.optimize({
      workspaceId: 'w1',
      content: 'test',
      eeatInput: {
        hasOriginalResearch: true,
        hasCaseStudies: false,
        hasAuthorByline: true,
        hasAuthorCredentials: true,
        hasExternalCitations: true,
        hasBrandMentions: false,
        hasContactInfo: true,
        hasHttps: true,
        hasDateStamps: true,
        hasCorrectionsPolicy: false,
      },
    })

    expect(result.report.citabilityScore).toBe(60)
    expect(result.report.eeatScore).toBe(70)
  })

  it('所有 atom 达标时 rewrittenCount 为 0', async () => {
    const deps = makeDeps({
      scoring: {
        scoreAtoms: vi.fn().mockReturnValue([makeScoredAtom('a', 100)]),
        scorePage: vi.fn().mockReturnValue(100),
        scorePageComposite: vi.fn().mockReturnValue(90),
      },
    })
    const orchestrator = createOrchestrator(deps as any)

    const result = await orchestrator.optimize({
      workspaceId: 'w1',
      content: 'test',
    })

    expect(result.rewrittenCount).toBe(0)
  })

  it('创建 OptimizationTask', async () => {
    const deps = makeDeps()
    const orchestrator = createOrchestrator(deps as any)

    await orchestrator.optimize({
      workspaceId: 'w1',
      content: 'test',
      url: 'https://example.com',
      pageType: 'landing',
    })

    expect(deps.taskService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'w1',
        type: 'REWRITE_CONTENT',
      }),
    )
  })

  it('传入 pageId 时读取已有 ContentPage 内容', async () => {
    const deps = makeDeps({
      prisma: {
        contentPage: {
          upsert: vi.fn(),
          findUnique: vi.fn().mockResolvedValue({
            id: 'page-1',
            currentContent: '已有内容',
            workspaceId: 'w1',
          }),
        },
      },
    })
    const orchestrator = createOrchestrator(deps as any)

    await orchestrator.optimize({
      workspaceId: 'w1',
      content: '',
      pageId: 'page-1',
    })

    expect(deps.prisma.contentPage.findUnique).toHaveBeenCalledWith({ where: { id: 'page-1' } })
    expect(deps.atomizer.atomize).toHaveBeenCalledWith('已有内容')
  })
})
