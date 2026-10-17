import { z } from 'zod'
import { router, protectedProcedure } from '../../core/trpc/init.js'

export const kgRouter = router({
  addEntity: protectedProcedure
    .input(z.object({
      name: z.string(),
      type: z.string(),
      properties: z.record(z.unknown()).default({}),
      sourceUrl: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return ctx.services.kg.addEntity({
        workspaceId: ctx.workspace.id,
        ...input,
      })
    }),

  addRelation: protectedProcedure
    .input(z.object({
      fromName: z.string(),
      toName: z.string(),
      relationType: z.string(),
      properties: z.record(z.unknown()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return ctx.services.kg.addRelation({
        workspaceId: ctx.workspace.id,
        ...input,
      })
    }),

  removeEntity: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.services.kg.removeEntity(input.id)
    }),

  listEntities: protectedProcedure
    .input(z.object({ type: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.services.kg.listEntities(ctx.workspace.id, { type: input?.type })
    }),

  listRelations: protectedProcedure
    .input(z.object({
      fromId: z.string().optional(),
      toId: z.string().optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.services.kg.listRelations(ctx.workspace.id, {
        fromId: input?.fromId,
        toId: input?.toId,
      })
    }),

  getEntity: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.services.kg.getEntity(ctx.workspace.id, input.id)
    }),

  // 语义检索：召回与名称最相似的实体（消歧辅助 / 实体搜索）
  findSimilar: protectedProcedure
    .input(z.object({
      name: z.string(),
      topK: z.number().min(1).max(50).optional(),
    }))
    .query(async ({ ctx, input }) => {
      return ctx.services.kg.findSimilarEntities(ctx.workspace.id, input.name, input.topK ?? 10)
    }),

  extractFromPage: protectedProcedure
    .input(z.object({ pageId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.services.kg.extractFromPage(input.pageId)
    }),

  export: protectedProcedure
    .input(z.object({
      format: z.enum(['jsonld', 'turtle']),
      entityIds: z.array(z.string()).optional(),
    }))
    .query(async ({ ctx, input }) => {
      return ctx.services.kg.exportGraph({
        workspaceId: ctx.workspace.id,
        format: input.format,
        entityIds: input.entityIds,
      })
    }),
})
