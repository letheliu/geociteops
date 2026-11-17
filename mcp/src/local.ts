/**
 * In-process tools. These modules do not open the database or the queue.
 * The MCP bundle imports them directly. A separate shared package is only
 * worth it if a second runtime needs the same engines.
 */
import { checkLlmsTxt, parseLlmsTxt } from '../../src/modules/agent-readiness/checks/llms-txt.js'
import { runAgentReadinessAudit } from '../../src/modules/agent-readiness/runner.js'
import { safeFetch } from '../../src/modules/agent-readiness/safe-fetch.js'
import { SsrfError } from '../../src/modules/agent-readiness/ssrf.js'
import type { AgentReadinessReport } from '../../src/modules/agent-readiness/types.js'
import { createDeprecationService } from '../../src/modules/schema-generator/deprecated-types.js'
import {
  createJsonLdBuilder,
  MissingRequiredFieldError,
  UnsupportedSchemaTypeError,
} from '../../src/modules/schema-generator/jsonld-builder.js'
import { createLlmsTxtBuilder } from '../../src/modules/schema-generator/llms-txt-builder.js'
import { createSchemaRegistry, SUPPORTED_TYPES } from '../../src/modules/schema-generator/schema-registry.js'
import type { LlmsTxtInput, SupportedSchemaType } from '../../src/modules/schema-generator/types.js'
import { createSchemaValidator } from '../../src/modules/schema-generator/validator.js'

const registry = createSchemaRegistry()
const jsonLd = createJsonLdBuilder()
const validator = createSchemaValidator(registry, createDeprecationService())
const llms = createLlmsTxtBuilder()

export const SCHEMA_TYPES = SUPPORTED_TYPES

export interface FetchedPage {
  url: string
  status: number
  body: string
  contentType: string
  error?: string
  errorMessage?: string
}

export async function fetchPublic(url: string): Promise<FetchedPage> {
  const outcome = await safeFetch(url, {
    headers: { accept: 'text/plain, text/html, text/markdown, */*;q=0.1' },
    maxBytes: 512_000,
    timeoutMs: 8_000,
  })
  return {
    url: outcome.url,
    status: outcome.status,
    body: outcome.body,
    contentType: outcome.headers['content-type'] ?? '',
    error: outcome.error,
    errorMessage: outcome.errorMessage,
  }
}

export async function auditUrl(url: string): Promise<AgentReadinessReport> {
  return runAgentReadinessAudit(url)
}

export function ssrfMessage(err: unknown): string | null {
  if (err instanceof SsrfError) return err.message
  return null
}

export interface BuiltSchema {
  jsonld: Record<string, unknown>
  valid: boolean
  errors: Array<{ path: string; message: string; code: string }>
  warnings: Array<{ path: string; message: string; code: string }>
}

export function buildSchema(schemaType: string, fields: Record<string, unknown>): BuiltSchema {
  if (!registry.isSupported(schemaType)) throw new UnsupportedSchemaTypeError(schemaType)
  const doc = jsonLd.build({ type: schemaType as SupportedSchemaType, fields })
  const validation = validator.validate(doc)
  return {
    jsonld: doc as unknown as Record<string, unknown>,
    valid: validation.valid,
    errors: validation.errors,
    warnings: validation.warnings,
  }
}

export function schemaError(err: unknown): string | null {
  if (err instanceof MissingRequiredFieldError || err instanceof UnsupportedSchemaTypeError) return err.message
  return null
}

export interface BuiltLlms {
  content: string
  warnings: string[]
}

export function buildLlmsTxt(input: LlmsTxtInput): BuiltLlms {
  return llms.build(input)
}

export interface LlmsValidation {
  status: 'pass' | 'warn' | 'fail'
  title: string | null
  summary: string | null
  linkCount: number
  explanation: string
  fix: string
}

export function validateLlmsText(text: string, status = 200, contentType = 'text/plain'): LlmsValidation {
  const parsed = parseLlmsTxt(text)
  const check = checkLlmsTxt({ status, body: text, contentType })
  return {
    status: check.check.status,
    title: parsed?.h1 ?? null,
    summary: parsed?.summary ?? null,
    linkCount: parsed?.links.length ?? 0,
    explanation: check.check.explanation.en,
    fix: check.check.fix.en,
  }
}

export function llmsTarget(input: string): string {
  const url = new URL(input)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('llms.txt URL must be http or https')
  }
  if (/\/llms\.txt$/i.test(url.pathname)) return url.toString()
  return `${url.origin}/llms.txt`
}
