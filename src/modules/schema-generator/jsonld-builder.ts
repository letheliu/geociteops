import type { JsonLdDocument, SupportedSchemaType } from './types.js'
import { createSchemaRegistry } from './schema-registry.js'

export class MissingRequiredFieldError extends Error {
  constructor(public type: SupportedSchemaType, public field: string) {
    super(`Missing required field "${field}" for schema type "${type}"`)
    this.name = 'MissingRequiredFieldError'
  }
}

export class UnsupportedSchemaTypeError extends Error {
  constructor(public type: string) {
    super(`Unsupported schema type: "${type}"`)
    this.name = 'UnsupportedSchemaTypeError'
  }
}

export interface JsonLdBuilderService {
  build(input: { type: SupportedSchemaType; fields: Record<string, unknown> }): JsonLdDocument
}

export function createJsonLdBuilder() {
  const registry = createSchemaRegistry()

  return {
    build(input) {
      const def = registry.get(input.type)
      if (!def) throw new UnsupportedSchemaTypeError(input.type)

      // 校验必填字段
      for (const field of def.requiredFields) {
        const v = input.fields[field]
        if (v === undefined || v === null || v === '') {
          throw new MissingRequiredFieldError(input.type, field)
        }
      }

      // 过滤字段（仅保留 required + optional）
      const allowed = new Set([...def.requiredFields, ...def.optionalFields])
      const filtered: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(input.fields)) {
        if (allowed.has(k)) filtered[k] = v
      }

      return {
        '@context': 'https://schema.org',
        '@type': input.type,
        ...filtered,
      } as JsonLdDocument
    },
  } satisfies JsonLdBuilderService
}