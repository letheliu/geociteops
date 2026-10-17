import { describe, it, expect, vi } from 'vitest'
import { createSchemaService } from './service.js'
import type { PrismaClient, SchemaRecord } from '@prisma/client'
import type { EntityExtractorService } from '../../core/extract/entity-extractor.js'
import type { SchemaAdapterService } from '../../core/extract/adapters/schema-adapter.js'
import type { JsonLdBuilderService } from './jsonld-builder.js'
import type { LlmsTxtBuilderService } from './llms-txt-builder.js'
import type { SchemaValidatorService } from './validator.js'
import type { AutoSectionsService } from './auto-sections.js'
import type { SchemaRegistryService } from './schema-registry.js'

function mockPrisma() {
  return {
    schemaRecord: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({
        id: `sr-${Math.random()}`,
        ...data,
        createdAt: new Date(),
      })),
      findFirst: vi.fn().mockResolvedValue({ version: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    contentPage: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'page-1',
        workspaceId: 'w1',
        url: 'https://x.com/landing',
        currentContent: 'zoomer AI 是 AI 设计工具',
      }),
    },
  } as unknown as PrismaClient
}

function mockDeps(prisma = mockPrisma()) {
  const extractor: EntityExtractorService = {
    extract: vi.fn().mockResolvedValue({
      entities: [
        { name: 'zoomer AI', rawType: 'AI 设计工具', properties: { name: 'zoomer AI', applicationCategory: 'DesignApplication' } },
      ],
      relations: [],
    }),
  }
  const schemaAdapter: SchemaAdapterService = {
    adapt: vi.fn().mockReturnValue([
      { type: 'SoftwareApplication', fields: { name: 'zoomer AI', applicationCategory: 'DesignApplication' } },
    ]),
  }
  const jsonLdBuilder: JsonLdBuilderService = {
    build: vi.fn().mockReturnValue({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'zoomer AI',
      applicationCategory: 'DesignApplication',
    }),
  }
  const llmsTxtBuilder: LlmsTxtBuilderService = {
    build: vi.fn().mockReturnValue({ content: '# zoomer AI\n> tagline\n', warnings: ['No major AI search system'] }),
    buildRaw: vi.fn().mockReturnValue('# zoomer AI\n> tagline\n'),
    parseMarkdown: vi.fn(),
  }
  const validator: SchemaValidatorService = {
    validate: vi.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }),
  }
  const autoSections: AutoSectionsService = {
    buildSections: vi.fn().mockResolvedValue({ sections: [], warnings: [] }),
  }
  const schemaRegistry: SchemaRegistryService = {
    get: vi.fn(),
    isSupported: vi.fn().mockReturnValue(true),
    list: vi.fn().mockReturnValue([]),
  }
  return { prisma, extractor, schemaAdapter, jsonLdBuilder, llmsTxtBuilder, validator, autoSections, schemaRegistry }
}

describe('SchemaService', () => {
  it('generateJsonLd 校验 → 写入 → 返回', async () => {
    const deps = mockDeps()
    const svc = createSchemaService(deps)
    const result = await svc.generateJsonLd({
      workspaceId: 'w1', pageUrl: 'https://x.com/landing',
      schemaType: 'SoftwareApplication',
      fields: { name: 'zoomer AI', applicationCategory: 'DesignApp' },
    })
    expect(result.jsonld['@type']).toBe('SoftwareApplication')
    expect(result.record.id).toBeDefined()
    expect(deps.prisma.schemaRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 'w1',
        schemaType: 'SoftwareApplication',
        version: 2,  // 已有 version=1，+1 = 2
      }),
    })
  })

  it('generateJsonLd 校验失败时抛错', async () => {
    const deps = mockDeps()
    ;(deps.validator.validate as any).mockReturnValue({
      valid: false,
      errors: [{ path: 'name', message: 'required', code: 'MISSING_REQUIRED' }],
    })
    const svc = createSchemaService(deps)
    await expect(
      svc.generateJsonLd({
        workspaceId: 'w1', pageUrl: 'https://x.com',
        schemaType: 'SoftwareApplication', fields: {},
      }),
    ).rejects.toThrow()
  })

  it('generateLlmsTxt 输出 markdown 并写入记录', async () => {
    const deps = mockDeps()
    const svc = createSchemaService(deps)
    const result = await svc.generateLlmsTxt({
      workspaceId: 'w1', brandName: 'zoomer', tagline: 'AI',
      sections: [{ title: '核心产品', items: [] }],
    })
    expect(result.markdown).toContain('# zoomer')
    expect(result.record.schemaType).toBe('LlmsTxt')
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('No major AI search system')
  })

  it('regenerateForPage 调用 extractor → adapter → builder → 写入多条记录', async () => {
    const deps = mockDeps()
    const svc = createSchemaService(deps)
    const records = await svc.regenerateForPage('page-1')
    expect(records.length).toBeGreaterThan(0)
    expect(deps.extractor.extract).toHaveBeenCalled()
    expect(deps.schemaAdapter.adapt).toHaveBeenCalled()
  })

  it('regenerateForPage 校验失败的实体被跳过', async () => {
    const deps = mockDeps()
    ;(deps.validator.validate as any).mockReturnValue({
      valid: false, errors: [{ path: '@type', message: 'bad', code: 'INVALID_TYPE' }],
    })
    const svc = createSchemaService(deps)
    const records = await svc.regenerateForPage('page-1')
    expect(records).toEqual([])
  })

  it('regenerateForPage 写入前清理同 pageUrl 同 schemaType 的旧记录', async () => {
    const deps = mockDeps()
    const svc = createSchemaService(deps)
    const records = await svc.regenerateForPage('page-1')
    expect(records.length).toBeGreaterThan(0)
    expect(deps.prisma.schemaRecord.deleteMany).toHaveBeenCalledWith({
      where: {
        workspaceId: 'w1',
        pageUrl: 'https://x.com/landing',
        schemaType: { in: ['SoftwareApplication'] },
      },
    })
  })

  it('regenerateForPage 当无有效实体时不调用 deleteMany', async () => {
    const deps = mockDeps()
    ;(deps.validator.validate as any).mockReturnValue({
      valid: false, errors: [{ path: '@type', message: 'bad', code: 'INVALID_TYPE' }],
    })
    const svc = createSchemaService(deps)
    await svc.regenerateForPage('page-1')
    expect(deps.prisma.schemaRecord.deleteMany).not.toHaveBeenCalled()
  })

  it('buildAutoSections 透传', async () => {
    const deps = mockDeps()
    const svc = createSchemaService(deps)
    await svc.buildAutoSections('w1')
    expect(deps.autoSections.buildSections).toHaveBeenCalledWith('w1')
  })

  it('list / getById 透传 prisma', async () => {
    const deps = mockDeps()
    const svc = createSchemaService(deps)
    await svc.list({ workspaceId: 'w1' })
    expect(deps.prisma.schemaRecord.findMany).toHaveBeenCalled()
    await svc.getById('w1', 'sr-1')
    expect(deps.prisma.schemaRecord.findFirst).toHaveBeenCalledWith({ where: { id: 'sr-1', workspaceId: 'w1' } })
  })
})