import { describe, it, expect } from 'vitest'
import { createSchemaAdapter } from './schema-adapter.js'
import { createSchemaRegistry } from '../../../modules/schema-generator/schema-registry.js'
import type { RawEntity } from '../types.js'

describe('SchemaTypeAdapter', () => {
  const adapter = createSchemaAdapter(createSchemaRegistry())

  it('rawType 含"工具"/"app" → SoftwareApplication', () => {
    const result = adapter.adapt([
      { name: 'zoomer AI', rawType: 'AI 设计工具', properties: { name: 'zoomer AI' } },
      { name: 'X', rawType: 'mobile app', properties: { name: 'X' } },
    ])
    expect(result).toHaveLength(2)
    expect(result[0].type).toBe('SoftwareApplication')
    expect(result[1].type).toBe('SoftwareApplication')
  })

  it('rawType 含"公司"/"company" → Organization', () => {
    const result = adapter.adapt([
      { name: 'Acme', rawType: 'SaaS company', properties: { name: 'Acme', url: 'https://acme.com' } },
    ])
    expect(result[0].type).toBe('Organization')
  })

  it('rawType 含"产品"/"product" → Product', () => {
    const result = adapter.adapt([
      { name: 'Pro', rawType: '产品', properties: { name: 'Pro' } },
    ])
    expect(result[0].type).toBe('Product')
  })

  it('rawType 含"faq"/"问答" → FAQPage', () => {
    const result = adapter.adapt([
      { name: 'FAQ', rawType: 'faq 列表', properties: { mainEntity: [] } },
    ])
    expect(result[0].type).toBe('FAQPage')
  })

  it('rawType 含"article"/"文章" → Article', () => {
    const result = adapter.adapt([
      { name: 'post', rawType: 'blog article', properties: { headline: 't', author: 'a' } },
    ])
    expect(result[0].type).toBe('Article')
  })

  it('rawType 含"breadcrumb"/"面包屑" → BreadcrumbList', () => {
    const result = adapter.adapt([
      { name: 'crumbs', rawType: 'breadcrumb 导航', properties: { itemListElement: [] } },
    ])
    expect(result[0].type).toBe('BreadcrumbList')
  })

  it('未匹配的 rawType 被跳过（不抛错）', () => {
    const result = adapter.adapt([
      { name: 'unknown', rawType: '杂七杂八的东西', properties: {} },
      { name: 'zoomer', rawType: 'AI 工具', properties: { name: 'zoomer' } },
    ])
    expect(result).toHaveLength(1)
    expect((result[0].fields as any).name).toBe('zoomer')
  })

  it('过滤掉不在白名单的 properties 字段', () => {
    const result = adapter.adapt([
      {
        name: 'zoomer',
        rawType: 'AI 工具',
        properties: { name: 'zoomer', applicationCategory: 'DesignApp', extra: 'drop me' },
      },
    ])
    expect((result[0].fields as any).extra).toBeUndefined()
    expect((result[0].fields as any).name).toBe('zoomer')
    expect((result[0].fields as any).applicationCategory).toBe('DesignApp')
  })

  it('空数组输入返回空数组', () => {
    expect(adapter.adapt([])).toEqual([])
  })
})