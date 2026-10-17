import { describe, it, expect, vi } from 'vitest'
import { createAutoSections } from './auto-sections.js'
import type { PrismaClient } from '@prisma/client'

function mockPrisma(opts: {
  entities?: any[]
  pages?: any[]
} = {}) {
  const filterEntities = (where: any) => {
    let result = opts.entities ?? []
    if (where?.type?.in) {
      result = result.filter((e) => where.type.in.includes(e.type))
    }
    return result
  }
  const filterPages = (where: any) => {
    let result = opts.pages ?? []
    if (where?.pageType?.in) {
      result = result.filter((p) => where.pageType.in.includes(p.pageType))
    }
    if (where?.optimizedContent?.not === null) {
      result = result.filter((p) => p.optimizedContent != null)
    }
    return result
  }
  return {
    kgEntity: {
      findMany: vi.fn().mockImplementation(({ where }: any = {}) => Promise.resolve(filterEntities(where))),
    },
    contentPage: {
      findMany: vi.fn().mockImplementation(({ where }: any = {}) => Promise.resolve(filterPages(where))),
    },
  } as unknown as PrismaClient
}

describe('AutoSections', () => {
  it('从 KG 实体（SoftwareApplication/Product）收集核心产品 section', async () => {
    const prisma = mockPrisma({
      entities: [
        { name: 'zoomer AI', type: 'SoftwareApplication', properties: { url: 'https://x.com/zoomer' } },
        { name: 'Pro Plan', type: 'Product', properties: { url: 'https://x.com/pro' } },
        { name: 'Acme Co', type: 'Organization', properties: {} },
      ],
    })
    const svc = createAutoSections({ prisma })
    const result = await svc.buildSections('w1')
    const productSection = result.sections.find((s) => s.title === '核心产品')
    expect(productSection).toBeDefined()
    expect(productSection!.items).toHaveLength(2)
    expect(productSection!.items.map((i) => i.label)).toContain('zoomer AI')
  })

  it('从 ContentPage（blog/docs）收集权威资源 section', async () => {
    const prisma = mockPrisma({
      pages: [
        { url: 'https://x.com/blog/1', pageType: 'blog' },
        { url: 'https://x.com/docs/intro', pageType: 'docs' },
        { url: 'https://x.com/landing', pageType: 'landing' },
      ],
    })
    const svc = createAutoSections({ prisma })
    const result = await svc.buildSections('w1')
    const resourcesSection = result.sections.find((s) => s.title === '权威资源')
    expect(resourcesSection).toBeDefined()
    expect(resourcesSection!.items).toHaveLength(2)
  })

  it('从 ContentPage.optimizedContent 解析 FaqPair 收集常见问答 section', async () => {
    const faqResult = {
      faqs: [
        { question: '什么是 zoomer AI?', answer: '是 AI 设计工具' },
        { question: '价格如何?', answer: '免费' },
      ],
    }
    const prisma = mockPrisma({
      pages: [
        { url: 'https://x.com/landing', pageType: 'landing', optimizedContent: JSON.stringify(faqResult) },
      ],
    })
    const svc = createAutoSections({ prisma })
    const result = await svc.buildSections('w1')
    const faqSection = result.sections.find((s) => s.title === '常见问答')
    expect(faqSection).toBeDefined()
    expect(faqSection!.items).toHaveLength(2)
  })

  it('数据源缺失时收集 warnings', async () => {
    const prisma = mockPrisma({ entities: [], pages: [] })
    const svc = createAutoSections({ prisma })
    const result = await svc.buildSections('w1')
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings.some((w) => w.includes('核心产品'))).toBe(true)
    expect(result.updateFrequency).toBeDefined()
    expect(result.updateFrequency?.docs).toBe('每周')
    expect(result.updateFrequency?.blog).toBe('每周 2 篇')
    expect(result.sections.find((s) => s.title === '更新频率')).toBeUndefined()
  })

  it('optimizedContent 不是 JSON 时不抛错', async () => {
    const prisma = mockPrisma({
      pages: [{ url: 'https://x.com/landing', pageType: 'landing', optimizedContent: 'not json' }],
    })
    const svc = createAutoSections({ prisma })
    const result = await svc.buildSections('w1')
    expect(result.warnings.some((w) => w.includes('FAQ'))).toBe(true)
  })
})
