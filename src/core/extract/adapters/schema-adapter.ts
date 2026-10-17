import type { RawEntity, TypeAdapter } from '../types.js'
import type { SchemaEntity, SupportedSchemaType } from '../../../modules/schema-generator/types.js'
import type { SchemaRegistryService } from '../../../modules/schema-generator/schema-registry.js'

interface TypeKeyword {
  type: SupportedSchemaType
  keywords: RegExp[]
}

const KEYWORD_RULES: TypeKeyword[] = [
  {
    type: 'SoftwareApplication',
    keywords: [/\bapp\b/i, /\bsoftware\b/i, /工具/, /应用/, /小程序/, /tool/i],
  },
  {
    type: 'Organization',
    keywords: [/\bcompany\b/i, /\borg(anization)?\b/i, /公司/, /组织/, /企业/, /团队/],
  },
  {
    type: 'Product',
    keywords: [/\bproduct\b/i, /产品/, /商品/],
  },
  {
    type: 'FAQPage',
    keywords: [/\bfaq\b/i, /问答/, /常见问题/],
  },
  {
    type: 'Article',
    keywords: [/\barticle\b/i, /\bblog\b/i, /\bpost\b/i, /文章/, /博客/],
  },
  {
    type: 'BreadcrumbList',
    keywords: [/\bbreadcrumb\b/i, /面包屑/],
  },
]

export interface SchemaAdapterService {
  adapt(raw: RawEntity[]): SchemaEntity[]
}

export function createSchemaAdapter(registry: SchemaRegistryService): SchemaAdapterService & TypeAdapter<SchemaEntity> {
  function mapType(rawType: string): SupportedSchemaType | null {
    for (const rule of KEYWORD_RULES) {
      if (rule.keywords.some((kw) => kw.test(rawType))) return rule.type
    }
    return null
  }

  function filterFields(type: SupportedSchemaType, props: Record<string, unknown>): Record<string, unknown> {
    const def = registry.get(type)
    if (!def) return {}
    const allowed = new Set([...def.requiredFields, ...def.optionalFields])
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(props)) {
      if (allowed.has(k)) out[k] = v
    }
    return out
  }

  return {
    adapt(raw) {
      const out: SchemaEntity[] = []
      for (const entity of raw) {
        const type = mapType(entity.rawType)
        if (!type) continue
        out.push({ type, fields: filterFields(type, entity.properties) })
      }
      return out
    },
  }
}