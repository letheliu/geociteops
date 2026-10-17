import { z } from 'zod'
import { router, protectedProcedure } from '../../core/trpc/init.js'

export const citationRouter = router({
  // 手动触发单次监测
  trackQuery: protectedProcedure
    .input(z.object({
      query: z.string(),
      brand: z.string().optional(),
      platforms: z.array(z.string()),
    }))
    .mutation(async ({ ctx, input }) => {
      const events = await ctx.services.monitor.runOnce({
        workspaceId: ctx.workspace.id,
        platforms: input.platforms,
      })
      return { events }
    }),

  // 批量监测
  batchTrack: protectedProcedure
    .input(z.object({
      queries: z.array(z.string()),
      platforms: z.array(z.string()),
    }))
    .mutation(async ({ ctx, input }) => {
      const events = await ctx.services.monitor.runOnce({
        workspaceId: ctx.workspace.id,
        platforms: input.platforms,
      })
      return { events }
    }),

  // 查询报告
  getReport: protectedProcedure
    .input(z.object({
      dateRange: z.object({ start: z.string(), end: z.string() }),
      platform: z.string().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const where: any = {
        workspaceId: ctx.workspace.id,
        capturedAt: {
          gte: new Date(input.dateRange.start),
          lte: new Date(input.dateRange.end),
        },
      }
      if (input.platform) where.platform = input.platform
      const events = await ctx.services.prisma.citationEvent.findMany({
        where,
        include: { query: { select: { queryText: true } } },
      })
      return { events }
    }),

  // SOV 分数
  getSovScore: protectedProcedure
    .input(z.object({
      competitors: z.array(z.string()),
      dateRange: z.object({ start: z.string(), end: z.string() }),
    }))
    .query(async ({ ctx, input }) => {
      const events = await ctx.services.prisma.citationEvent.findMany({
        where: {
          workspaceId: ctx.workspace.id,
          capturedAt: {
            gte: new Date(input.dateRange.start),
            lte: new Date(input.dateRange.end),
          },
        },
      })
      const mentioned = events.filter((e: any) => e.brandMentioned).length
      const sovScore = events.length > 0 ? mentioned / events.length : 0
      return { sovScore, totalEvents: events.length, mentionedCount: mentioned }
    }),

  // 效果对比：按时间段对比 SOV 变化
  getEffectComparison: protectedProcedure
    .input(z.object({
      before: z.object({ start: z.string(), end: z.string() }),
      after: z.object({ start: z.string(), end: z.string() }),
      platform: z.string().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const baseWhere = {
        workspaceId: ctx.workspace.id,
        ...(input.platform ? { platform: input.platform } : {}),
      }

      const [beforeEvents, afterEvents] = await Promise.all([
        ctx.services.prisma.citationEvent.findMany({
          where: {
            ...baseWhere,
            capturedAt: { gte: new Date(input.before.start), lte: new Date(input.before.end) },
          },
        }),
        ctx.services.prisma.citationEvent.findMany({
          where: {
            ...baseWhere,
            capturedAt: { gte: new Date(input.after.start), lte: new Date(input.after.end) },
          },
        }),
      ])

      function calcStats(events: any[]) {
        const mentioned = events.filter((e) => e.brandMentioned).length
        const sov = events.length > 0 ? mentioned / events.length : 0
        const avgRank = events
          .filter((e) => e.rankInAnswer)
          .reduce((sum, e, _, arr) => sum + (e.rankInAnswer ?? 0) / arr.length, 0)
        return { totalEvents: events.length, mentionedCount: mentioned, sov, avgRank }
      }

      const beforeStats = calcStats(beforeEvents)
      const afterStats = calcStats(afterEvents)

      return {
        before: beforeStats,
        after: afterStats,
        delta: {
          sov: afterStats.sov - beforeStats.sov,
          mentionRate: afterStats.totalEvents > 0
            ? afterStats.mentionedCount / afterStats.totalEvents
            : 0 - (beforeStats.totalEvents > 0
              ? beforeStats.mentionedCount / beforeStats.totalEvents
              : 0),
          avgRank: afterStats.avgRank - beforeStats.avgRank,
        },
      }
    }),

  // query 库管理
  queries: router({
    list: protectedProcedure
      .input(z.object({ status: z.enum(['active', 'paused']).optional() }).optional())
      .query(async ({ ctx }) => {
        return ctx.services.queryLibrary.listActive(ctx.workspace.id)
      }),

    add: protectedProcedure
      .input(z.object({
        queryText: z.string(),
        source: z.enum(['manual', 'google_suggest', 'llm_generated', 'paa', 'competitor']),
        intent: z.record(z.unknown()).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        return ctx.services.queryLibrary.addQuery({
          workspaceId: ctx.workspace.id,
          queryText: input.queryText,
          source: input.source.toUpperCase() as any,
          intent: input.intent,
        })
      }),

    generate: protectedProcedure
      .input(z.object({
        topic: z.string(),
        count: z.number().min(1).max(100),
      }))
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

    // 语义检索：召回与文本最相似的 query（聚类去重 / FAQ 召回）
    findSimilar: protectedProcedure
      .input(z.object({
        text: z.string(),
        topK: z.number().min(1).max(50).optional(),
      }))
      .query(async ({ ctx, input }) => {
        return ctx.services.queryLibrary.findSimilarQueries(
          ctx.workspace.id,
          input.text,
          input.topK ?? 10,
        )
      }),
  }),
})
