import { z } from 'zod'
import { router, protectedProcedure } from '../../core/trpc/init.js'

const SUPPORTED_SCHEMA_TYPES = [
  'SoftwareApplication',
  'Organization',
  'Product',
  'FAQPage',
  'Article',
  'BreadcrumbList',
] as const

export const schemaRouter = router({
  generate: router({
    jsonLd: protectedProcedure
      .input(z.object({
        pageUrl: z.string(),
        schemaType: z.enum(SUPPORTED_SCHEMA_TYPES),
        fields: z.record(z.unknown()),
      }))
      .mutation(async ({ ctx, input }) => {
        return ctx.services.schema.generateJsonLd({
          workspaceId: ctx.workspace.id,
          ...input,
        })
      }),

    llmsTxt: protectedProcedure
      .input(z.object({
        pageUrl: z.string().optional(),
        brandName: z.string(),
        tagline: z.string(),
        sections: z.array(z.object({
          title: z.string(),
          items: z.array(z.object({
            label: z.string(),
            url: z.string(),
            description: z.string(),
          })),
        })),
        updateFrequency: z.object({
          docs: z.string().optional(),
          blog: z.string().optional(),
        }).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        return ctx.services.schema.generateLlmsTxt({
          workspaceId: ctx.workspace.id,
          ...input,
        })
      }),
  }),

  autoSections: protectedProcedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      return ctx.services.schema.buildAutoSections(ctx.workspace.id)
    }),

  list: protectedProcedure
    .input(z.object({
      pageUrl: z.string().optional(),
      schemaType: z.string().optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.services.schema.list({
        workspaceId: ctx.workspace.id,
        pageUrl: input?.pageUrl,
        schemaType: input?.schemaType,
      })
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.services.schema.getById(ctx.workspace.id, input.id)
    }),

  regenerateForPage: protectedProcedure
    .input(z.object({ pageId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.services.schema.regenerateForPage(input.pageId)
    }),
})
