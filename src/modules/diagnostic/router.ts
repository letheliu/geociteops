import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { router, protectedProcedure } from '../../core/trpc/init.js'
import { DiagnosticError } from './errors.js'

function handleError(err: unknown): never {
  if (err instanceof DiagnosticError) {
    const codeMap: Record<string, 'NOT_FOUND' | 'BAD_REQUEST' | 'TOO_MANY_REQUESTS' | 'PRECONDITION_FAILED' | 'INTERNAL_SERVER_ERROR'> = {
      PROJECT_NOT_FOUND: 'NOT_FOUND',
      NO_CONFIRMED_QUERIES: 'BAD_REQUEST',
      PLATFORM_NOT_CONFIGURED: 'BAD_REQUEST',
      RUN_SCOPE_TOO_LARGE: 'TOO_MANY_REQUESTS',
      RUN_NOT_EDITABLE: 'BAD_REQUEST',
      RUN_NOT_STARTABLE: 'PRECONDITION_FAILED',
      QUEUE_UNAVAILABLE: 'INTERNAL_SERVER_ERROR',
      NO_VALID_SAMPLES: 'BAD_REQUEST',
      REPORT_NOT_READY: 'BAD_REQUEST',
      ACTION_NOT_CONVERTIBLE: 'BAD_REQUEST',
      ALREADY_CONVERTED: 'BAD_REQUEST',
    }
    throw new TRPCError({
      code: codeMap[err.code] ?? 'BAD_REQUEST',
      message: err.code,
    })
  }
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal error' })
}

const projectRouter = router({
  list: protectedProcedure
    .input(z.object({ status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional() }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.services.diagnostic.projectService.list(ctx.workspace.id, input?.status as any)
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      try {
        return await ctx.services.diagnostic.projectService.get(ctx.workspace.id, input.id)
      } catch (err) { handleError(err) }
    }),

  create: protectedProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      brandName: z.string().min(1).max(100),
      brandAliases: z.array(z.string()).default([]),
      brandDomain: z.string().optional(),
      targetAudiences: z.array(z.string()),
      coreScenarios: z.array(z.string()),
      competitors: z.array(z.object({
        name: z.string(),
        domain: z.string().optional(),
        aliases: z.array(z.string()).optional(),
      })).max(20).default([]),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.services.diagnostic.projectService.create(ctx.workspace.id, input)
      } catch (err) { handleError(err) }
    }),

  update: protectedProcedure
    .input(z.object({
      id: z.string(),
      name: z.string().min(1).max(100).optional(),
      brandName: z.string().min(1).max(100).optional(),
      brandAliases: z.array(z.string()).optional(),
      brandDomain: z.string().optional(),
      targetAudiences: z.array(z.string()).optional(),
      coreScenarios: z.array(z.string()).optional(),
      competitors: z.array(z.object({
        name: z.string(),
        domain: z.string().optional(),
        aliases: z.array(z.string()).optional(),
      })).max(20).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input
      try {
        return await ctx.services.diagnostic.projectService.update(ctx.workspace.id, id, data)
      } catch (err) { handleError(err) }
    }),

  activate: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.services.diagnostic.projectService.activate(ctx.workspace.id, input.id)
      } catch (err) { handleError(err) }
    }),

  archive: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.services.diagnostic.projectService.archive(ctx.workspace.id, input.id)
      } catch (err) { handleError(err) }
    }),
})

const queryRouter = router({
  list: protectedProcedure
    .input(z.object({
      projectId: z.string(),
      queryType: z.enum(['BRAND', 'CATEGORY', 'SCENARIO', 'COMPARISON']).optional(),
      status: z.enum(['DRAFT', 'CONFIRMED', 'DISABLED']).optional(),
    }))
    .query(async ({ ctx, input }) => {
      return ctx.services.diagnostic.queryPlanner.list(ctx.workspace.id, input.projectId, input.queryType as any, input.status as any)
    }),

  generate: protectedProcedure
    .input(z.object({
      projectId: z.string(),
      counts: z.object({
        BRAND: z.number().min(0).max(50).default(0),
        CATEGORY: z.number().min(0).max(50).default(0),
        SCENARIO: z.number().min(0).max(50).default(0),
        COMPARISON: z.number().min(0).max(50).default(0),
      }),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.services.diagnostic.queryPlanner.generate(ctx.workspace.id, input.projectId, input.counts)
      } catch (err) { handleError(err) }
    }),

  create: protectedProcedure
    .input(z.object({
      projectId: z.string(),
      queryText: z.string().min(1),
      queryType: z.enum(['BRAND', 'CATEGORY', 'SCENARIO', 'COMPARISON']),
      source: z.enum(['MANUAL', 'LLM_GENERATED', 'IMPORTED']),
      intentLabel: z.string().optional(),
      targetAudience: z.string().optional(),
      mappedPageUrl: z.string().optional(),
      priority: z.number().min(1).max(5).default(3),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.services.diagnostic.queryPlanner.create(ctx.workspace.id, input.projectId, input)
      } catch (err) { handleError(err) }
    }),

  update: protectedProcedure
    .input(z.object({
      projectId: z.string(),
      queryId: z.string(),
      queryText: z.string().optional(),
      intentLabel: z.string().optional(),
      targetAudience: z.string().optional(),
      mappedPageUrl: z.string().optional(),
      priority: z.number().min(1).max(5).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { projectId, queryId, ...data } = input
      try {
        return await ctx.services.diagnostic.queryPlanner.update(ctx.workspace.id, projectId, queryId, data)
      } catch (err) { handleError(err) }
    }),

  bulkConfirm: protectedProcedure
    .input(z.object({
      projectId: z.string(),
      queryIds: z.array(z.string()).min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        return ctx.services.diagnostic.queryPlanner.bulkConfirm(ctx.workspace.id, input.projectId, input.queryIds)
      } catch (err) { handleError(err) }
    }),

  disable: protectedProcedure
    .input(z.object({
      projectId: z.string(),
      queryId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.services.diagnostic.queryPlanner.disable(ctx.workspace.id, input.projectId, input.queryId)
      } catch (err) { handleError(err) }
    }),

  findSimilar: protectedProcedure
    .input(z.object({
      projectId: z.string(),
      text: z.string(),
      topK: z.number().min(1).max(50).optional(),
    }))
    .query(async ({ ctx, input }) => {
      return ctx.services.diagnostic.queryPlanner.findSimilar(ctx.workspace.id, input.projectId, input.text, input.topK)
    }),
})

const runRouter = router({
  list: protectedProcedure
    .input(z.object({ projectId: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.services.diagnostic.runService.list(ctx.workspace.id, input?.projectId)
    }),

  get: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ ctx, input }) => {
      try {
        return await ctx.services.diagnostic.runService.get(ctx.workspace.id, input.runId)
      } catch (err) { handleError(err) }
    }),

  createDraft: protectedProcedure
    .input(z.object({
      projectId: z.string(),
      queryIds: z.array(z.string()).min(1),
      platforms: z.array(z.string()).min(1),
      samplesPerQuery: z.number().min(1).max(3),
      locale: z.string(),
      timezone: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      return ctx.services.diagnostic.runService.createDraft(ctx.workspace.id, input)
    }),

  updateDraft: protectedProcedure
    .input(z.object({
      runId: z.string(),
      queryIds: z.array(z.string()),
      platforms: z.array(z.string()),
      samplesPerQuery: z.number().min(1).max(3),
      locale: z.string(),
      timezone: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { runId, ...config } = input
      try {
        return await ctx.services.diagnostic.runService.updateDraft(ctx.workspace.id, runId, config)
      } catch (err) { handleError(err) }
    }),

  validate: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ ctx, input }) => {
      try {
        return await ctx.services.diagnostic.runService.validate(ctx.workspace.id, input.runId)
      } catch (err) { handleError(err) }
    }),

  markReady: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.services.diagnostic.runService.markReady(ctx.workspace.id, input.runId)
      } catch (err) { handleError(err) }
    }),

  start: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.services.diagnostic.runService.start(ctx.workspace.id, input.runId)
      } catch (err) { handleError(err) }
    }),

  cancel: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.services.diagnostic.runService.cancel(ctx.workspace.id, input.runId)
      } catch (err) { handleError(err) }
    }),

  retryDispatch: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.services.diagnostic.runService.retryDispatch(ctx.workspace.id, input.runId)
      } catch (err) { handleError(err) }
    }),

  retryFailed: protectedProcedure
    .input(z.object({ runId: z.string(), sampleIds: z.array(z.string()).optional() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.services.diagnostic.runService.retryFailed(ctx.workspace.id, input.runId, input.sampleIds)
      } catch (err) { handleError(err) }
    }),

  createRetest: protectedProcedure
    .input(z.object({ baselineRunId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.services.diagnostic.runService.createRetest(ctx.workspace.id, input.baselineRunId)
      } catch (err) { handleError(err) }
    }),
})

const reportRouter = router({
  get: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ ctx, input }) => {
      try {
        return await ctx.services.diagnostic.reportService.get(ctx.workspace.id, input.runId)
      } catch (err) { handleError(err) }
    }),

  compare: protectedProcedure
    .input(z.object({ baselineRunId: z.string(), retestRunId: z.string() }))
    .query(async ({ ctx, input }) => {
      try {
        return await ctx.services.diagnostic.reportService.compare(ctx.workspace.id, input.baselineRunId, input.retestRunId)
      } catch (err) { handleError(err) }
    }),
})

const actionRouter = router({
  list: protectedProcedure
    .input(z.object({
      runId: z.string(),
      horizon: z.enum(['DAYS_30', 'DAYS_60', 'DAYS_90']).optional(),
      status: z.enum(['PROPOSED', 'ACCEPTED', 'CONVERTED', 'DISMISSED']).optional(),
    }))
    .query(async ({ ctx, input }) => {
      return ctx.services.diagnostic.actionService.list(ctx.workspace.id, input.runId, input.horizon, input.status)
    }),

  accept: protectedProcedure
    .input(z.object({ actionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.services.diagnostic.actionService.accept(ctx.workspace.id, input.actionId)
      } catch (err) { handleError(err) }
    }),

  dismiss: protectedProcedure
    .input(z.object({ actionId: z.string(), reason: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.services.diagnostic.actionService.dismiss(ctx.workspace.id, input.actionId, input.reason)
      } catch (err) { handleError(err) }
    }),

  convert: protectedProcedure
    .input(z.object({ actionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.services.diagnostic.actionService.convert(ctx.workspace.id, input.actionId)
      } catch (err) { handleError(err) }
    }),
})

export const diagnosticRouter = router({
  projects: projectRouter,
  queries: queryRouter,
  runs: runRouter,
  reports: reportRouter,
  actions: actionRouter,
})
