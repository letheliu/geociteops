import { z } from 'zod'
import { router, protectedProcedure } from '../../core/trpc/init.js'

export const taskRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        status: z.enum(['pending', 'in_progress', 'reviewed', 'published', 'failed']).optional(),
      }).optional(),
    )
    .query(async ({ ctx, input }) => {
      const status = input?.status ? input.status.toUpperCase() as any : undefined
      return ctx.services.taskService.list(ctx.workspace.id, status)
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.services.taskService.getById(input.id)
    }),

  review: protectedProcedure
    .input(z.object({
      id: z.string(),
      approved: z.boolean(),
      note: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return ctx.services.taskService.review(input.id, input.approved, input.note)
    }),

  publish: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.services.taskService.publish(input.id)
    }),
})
