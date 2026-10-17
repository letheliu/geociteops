import { z } from 'zod'
import { router, protectedProcedure } from '../../core/trpc/init.js'

export const contentRouter = router({
  pages: router({
    // 任务 9：经 page service（maxPages 软限检查点 + PAGE_CREATED 计量在 service 内）
    upsert: protectedProcedure
      .input(z.object({
        url: z.string(),
        pageType: z.string(),
        currentContent: z.string(),
      }))
      .mutation(async ({ ctx, input }) => {
        return ctx.services.pages.upsert({
          workspaceId: ctx.workspace.id,
          url: input.url,
          pageType: input.pageType,
          currentContent: input.currentContent,
        })
      }),

    list: protectedProcedure
      .input(
        z.object({
          status: z.enum(['draft', 'reviewed', 'published']).optional(),
        }).optional(),
      )
      .query(async ({ ctx, input }) => {
        const where: any = { workspaceId: ctx.workspace.id }
        if (input?.status) {
          where.status = input.status.toUpperCase()
        }
        return ctx.services.prisma.contentPage.findMany({ where })
      }),

    get: protectedProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ ctx, input }) => {
        return ctx.services.prisma.contentPage.findUnique({
          where: { id: input.id },
        })
      }),
  }),

  optimize: protectedProcedure
    .input(z.object({
      pageId: z.string().optional(),
      content: z.string().optional(),
      url: z.string().optional(),
      pageType: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return ctx.services.orchestrator.optimize({
        workspaceId: ctx.workspace.id,
        content: input.content || '',
        pageId: input.pageId,
        url: input.url,
        pageType: input.pageType,
      })
    }),

  atomize: protectedProcedure
    .input(z.object({ text: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const atoms = await ctx.services.atomizer.atomize(input.text)
      return { atoms }
    }),

  generateFaq: protectedProcedure
    .input(z.object({
      topic: z.string(),
      count: z.number().min(1).max(20).default(5),
    }))
    .mutation(async ({ ctx, input }) => {
      const faqs = await ctx.services.faqGenerator.generate({
        atoms: [{ text: input.topic, subject: '', predicate: '', object: '', anchors: [] }],
        workspaceId: ctx.workspace.id,
        count: input.count,
      })
      return { faqs }
    }),

  // 语义检索：跨页召回与文本最相似的内容原子（去重 / RAG）
  findSimilarAtoms: protectedProcedure
    .input(z.object({
      text: z.string(),
      topK: z.number().min(1).max(50).optional(),
    }))
    .query(async ({ ctx, input }) => {
      return ctx.services.orchestrator.findSimilarAtoms(
        ctx.workspace.id,
        input.text,
        input.topK ?? 10,
      )
    }),
})
