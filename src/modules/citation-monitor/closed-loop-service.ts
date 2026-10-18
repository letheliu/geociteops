import type { PrismaClient, OptimizationTask } from '@prisma/client'
import type { RewriterService } from '../content-optimizer/rewriter.js'
import type { AtomizerService } from '../content-optimizer/atomizer.js'
import type { CitabilityService } from '../content-optimizer/citability.js'
import type { TaskService } from '../content-optimizer/task-service.js'
import { dayKey, MAX_TREND_RANGE_DAYS } from './aggregate.js'
import { loadQueryBaselines, pickTopCompetitor } from './weak-points.js'

/**
 * 闭环建议生成（M2 §3.3 规格 §6）。
 *
 * 单入口：`optimizeFromWeakPoint`（规格 §6 评审 P1-2——其余优化入口无单查询页面锚，
 * 维持现状不进"创建时生成"）。流程：
 * 1. 门禁前置（由 router 层 assert，本服务不重复，避免两处判定漂移）
 * 2. query 须属本工作区且 ACTIVE
 * 3. 幂等：该查询已有 PENDING/IN_PROGRESS/REVIEWED/AWAITING_VERIFICATION 任务则拒
 * 4. 映射解析：mappedPageUrl → ContentPage 必须存在且归属本工作区
 * 5. 建任务 → 后置生成建议稿（异常可捕获 → FAILED 带原因，不留半态）
 * 6. 评分切分：整页按现有 passage 切分（atomizer）后 scorePassages 求均值
 */

/** 映射失效/未映射的对外文案（规格 §5 钉死，调用方不得另立说法） */
export const PAGE_MAPPING_INVALID_MESSAGE = '映射页面不存在，请重新关联'
/** 未建立映射时的文案 */
export const PAGE_MAPPING_MISSING_MESSAGE = '该查询尚未关联页面，请先在查询库中关联页面'
/** 同查询已有进行中任务时的文案 */
export const DUPLICATE_ACTIVE_TASK_MESSAGE = '该查询已有进行中的优化任务，请先处理或等其完成'

export class QueryNotOptimizableError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'QUERY_NOT_OPTIMIZABLE'
  }
}

export interface OptimizeFromWeakPointInput {
  workspaceId: string
  queryId: string
  /** 品牌名（进入改写 prompt；缺省取工作区配置） */
  brand: string
}

export interface OptimizeFromWeakPointResult {
  task: OptimizationTask
  suggestion: string
  beforeScore: number
  afterScore: number
}

export interface ClosedLoopService {
  optimizeFromWeakPoint(input: OptimizeFromWeakPointInput): Promise<OptimizeFromWeakPointResult>
}

export interface ClosedLoopServiceDeps {
  prisma: PrismaClient
  taskService: Pick<TaskService, 'create'>
  rewriter: RewriterService
  atomizer: AtomizerService
  citability: CitabilityService
  /** 时钟注入（基线窗口与生成失败时间戳），缺省系统时间 */
  now?: () => Date
}

export function createClosedLoopService(deps: ClosedLoopServiceDeps): ClosedLoopService {
  const { prisma, taskService, rewriter, atomizer, citability } = deps
  const now = deps.now ?? (() => new Date())

  /**
   * 基线窗口：optimizeFromWeakPoint 不收 dateRange（规格 §5 钉死签名），
   * 因此取最大允许窗口 366 天——与趋势/weakPoints 的范围上限一致，
   * 不会因为窗口更小而看不到"最近一个有效 Run"。
   */
  function baselineWindow(): { fromDay: string; toDay: string } {
    const to = now()
    const from = new Date(to.getTime() - (MAX_TREND_RANGE_DAYS - 1) * 86_400_000)
    return { fromDay: dayKey(from), toDay: dayKey(to) }
  }

  /** 整页按现有 passage 切分后 scorePassages 求均值（规格 §6.5 钉死，不引入新切分器） */
  async function scorePage(content: string): Promise<number> {
    const atoms = await atomizer.atomize(content)
    if (atoms.length === 0) return 0
    const inputs = atoms.map((atom, i) => ({
      text: atom.text,
      positionRatio: atoms.length > 1 ? i / (atoms.length - 1) : 0,
      hasAttribution: atom.anchors.length > 0,
      hasUniqueData: /\d/.test(atom.text),
    }))
    return citability.scorePassages(inputs).average
  }

  return {
    async optimizeFromWeakPoint(input) {
      const { workspaceId, queryId, brand } = input

      const query = await prisma.citationQuery.findFirst({
        where: { id: queryId, workspaceId },
        select: { id: true, queryText: true, status: true, mappedPageUrl: true },
      })
      if (!query) throw new QueryNotOptimizableError('查询不存在')
      if (query.status !== 'ACTIVE') throw new QueryNotOptimizableError('查询已暂停，恢复监测后才能一键优化')

      // 幂等：仅挡顺序双击（并发窗口按规格明示接受）
      const inFlight = await prisma.optimizationTask.findFirst({
        where: {
          workspaceId,
          queryId,
          status: { in: ['PENDING', 'IN_PROGRESS', 'REVIEWED', 'AWAITING_VERIFICATION'] },
        },
        select: { id: true },
      })
      if (inFlight) throw new QueryNotOptimizableError(DUPLICATE_ACTIVE_TASK_MESSAGE)

      if (!query.mappedPageUrl) throw new QueryNotOptimizableError(PAGE_MAPPING_MISSING_MESSAGE)
      const page = await prisma.contentPage.findFirst({
        where: { workspaceId, url: query.mappedPageUrl },
        select: { id: true, currentContent: true },
      })
      if (!page) throw new QueryNotOptimizableError(PAGE_MAPPING_INVALID_MESSAGE)

      const baselines = await loadQueryBaselines(prisma, { workspaceId, ...baselineWindow() })
      const baseline = baselines.get(queryId)

      const task = await taskService.create({
        workspaceId,
        type: 'OPTIMIZE_FOR_QUERY',
        pageId: page.id,
        queryId,
      })

      // 生成后置：异常可捕获 → 任务置 FAILED 带原因（用户可拒绝后重建），不留"半态 PENDING"
      try {
        const suggestion = await rewriter.rewriteForQuery(page.currentContent, query.queryText, brand)
        if (!suggestion || suggestion.trim().length === 0) {
          throw new Error('改写结果为空')
        }
        const [beforeScore, afterScore] = await Promise.all([
          scorePage(page.currentContent),
          scorePage(suggestion),
        ])

        const updated = await prisma.optimizationTask.update({
          where: { id: task.id },
          data: {
            beforeScore,
            afterScore,
            result: {
              suggestion,
              context: {
                queryText: query.queryText,
                baselineSovMean: baseline?.level.sovMean ?? null,
                baselineMentionRate: baseline?.level.brandMentionRate ?? null,
                topCompetitor: baseline ? pickTopCompetitor(baseline.level.competitorMentionRates)?.name ?? null : null,
                runId: baseline?.runId ?? null,
              },
            },
          },
        })
        return { task: updated, suggestion, beforeScore, afterScore }
      } catch (err) {
        await prisma.optimizationTask.update({
          where: { id: task.id },
          data: {
            status: 'FAILED',
            result: { error: `建议生成失败：${(err as Error).message}` },
          },
        })
        throw new QueryNotOptimizableError(`建议生成失败：${(err as Error).message}`)
      }
    },
  }
}
