import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { router, protectedProcedure } from '../../core/trpc/init.js'
import { dayKey, okEventsWhere, periodAggregate } from './aggregate.js'
import {
  assertRangeWithinLimit,
  loadTrendPoints,
  toRunListRow,
  type RunListRow,
} from './trend-query.js'
import { MAX_SAMPLE_COUNT, MIN_SAMPLE_COUNT } from './monitor.js'
import {
  QuotaExceededError,
  assertWorkspaceOptimizationsAllowed,
  resolveWorkspaceOrganization,
  workspaceOptimizationsAllowed,
} from '../../platform/billing/entitlement-guard.js'
import { loadWeakPoints } from './weak-points.js'

/**
 * 监测读路径（规格 §5）。
 *
 * 口径全部来自 aggregate.ts，本文件只做「校验 → 取数 → 装配响应」：
 * - 所有 CitationEvent 读取经 okEventsWhere / loadTrendPoints，不在端点里手写过滤
 * - 所有端点以 ctx.workspace.id 限定，runs.* / runStatus 不接受 workspaceId 入参
 */

const dateRangeInput = z.object({ start: z.string(), end: z.string() })

/** 桶日（Asia/Shanghai）+ 范围上限校验；失败一律 BAD_REQUEST */
function resolveRange(input: { start: string; end: string }): { fromDay: string; toDay: string } {
  const from = new Date(input.start)
  const to = new Date(input.end)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'dateRange 格式非法' })
  }
  const fromDay = dayKey(from)
  const toDay = dayKey(to)
  try {
    assertRangeWithinLimit(fromDay, toDay)
  } catch (err) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message })
  }
  return { fromDay, toDay }
}

function clampSampleCount(n: number): number {
  return Math.min(MAX_SAMPLE_COUNT, Math.max(MIN_SAMPLE_COUNT, Math.trunc(n)))
}

export const citationRouter = router({
  // ===== 趋势（Dashboard 主入口）=====
  trend: protectedProcedure
    .input(
      z.object({
        dateRange: dateRangeInput,
        queryId: z.string().optional(),
        platform: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { fromDay, toDay } = resolveRange(input.dateRange)
      const points = await loadTrendPoints(ctx.services.prisma, {
        workspaceId: ctx.workspace.id,
        fromDay,
        toDay,
        queryId: input.queryId,
        platform: input.platform,
      })
      // 趋势 + 期间级汇总（macro over 数据点）一次返回，前端不必二次计算
      return { points, period: periodAggregate(points) }
    }),

  // 期间级聚合指标（SOV 正名：sovMean = 份额口径；旧的 getSovScore 实为提及率）
  getSovScore: protectedProcedure
    .input(
      z.object({
        competitors: z.array(z.string()),
        dateRange: dateRangeInput,
        platform: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { fromDay, toDay } = resolveRange(input.dateRange)
      const points = await loadTrendPoints(ctx.services.prisma, {
        workspaceId: ctx.workspace.id,
        fromDay,
        toDay,
        platform: input.platform,
      })
      const period = periodAggregate(points)
      return {
        sovMean: period.sovMean,
        brandMentionRate: period.brandMentionRate,
        brandSourceCitationRate: period.brandSourceCitationRate,
        sovStdDev: period.sovStdDev,
        rankMedian: period.rankMedian,
        rankBest: period.rankBest,
        validSamples: period.validSamples,
        failedSamples: period.failedSamples,
        pointCount: period.pointCount,
      }
    }),

  // 效果对比：before/after 走同一套期间级口径
  getEffectComparison: protectedProcedure
    .input(
      z.object({
        before: dateRangeInput,
        after: dateRangeInput,
        platform: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const beforeRange = resolveRange(input.before)
      const afterRange = resolveRange(input.after)
      const [beforePoints, afterPoints] = await Promise.all([
        loadTrendPoints(ctx.services.prisma, {
          workspaceId: ctx.workspace.id,
          ...beforeRange,
          platform: input.platform,
        }),
        loadTrendPoints(ctx.services.prisma, {
          workspaceId: ctx.workspace.id,
          ...afterRange,
          platform: input.platform,
        }),
      ])

      const before = periodAggregate(beforePoints)
      const after = periodAggregate(afterPoints)
      const delta = (a: number | null, b: number | null) => (a === null || b === null ? null : b - a)

      return {
        before,
        after,
        delta: {
          sovMean: delta(before.sovMean, after.sovMean),
          brandMentionRate: delta(before.brandMentionRate, after.brandMentionRate),
          brandSourceCitationRate: delta(before.brandSourceCitationRate, after.brandSourceCitationRate),
          rankMedian: delta(before.rankMedian, after.rankMedian),
        },
      }
    }),

  /**
   * 样本级查询（保留给 Dashboard 最近事件）。
   * 强制 okEventsWhere——FAILED 行不进报告；返回体自带 runId/sampleIndex/status 元数据。
   */
  getReport: protectedProcedure
    .input(
      z.object({
        dateRange: dateRangeInput,
        platform: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where: any = {
        workspaceId: ctx.workspace.id,
        ...okEventsWhere(),
        capturedAt: {
          gte: new Date(input.dateRange.start),
          lte: new Date(input.dateRange.end),
        },
      }
      if (input.platform) where.platform = input.platform
      const events = await ctx.services.prisma.citationEvent.findMany({
        where,
        include: { query: { select: { queryText: true } } },
        orderBy: { capturedAt: 'desc' },
      })
      return { events }
    }),

  // ===== runs 族 =====
  runs: router({
    /**
     * 手动触发：建 Run 行后立刻返回 runId，采样在后台跑。
     * 前端拿 runId 轮询 citation.runStatus（异步语义，规格 §6）。
     */
    create: protectedProcedure
      .input(
        z.object({
          platforms: z.array(z.string()).min(1),
          queryIds: z.array(z.string()).optional(),
          sampleCount: z.number().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        // 先同步校验，把「跨工作区 / PAUSED」在返回 runId 之前就拒掉
        if (input.queryIds && input.queryIds.length > 0) {
          const found = await ctx.services.prisma.citationQuery.findMany({
            where: { id: { in: input.queryIds }, workspaceId: ctx.workspace.id },
            select: { id: true, status: true },
          })
          if (found.length !== input.queryIds.length) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'queryIds 含不存在或不属于当前工作区的查询' })
          }
          if (found.some((q: { status: string }) => q.status !== 'ACTIVE')) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'queryIds 含非 ACTIVE 查询（PAUSED 不参与任何运行）' })
          }
        }

        // M2 §3.0：显式指定 N 时按配额硬检查（试用声明 3 → 传 10 直接拒）。
        // 必须在 createManualRun 之前——Run 一旦建出来就已在跑，事后拦不住。
        if (input.sampleCount !== undefined && ctx.services.billing) {
          const organizationId =
            ctx.workspace.organizationId ??
            (await resolveWorkspaceOrganization(ctx.services.prisma, ctx.workspace.id))
          if (organizationId) {
            try {
              await ctx.services.billing.guard.checkMonitorSampleCountMax(
                organizationId,
                clampSampleCount(input.sampleCount),
              )
            } catch (err) {
              if (err instanceof QuotaExceededError) {
                throw new TRPCError({
                  code: 'BAD_REQUEST',
                  message: `采样数 N 超出套餐上限：本次请求 ${clampSampleCount(input.sampleCount)}，套餐允许最多 ${err.limit}`,
                })
              }
              throw err
            }
          }
        }

        let result
        try {
          result = await ctx.services.monitor.createManualRun({
            workspaceId: ctx.workspace.id,
            platforms: input.platforms,
            queryIds: input.queryIds,
            sampleCount: input.sampleCount === undefined ? undefined : clampSampleCount(input.sampleCount),
          })
        } catch (err) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message })
        }

        if (result.runId === null) {
          // 0 查询或 0 平台：没有可跑的范围，不建 Run
          return { runId: null, status: 'SKIPPED' as const }
        }

        // 后台执行；终态落在 Run 行上，前端靠 runStatus 感知进度与结果
        void ctx.services.monitor.executeRunById(result.runId).catch((err: unknown) => {
          console.error(`[citation] manual run ${result.runId} failed:`, err)
        })
        return { runId: result.runId, status: 'RUNNING' as const }
      }),

    /** Run 行 + `legacy:<date>` 合成行，按日期倒序 */
    list: protectedProcedure
      .input(z.object({ dateRange: dateRangeInput }).optional())
      .query(async ({ ctx, input }): Promise<{ runs: RunListRow[] }> => {
        const { fromDay, toDay } = input?.dateRange
          ? resolveRange(input.dateRange)
          : { fromDay: dayKey(new Date(Date.now() - 29 * 86_400_000)), toDay: dayKey(new Date()) }

        const points = await loadTrendPoints(ctx.services.prisma, {
          workspaceId: ctx.workspace.id,
          fromDay,
          toDay,
        })

        // failureReason 只存在 Run 行上，按 id 补挂（legacy 合成行恒为 null）
        const reasons = new Map<string, string | null>()
        if (points.length > 0) {
          const ids = points.filter((p) => !p.legacy).map((p) => p.id)
          if (ids.length > 0) {
            const runs = await ctx.services.prisma.citationRun.findMany({
              where: { id: { in: ids } },
              select: { id: true, failureReason: true },
            })
            for (const r of runs) reasons.set(r.id, r.failureReason)
          }
        }

        const rows = points
          .map(toRunListRow)
          .map((row) => ({ ...row, failureReason: reasons.get(row.id) ?? null }))
          .reverse()
        return { runs: rows }
      }),

    /** 抽屉明细：runId 或 legacyDay 二选一；含 rawAnswer 与失败原因 */
    samples: protectedProcedure
      .input(
        z.object({
          runId: z.string().optional(),
          legacyDay: z.string().optional(),
        }),
      )
      .query(async ({ ctx, input }) => {
        if (input.runId && input.legacyDay) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'runId 与 legacyDay 只能传一个' })
        }

        if (input.runId) {
          // 越权钉子：runId 必须落在 ctx.workspace.id 内，否则 NOT_FOUND
          const run = await ctx.services.prisma.citationRun.findFirst({
            where: { id: input.runId, workspaceId: ctx.workspace.id },
            select: { id: true, status: true, trigger: true, sampleCount: true, slotKey: true, startedAt: true },
          })
          if (!run) {
            throw new TRPCError({ code: 'NOT_FOUND', message: '运行记录不存在' })
          }
          // 详情视图：包含 FAILED 行（用户要看到失败原因），但它们不参与任何指标
          const events = await ctx.services.prisma.citationEvent.findMany({
            where: { runId: run.id },
            include: { query: { select: { queryText: true } } },
            orderBy: [{ platform: 'asc' }, { queryId: 'asc' }, { sampleIndex: 'asc' }],
          })
          return { run, events }
        }

        if (input.legacyDay) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(input.legacyDay)) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'legacyDay 需为 YYYY-MM-DD' })
          }
          const start = new Date(`${input.legacyDay}T00:00:00+08:00`)
          const end = new Date(start.getTime() + 86_400_000)
          const events = await ctx.services.prisma.citationEvent.findMany({
            where: {
              workspaceId: ctx.workspace.id,
              runId: null,
              ...okEventsWhere(),
              capturedAt: { gte: start, lt: end },
            },
            include: { query: { select: { queryText: true } } },
            orderBy: [{ platform: 'asc' }, { queryId: 'asc' }],
          })
          return {
            run: {
              id: `legacy:${input.legacyDay}`,
              status: 'COMPLETED' as const,
              trigger: 'LEGACY' as const,
              sampleCount: events.length,
              slotKey: null,
              startedAt: start,
            },
            events,
          }
        }

        throw new TRPCError({ code: 'BAD_REQUEST', message: '需要 runId 或 legacyDay' })
      }),
  }),

  /** 单 Run 进度/终态轮询（ctx.workspace.id 限定） */
  runStatus: protectedProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const run = await ctx.services.prisma.citationRun.findFirst({
        where: { id: input.runId, workspaceId: ctx.workspace.id },
        select: {
          id: true,
          status: true,
          trigger: true,
          sampleCount: true,
          plannedUnits: true,
          completedUnits: true,
          failedUnits: true,
          failureReason: true,
          startedAt: true,
          finishedAt: true,
        },
      })
      if (!run) {
        throw new TRPCError({ code: 'NOT_FOUND', message: '运行记录不存在' })
      }
      return run
    }),

  /**
   * 薄弱点列表（M2 §3.3 规格 §5/§8）：Reports 页"薄弱查询"卡的数据源。
   * 响应携带 optimizationsAllowed——与 assertOptimizationsAllowed 同源算出，
   * 前端一键优化的禁用态因此不会与后端硬拒绝漂移。
   */
  weakPoints: protectedProcedure
    .input(dateRangeInput)
    .query(async ({ ctx, input }) => {
      const { fromDay, toDay } = resolveRange(input)
      const [weakPoints, optimizationsAllowed] = await Promise.all([
        loadWeakPoints(ctx.services.prisma, { workspaceId: ctx.workspace.id, fromDay, toDay }),
        workspaceOptimizationsAllowed(ctx),
      ])
      return { weakPoints, optimizationsAllowed }
    }),

  /**
   * M2 §3.3 薄弱点一键优化（规格 §5/§6）。
   * 本任务先落门禁前置断言（规格 §4 六入口之一，任务 5 实装建议生成全流程）：
   * 门禁必须在任何 LLM 调用与写库之前，因此它先于业务逻辑执行。
   */
  optimizeFromWeakPoint: protectedProcedure
    .input(z.object({ queryId: z.string().min(1) }))
    .mutation(async ({ ctx }) => {
      await assertWorkspaceOptimizationsAllowed(ctx)
      throw new TRPCError({
        code: 'NOT_IMPLEMENTED',
        message: '薄弱点一键优化将在闭环建议生成任务实装',
      })
    }),

  // query 库管理
  queries: router({
    list: protectedProcedure
      .input(z.object({ status: z.enum(['active', 'paused']).optional() }).optional())
      .query(async ({ ctx }) => {
        return ctx.services.queryLibrary.listActive(ctx.workspace.id)
      }),

    /**
     * 新增查询。pageId 可选——关联页面一律 **pageId 下拉制**，服务端写 mappedPageUrl=page.url，
     * 不收自由 URL（规格 §5）：否则查询可被指向任意站点，改写建议稿会写到不属于自己的页面上。
     */
    add: protectedProcedure
      .input(
        z.object({
          queryText: z.string(),
          source: z.enum(['manual', 'google_suggest', 'llm_generated', 'paa', 'competitor']),
          intent: z.record(z.unknown()).optional(),
          pageId: z.string().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        let mappedPageUrl: string | undefined
        if (input.pageId) {
          const page = await ctx.services.prisma.contentPage.findFirst({
            where: { id: input.pageId, workspaceId: ctx.workspace.id },
            select: { url: true },
          })
          if (!page) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: '关联页面不存在或不属于当前工作区' })
          }
          mappedPageUrl = page.url
        }
        return ctx.services.queryLibrary.addQuery({
          workspaceId: ctx.workspace.id,
          queryText: input.queryText,
          source: input.source.toUpperCase() as any,
          intent: input.intent,
          mappedPageUrl,
        })
      }),

    /**
     * 关联/改关联页面（QueryLibrary 行操作）。双归属校验：query 与 page 都必须落在
     * ctx.workspace.id 内——只校验一侧会让"改他人查询的映射"或"指向他人页面"成为可能。
     */
    setPageMapping: protectedProcedure
      .input(z.object({ queryId: z.string().min(1), pageId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const query = await ctx.services.prisma.citationQuery.findFirst({
          where: { id: input.queryId, workspaceId: ctx.workspace.id },
          select: { id: true },
        })
        if (!query) {
          throw new TRPCError({ code: 'NOT_FOUND', message: '查询不存在' })
        }
        const page = await ctx.services.prisma.contentPage.findFirst({
          where: { id: input.pageId, workspaceId: ctx.workspace.id },
          select: { url: true },
        })
        if (!page) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: '关联页面不存在或不属于当前工作区' })
        }
        return ctx.services.prisma.citationQuery.update({
          where: { id: input.queryId },
          data: { mappedPageUrl: page.url },
        })
      }),

    generate: protectedProcedure
      .input(
        z.object({
          topic: z.string(),
          count: z.number().min(1).max(100),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        return ctx.services.queryLibrary.generateQueries({
          workspaceId: ctx.workspace.id,
          topic: input.topic,
          count: input.count,
        })
      }),

    pause: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ ctx, input }) => {
        return ctx.services.queryLibrary.pauseQuery(input.id)
      }),

    resume: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ ctx, input }) => {
        return ctx.services.queryLibrary.resumeQuery(input.id)
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ ctx, input }) => {
        await ctx.services.queryLibrary.deleteQuery(input.id)
        return { ok: true }
      }),

    /**
     * 定时开关：scheduled=false 只退出**定时**，status=PAUSED 才退出所有运行（含手动）。
     * 两者语义独立，前端 QueryLibrary 的开关走这里（规格 §9）。
     */
    setScheduled: protectedProcedure
      .input(z.object({ id: z.string().min(1), scheduled: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const found = await ctx.services.prisma.citationQuery.findFirst({
          where: { id: input.id, workspaceId: ctx.workspace.id },
          select: { id: true },
        })
        if (!found) {
          throw new TRPCError({ code: 'NOT_FOUND', message: '查询不存在' })
        }
        return ctx.services.prisma.citationQuery.update({
          where: { id: input.id },
          data: { scheduled: input.scheduled },
        })
      }),

    // 语义检索：召回与文本最相似的 query（聚类去重 / FAQ 召回）
    findSimilar: protectedProcedure
      .input(
        z.object({
          text: z.string(),
          topK: z.number().min(1).max(50).optional(),
        }),
      )
      .query(async ({ ctx, input }) => {
        return ctx.services.queryLibrary.findSimilarQueries(
          ctx.workspace.id,
          input.text,
          input.topK ?? 10,
        )
      }),
  }),
})
