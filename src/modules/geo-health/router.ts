import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { router, protectedProcedure } from '../../core/trpc/init.js'
import { GeoHealthError } from './errors.js'

function handleError(err: unknown): never {
  if (err instanceof GeoHealthError) {
    const code = err.code === 'NOT_FOUND'
      ? 'NOT_FOUND'
      : err.code === 'NOT_READY'
        ? 'BAD_REQUEST'
        : err.code === 'QUEUE_UNAVAILABLE'
          ? 'INTERNAL_SERVER_ERROR'
          : 'BAD_REQUEST'
    throw new TRPCError({ code, message: err.message })
  }
  throw err
}

const startInput = z.object({
  brandName: z.string().trim().min(1).max(80),
  siteUrl: z.string().trim().min(1).max(2048),
  industry: z.string().trim().max(80).optional(),
  competitors: z.array(z.string().trim().min(1).max(80)).max(8).optional(),
  queries: z.array(z.string().trim().min(1).max(300)).max(10).optional(),
  language: z.enum(['zh', 'en', 'auto']).optional(),
})

export const geoHealthRouter = router({
  start: protectedProcedure
    .input(startInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.services.geoHealth.start(ctx.workspace.id, input)
      } catch (err) {
        handleError(err)
      }
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        return await ctx.services.geoHealth.get(ctx.workspace.id, input.id)
      } catch (err) {
        handleError(err)
      }
    }),

  list: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).optional() }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.services.geoHealth.list(ctx.workspace.id, input?.limit)
    }),

  saveQueries: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.services.geoHealth.saveQueries(ctx.workspace.id, input.id)
      } catch (err) {
        handleError(err)
      }
    }),

  export: protectedProcedure
    .input(z.object({
      id: z.string().min(1),
      format: z.enum(['markdown', 'json']),
    }))
    .query(async ({ ctx, input }) => {
      try {
        return await ctx.services.geoHealth.exportReport(ctx.workspace.id, input.id, input.format)
      } catch (err) {
        handleError(err)
      }
    }),
})
