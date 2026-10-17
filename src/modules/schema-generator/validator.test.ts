import { describe, it, expect } from 'vitest'
import { createSchemaValidator } from './validator.js'
import { createSchemaRegistry } from './schema-registry.js'
import { createDeprecationService } from './deprecated-types.js'

describe('SchemaValidator', () => {
  const validator = createSchemaValidator(createSchemaRegistry(), createDeprecationService())

  it('合法 JSON-LD 返回 valid: true', () => {
    const result = validator.validate({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'zoomer AI',
      applicationCategory: 'DesignApplication',
    })
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('@context 错误返回 INVALID_CONTEXT', () => {
    const result = validator.validate({
      '@context': 'https://example.com',
      '@type': 'SoftwareApplication',
      name: 'x',
      applicationCategory: 'y',
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_CONTEXT')).toBe(true)
  })

  it('@type 不在白名单返回 INVALID_TYPE', () => {
    const result = validator.validate({
      '@context': 'https://schema.org',
      '@type': 'UnknownType',
      name: 'x',
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_TYPE')).toBe(true)
  })

  it('必填字段缺失返回 MISSING_REQUIRED', () => {
    const result = validator.validate({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'x',
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'MISSING_REQUIRED' && e.path === 'applicationCategory')).toBe(true)
  })

  it('多重错误同时报告', () => {
    const result = validator.validate({
      '@context': 'https://example.com',
      '@type': 'UnknownType',
    })
    expect(result.valid).toBe(false)
    const codes = result.errors.map((e) => e.code)
    expect(codes).toContain('INVALID_CONTEXT')
    expect(codes).toContain('INVALID_TYPE')
  })

  it('非对象输入返回 INVALID_CONTEXT', () => {
    const result = validator.validate(null)
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('INVALID_CONTEXT')
  })

  it('废弃类型产生 DEPRECATED 警告', () => {
    const result = validator.validate({
      '@context': 'https://schema.org',
      '@type': 'HowTo',
      name: 'x',
    })
    expect(result.valid).toBe(false)
    expect(result.warnings.some((w) => w.code === 'DEPRECATED')).toBe(true)
    expect(result.warnings[0].message).toContain('HowTo')
    expect(result.warnings[0].message).toContain('deprecated')
  })

  it('废弃类型有替代方案时提示替代类型', () => {
    const result = validator.validate({
      '@context': 'https://schema.org',
      '@type': 'SpecialAnnouncement',
      name: 'x',
    })
    expect(result.warnings.some((w) => w.message.includes('Event'))).toBe(true)
  })

  it('新增类型（BlogPosting）验证通过', () => {
    const result = validator.validate({
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: 'Test Post',
      author: { '@type': 'Person', name: 'Author' },
    })
    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })

  it('新增类型（Person）缺少必填字段报错', () => {
    const result = validator.validate({
      '@context': 'https://schema.org',
      '@type': 'Person',
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'MISSING_REQUIRED' && e.path === 'name')).toBe(true)
  })

  it('不传 deprecation 时不检测废弃类型', () => {
    const noDeprecationValidator = createSchemaValidator(createSchemaRegistry())
    const result = noDeprecationValidator.validate({
      '@context': 'https://schema.org',
      '@type': 'HowTo',
      name: 'x',
    })
    expect(result.valid).toBe(false)
    expect(result.warnings).toHaveLength(0)
  })
})
