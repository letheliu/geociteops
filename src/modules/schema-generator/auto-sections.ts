import type { PrismaClient } from '@prisma/client'
import type { AutoSectionsResult, LlmsTxtSection } from './types.js'

export interface AutoSectionsService {
  buildSections(workspaceId: string): Promise<AutoSectionsResult>
}

const PRODUCT_TYPES = ['SoftwareApplication', 'Product']
const RESOURCE_PAGE_TYPES = ['blog', 'docs', 'whitepaper']

export function createAutoSections(deps: { prisma: PrismaClient }): AutoSectionsService {
  return {
    async buildSections(workspaceId) {
      const warnings: string[] = []
      const sections: LlmsTxtSection[] = []

      // 1. 核心产品（KG 实体）
      const entities = await deps.prisma.kgEntity.findMany({
        where: { workspaceId, type: { in: PRODUCT_TYPES } },
      })
      if (entities.length === 0) {
        warnings.push('核心产品 section：workspace 中没有 SoftwareApplication 或 Product 类型实体')
      } else {
        sections.push({
          title: '核心产品',
          items: entities.map((e) => {
            const props = (e.properties as any) ?? {}
            return {
              label: e.name,
              url: props.url ?? `/${slugify(e.name)}`,
              description: props.description ?? `${e.name} (${e.type})`,
            }
          }),
        })
      }

      // 2. 权威资源（ContentPage）
      const pages = await deps.prisma.contentPage.findMany({
        where: { workspaceId, pageType: { in: RESOURCE_PAGE_TYPES } },
      })
      if (pages.length === 0) {
        warnings.push('权威资源 section：workspace 中没有 blog/docs/whitepaper 类型页面')
      } else {
        sections.push({
          title: '权威资源',
          items: pages.map((p) => ({
            label: p.url,
            url: p.url,
            description: `(${p.pageType})`,
          })),
        })
      }

      // 3. 常见问答（ContentPage.optimizedContent 解析 FaqPair）
      const allPages = await deps.prisma.contentPage.findMany({
        where: { workspaceId, optimizedContent: { not: null } },
      })
      const faqItems: LlmsTxtSection['items'] = []
      for (const p of allPages) {
        try {
          const result = JSON.parse(p.optimizedContent!)
          const faqs = Array.isArray(result?.faqs) ? result.faqs : []
          for (const f of faqs) {
            if (f.question && f.answer) {
              faqItems.push({
                label: `Q: ${f.question}`,
                url: p.url,
                description: `A: ${f.answer}`,
              })
            }
          }
        } catch {
          warnings.push(`常见问答 section：${p.url} 的 optimizedContent 不是合法 JSON`)
        }
      }
      if (faqItems.length === 0) {
        warnings.push('常见问答 section：workspace 中没有可解析的 FAQ 数据')
      } else {
        sections.push({ title: '常见问答', items: faqItems })
      }

      // 4. 更新频率（默认值，后续可配置）— 单独字段，不在 sections 数组中
      const updateFrequency = { docs: '每周', blog: '每周 2 篇' }

      return { sections, updateFrequency, warnings }
    },
  }
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '')
}
