import type { ValidationResult, ValidationError } from './types.js'
import type { SchemaRegistryService } from './schema-registry.js'
import type { DeprecationService } from './deprecated-types.js'

export interface SchemaValidatorService {
  validate(doc: unknown): ValidationResult
}

export function createSchemaValidator(
  registry: SchemaRegistryService,
  deprecation?: DeprecationService,
): SchemaValidatorService {
  return {
    validate(doc) {
      const errors: ValidationError[] = []
      const warnings: ValidationError[] = []

      if (!doc || typeof doc !== 'object') {
        errors.push({ path: '@context', message: 'Document must be an object', code: 'INVALID_CONTEXT' })
        return { valid: false, errors, warnings }
      }

      const obj = doc as Record<string, unknown>

      if (obj['@context'] !== 'https://schema.org') {
        errors.push({ path: '@context', message: '@context must be "https://schema.org"', code: 'INVALID_CONTEXT' })
      }

      const type = obj['@type']
      if (typeof type !== 'string') {
        errors.push({ path: '@type', message: `@type must be a string, got ${typeof type}`, code: 'INVALID_TYPE' })
        return { valid: false, errors, warnings }
      }

      if (deprecation?.isDeprecated(type)) {
        const deprecated = deprecation.get(type)!
        const replacementMsg = deprecated.replacement
          ? ` Use ${deprecated.replacement} instead.`
          : ' No replacement available.'
        warnings.push({
          path: '@type',
          message: `Schema type "${type}" is deprecated (retired ${deprecated.retiredDate}). ${deprecated.reason}.${replacementMsg}`,
          code: 'DEPRECATED',
        })
      }

      if (!registry.isSupported(type)) {
        errors.push({ path: '@type', message: `Unsupported schema type: ${type}`, code: 'INVALID_TYPE' })
        return { valid: false, errors, warnings }
      }

      const def = registry.get(type)!
      for (const field of def.requiredFields) {
        const v = obj[field]
        if (v === undefined || v === null || v === '') {
          errors.push({
            path: field,
            message: `Missing required field "${field}" for type "${type}"`,
            code: 'MISSING_REQUIRED',
          })
        }
      }

      return { valid: errors.length === 0, errors, warnings }
    },
  }
}
