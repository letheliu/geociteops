import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { router, protectedProcedure } from '../../core/trpc/init.js'
import { AgentReadinessError } from './errors.js'

function handleError(err: unknown): never {
  if (err instanceof AgentReadinessError) {
    const code = err.code === 'NOT_FOUND'
      ? 'NOT_FOUND'
      : err.code === 'QUEUE_UNAVAILABLE'
        ? 'INTERNAL_SERVER_ERROR'
        : 'BAD_REQUEST'
    throw new TRPCError({ code, message: err.message })
  }
  throw err
}

export const agentReadinessRouter = router({
  start: protectedProcedure
    .input(z.object({ url: z.string().min(1).max(2048) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.services.agentReadiness.start(ctx.workspace.id, input.url)
      } catch (err) {
        handleError(err)
      }
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        return await ctx.services.agentReadiness.get(ctx.workspace.id, input.id)
      } catch (err) {
        handleError(err)
      }
    }),

  list: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).optional() }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.services.agentReadiness.list(ctx.workspace.id, input?.limit)
    }),
})
