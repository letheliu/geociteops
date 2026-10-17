import type { PrismaClient, SchemaRecord } from '@prisma/client'
import type { EntityExtractorService } from '../../core/extract/entity-extractor.js'
import type { SchemaAdapterService } from '../../core/extract/adapters/schema-adapter.js'
import type { JsonLdDocument } from './types.js'
import type { JsonLdBuilderService } from './jsonld-builder.js'
import type { LlmsTxtBuilderService } from './llms-txt-builder.js'
import type { SchemaValidatorService } from './validator.js'
import type { SupportedSchemaType } from './types.js'
import type { AutoSectionsService } from './auto-sections.js'
import type { AutoSectionsResult, LlmsTxtInput } from './types.js'
import type { SchemaRegistryService } from './schema-registry.js'

export interface SchemaService {
  generateJsonLd(input: {
    workspaceId: string
    pageUrl: string
    schemaType: SupportedSchemaType
    fields: Record<string, unknown>
  }): Promise<{ jsonld: JsonLdDocument; record: SchemaRecord }>

  generateLlmsTxt(input: {
    workspaceId: string
    pageUrl?: string
    brandName: string
    tagline: string
    sections: LlmsTxtInput['sections']
    updateFrequency?: LlmsTxtInput['updateFrequency']
  }): Promise<{ markdown: string; record: SchemaRecord; warnings: string[] }>

  regenerateForPage(pageId: string): Promise<SchemaRecord[]>

  list(input: { workspaceId: string; pageUrl?: string; schemaType?: string }): Promise<SchemaRecord[]>
  getById(workspaceId: string, id: string): Promise<SchemaRecord | null>

  buildAutoSections(workspaceId: string): Promise<AutoSectionsResult>
}

export function createSchemaService(deps: {
  prisma: PrismaClient
  extractor: EntityExtractorService
  schemaAdapter: SchemaAdapterService
  jsonLdBuilder: JsonLdBuilderService
  llmsTxtBuilder: LlmsTxtBuilderService
  validator: SchemaValidatorService
  autoSections: AutoSectionsService
  schemaRegistry: SchemaRegistryService
}): SchemaService {
  async function getNextVersion(workspaceId: string, pageUrl: string): Promise<number> {
    const latest = await deps.prisma.schemaRecord.findFirst({
      where: { workspaceId, pageUrl },
      orderBy: { version: 'desc' },
    })
    return (latest?.version ?? 0) + 1
  }

  return {
    async generateJsonLd(input) {
      const jsonld = deps.jsonLdBuilder.build({ type: input.schemaType, fields: input.fields })
      const validation = deps.validator.validate(jsonld)
      if (!validation.valid) {
        throw new Error(`Schema validation failed: ${validation.errors.map((e: { message: string }) => e.message).join('; ')}`)
      }

      const version = await getNextVersion(input.workspaceId, input.pageUrl)
      const record = await deps.prisma.schemaRecord.create({
        data: {
          workspaceId: input.workspaceId,
          pageUrl: input.pageUrl,
          schemaType: input.schemaType,
          content: jsonld as any,
          version,
        },
      })
      return { jsonld, record }
    },

    async generateLlmsTxt(input) {
      const buildResult = deps.llmsTxtBuilder.build({
        brandName: input.brandName,
        tagline: input.tagline,
        sections: input.sections,
        updateFrequency: input.updateFrequency,
      })
      const markdown = buildResult.content
      const pageUrl = input.pageUrl ?? '/llms.txt'
      const version = await getNextVersion(input.workspaceId, pageUrl)
      const record = await deps.prisma.schemaRecord.create({
        data: {
          workspaceId: input.workspaceId,
          pageUrl,
          schemaType: 'LlmsTxt',
          content: { markdown, warnings: buildResult.warnings } as any,
          llmsTxtSection: 'all',
          version,
        },
      })
      return { markdown, record, warnings: buildResult.warnings }
    },

    async regenerateForPage(pageId) {
      const page = await deps.prisma.contentPage.findUnique({ where: { id: pageId } })
      if (!page) return []

      const extraction = await deps.extractor.extract(page.currentContent)
      const schemaEntities = deps.schemaAdapter.adapt(extraction.entities)

      // 1. 预收集通过 validate 的实体类型（按 type 去重）
      const validTypes = new Set<SupportedSchemaType>()
      const validated: Array<{ entity: typeof schemaEntities[number]; jsonld: JsonLdDocument }> = []
      for (const entity of schemaEntities) {
        try {
          const jsonld = deps.jsonLdBuilder.build({ type: entity.type, fields: entity.fields })
          const validation = deps.validator.validate(jsonld)
          if (!validation.valid) continue
          validTypes.add(entity.type)
          validated.push({ entity, jsonld })
        } catch {
          // 跳过构建/校验失败的实体
        }
      }

      // 2. 清理同一 workspace + pageUrl 上 pass-types 的旧记录，防止无界增长
      if (validTypes.size > 0) {
        await deps.prisma.schemaRecord.deleteMany({
          where: {
            workspaceId: page.workspaceId,
            pageUrl: page.url,
            schemaType: { in: Array.from(validTypes) },
          },
        })
      }

      // 3. 写入新记录
      const records: SchemaRecord[] = []
      for (const { entity, jsonld } of validated) {
        const version = await getNextVersion(page.workspaceId, page.url)
        const record = await deps.prisma.schemaRecord.create({
          data: {
            workspaceId: page.workspaceId,
            pageUrl: page.url,
            schemaType: entity.type,
            content: jsonld as any,
            version,
          },
        })
        records.push(record)
      }
      return records
    },

    async list(input) {
      const where: any = { workspaceId: input.workspaceId }
      if (input.pageUrl) where.pageUrl = input.pageUrl
      if (input.schemaType) where.schemaType = input.schemaType
      return deps.prisma.schemaRecord.findMany({ where, orderBy: { createdAt: 'desc' } })
    },

    async getById(workspaceId, id) {
      return deps.prisma.schemaRecord.findFirst({ where: { id, workspaceId } })
    },

    async buildAutoSections(workspaceId) {
      return deps.autoSections.buildSections(workspaceId)
    },
  }
}