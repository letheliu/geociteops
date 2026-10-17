export type SupportedSchemaType =
  | 'SoftwareApplication'
  | 'WebApplication'
  | 'Organization'
  | 'LocalBusiness'
  | 'Product'
  | 'ProductGroup'
  | 'Offer'
  | 'Service'
  | 'FAQPage'
  | 'QAPage'
  | 'Article'
  | 'BlogPosting'
  | 'NewsArticle'
  | 'BreadcrumbList'
  | 'WebSite'
  | 'WebPage'
  | 'Person'
  | 'ProfilePage'
  | 'ContactPage'
  | 'VideoObject'
  | 'ImageObject'
  | 'Event'
  | 'JobPosting'
  | 'Course'
  | 'Review'
  | 'AggregateRating'
  | 'DiscussionForumPosting'

/** Schema 类型定义 */
export interface SchemaTypeDefinition {
  type: SupportedSchemaType
  requiredFields: string[]
  optionalFields: string[]
}

/** 适配器输出的 schema.org 实体 */
export interface SchemaEntity {
  type: SupportedSchemaType
  fields: Record<string, unknown>
}

/** Validator 错误 */
export interface ValidationError {
  path: string
  message: string
  code: 'MISSING_REQUIRED' | 'INVALID_TYPE' | 'INVALID_CONTEXT' | 'DEPRECATED'
}

/** Validator 结果 */
export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
  warnings: ValidationError[]
}

/** JSON-LD 文档 */
export interface JsonLdDocument {
  '@context': 'https://schema.org'
  '@type': SupportedSchemaType
  [key: string]: unknown
}

/** llms.txt section 输入 */
export interface LlmsTxtSection {
  title: string
  items: Array<{
    label: string
    url: string
    description: string
  }>
}

/** llms.txt 完整输入 */
export interface LlmsTxtInput {
  brandName: string
  tagline: string
  sections: LlmsTxtSection[]
  updateFrequency?: {
    docs?: string
    blog?: string
  }
}

/** autoBuildSections 输出 */
export interface AutoSectionsResult {
  sections: LlmsTxtSection[]
  updateFrequency?: {
    docs?: string
    blog?: string
  }
  warnings: string[]
}
