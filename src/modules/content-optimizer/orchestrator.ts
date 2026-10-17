import type { PrismaClient } from '@prisma/client'
import type { LlmProvider } from '../../core/llm/types.js'
import type { VectorStore, SearchHit } from '../../core/vector/store.js'
import type { Atom, ScoredAtom, FaqPair, OptimizationResult, EeatInput, CitabilityInput } from './types.js'
import type { AtomizerService } from './atomizer.js'
import type { ScoringService } from './scoring.js'
import type { RewriterService } from './rewriter.js'
import type { FaqGeneratorService } from './faq-generator.js'
import type { TaskService } from './task-service.js'
import type { PageService } from './page-service.js'
import type { EeatService } from './eeat.js'
import type { CitabilityService } from './citability.js'

export interface OptimizeInput {
  workspaceId: string
  content: string
  pageId?: string
  url?: string
  pageType?: string
  eeatInput?: EeatInput
}

export interface OrchestratorService {
  optimize(input: OptimizeInput): Promise<OptimizationResult>
  /** 语义检索：跨页召回与文本最相似的内容原子（用于去重 / RAG）。 */
  findSimilarAtoms(workspaceId: string, text: string, topK?: number): Promise<SearchHit[]>
}

export interface OrchestratorDeps {
  atomizer: AtomizerService
  scoring: ScoringService
  rewriter: RewriterService
  faqGenerator: FaqGeneratorService
  taskService: TaskService
  /** 内容页 upsert（任务 9 下沉：maxPages 软限检查点在 page service 内） */
  pages: PageService
  eeat: EeatService
  citability: CitabilityService
  prisma: PrismaClient
  llm?: LlmProvider
  vector?: VectorStore
}

export function createOrchestrator(deps: OrchestratorDeps): OrchestratorService {
  /**
   * 把切分并改写后的 atoms 落 PG + 写入向量库。
   * 容错：向量库写入失败不阻塞优化主流程（结果已生成）。
   */
  async function persistAtoms(
    workspaceId: string,
    pageId: string,
    atoms: ScoredAtom[],
  ): Promise<void> {
    if (atoms.length === 0) return

    // 1. 落 PG（清理该页旧 atoms 后重建，保证幂等）
    try {
      await deps.prisma.contentAtom.deleteMany({ where: { pageId } })
      await deps.prisma.contentAtom.createMany({
        data: atoms.map((a) => ({
          workspaceId,
          pageId,
          atomText: a.text,
          subject: a.subject || null,
          predicate: a.predicate || null,
          objectValue: a.object || null,
          score: a.score.total,
        })),
      })
    } catch (e) {
      console.warn(`[orchestrator] ContentAtom 落库失败 pageId=${pageId}:`, (e as Error).message)
      return
    }

    // 2. 向量化（批量 embed + 一次 upsert）
    if (!deps.llm || !deps.vector) return
    try {
      const created = await deps.prisma.contentAtom.findMany({
        where: { pageId },
        select: { id: true, atomText: true },
        orderBy: { createdAt: 'asc' },
      })
      if (created.length === 0) return
      const vectors = await deps.llm.embedBatch(created.map((a) => a.atomText))
      await deps.vector.upsert(
        deps.vector.COLLECTIONS.atoms,
        created.map((a, i) => ({
          id: a.id,
          vector: vectors[i],
          metadata: { workspaceId, sourceType: 'content' },
        })),
      )
    } catch (e) {
      console.warn(`[orchestrator] atoms 向量化失败 pageId=${pageId}:`, (e as Error).message)
    }
  }

  return {
    async optimize(input) {
      let content = input.content
      let pageId = input.pageId

      if (input.pageId) {
        const page = await deps.prisma.contentPage.findUnique({
          where: { id: input.pageId },
        })
        if (page) {
          content = page.currentContent
        }
      }

      const atoms: Atom[] = await deps.atomizer.atomize(content)
      if (atoms.length === 0) {
        return {
          atoms: [],
          faqs: [],
          overallScore: 0,
          rewrittenCount: 0,
          report: { atomizationRate: 0, independenceRate: 0, faqCoverage: 0 },
        }
      }

      const scoredAtoms: ScoredAtom[] = deps.scoring.scoreAtoms(atoms)
      const beforeScore = deps.scoring.scorePage(scoredAtoms)
      const needsRewrite = scoredAtoms.filter((a) => a.score.total < 70).length

      const rewrittenAtoms: ScoredAtom[] = await deps.rewriter.rewriteBatch(scoredAtoms)
      const afterAtomScore = deps.scoring.scorePage(rewrittenAtoms)

      const citabilityInputs: CitabilityInput[] = rewrittenAtoms.map((atom, i) => ({
        text: atom.text,
        positionRatio: rewrittenAtoms.length > 0 ? i / rewrittenAtoms.length : 0,
        hasAttribution: atom.anchors.length > 0,
        hasUniqueData: atom.score.hasNumericAnchor,
      }))
      const citabilityResult = deps.citability.scorePassages(citabilityInputs)

      const eeatScore = input.eeatInput
        ? deps.eeat.score(input.eeatInput)
        : { total: 0, experience: 0, expertise: 0, authoritativeness: 0, trustworthiness: 0, whoHowWhyPassed: false }

      const overallScore = deps.scoring.scorePageComposite(
        afterAtomScore,
        citabilityResult.average,
        eeatScore.total,
      )

      const faqs: FaqPair[] = await deps.faqGenerator.generate({
        atoms: rewrittenAtoms,
        workspaceId: input.workspaceId,
      })

      const passedAtoms = rewrittenAtoms.filter((a) => a.score.total >= 70).length
      const independentAtoms = rewrittenAtoms.filter((a) => a.score.isSelfContained).length
      const coveredFaqs = faqs.filter((f) => f.matchedQueryId).length

      const result: OptimizationResult = {
        atoms: rewrittenAtoms,
        faqs,
        overallScore,
        rewrittenCount: needsRewrite,
        report: {
          atomizationRate: rewrittenAtoms.length > 0 ? passedAtoms / rewrittenAtoms.length : 0,
          independenceRate: rewrittenAtoms.length > 0 ? independentAtoms / rewrittenAtoms.length : 0,
          faqCoverage: faqs.length > 0 ? coveredFaqs / faqs.length : 0,
          citabilityScore: citabilityResult.average,
          eeatScore: eeatScore.total,
        },
      }

      if (input.url) {
        // 任务 9：经 page service upsert（新建路径挂 maxPages 软限 + 计量）；
        // 已存在页只更新优化结果（updateContent=false，保持任务 9 前行为）
        const page = await deps.pages.upsert({
          workspaceId: input.workspaceId,
          url: input.url,
          pageType: input.pageType || 'landing',
          currentContent: content,
          optimizedContent: JSON.stringify(result),
          optimizationScore: overallScore,
          updateContent: false,
        })
        pageId = page.id
      }

      // pageId 确定后落 atom（PG + 向量库）
      if (pageId) {
        await persistAtoms(input.workspaceId, pageId, rewrittenAtoms)
      }

      await deps.taskService.create({
        workspaceId: input.workspaceId,
        type: 'REWRITE_CONTENT',
        pageId,
        beforeScore,
        afterScore: overallScore,
        result: {
          overallScore: result.overallScore,
          rewrittenCount: result.rewrittenCount,
          report: result.report,
        },
      })

      return result
    },

    async findSimilarAtoms(workspaceId, text, topK = 10) {
      if (!deps.llm || !deps.vector) throw new Error('LLM and vector store required for findSimilarAtoms')
      const v = await deps.llm.embed(text)
      return deps.vector.search(deps.vector.COLLECTIONS.atoms, v, topK, { workspaceId })
    },
  }
}
