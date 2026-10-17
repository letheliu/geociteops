import type { PrismaClient } from '@prisma/client'
import type { PlatformAdapter } from '../citation-monitor/platform-adapters/types.js'
import type { CitationAnalysis } from '../citation-monitor/analyzer.js'
import { normalizePlatformResult } from '../citation-monitor/platform-adapters/types.js'

export interface ClassifiedSampleError {
  code: 'RATE_LIMITED' | 'PLATFORM_ERROR' | 'NETWORK_ERROR' | 'CONFIGURATION_ERROR' | 'UNSUPPORTED_PLATFORM' | 'PARSE_ERROR' | 'INVALID_CONTEXT' | 'CANCELLED'
  retryable: boolean
  message: string
}

export function classifySampleError(err: any): ClassifiedSampleError {
  const status = err.status ?? err.statusCode ?? err.response?.status
  const message = err.message ?? String(err)

  // CANCELLED is special
  if (message.includes('CANCELLED') || message === 'CANCELLED') {
    return { code: 'CANCELLED', retryable: false, message: 'CANCELLED' }
  }

  // Configuration errors: 401, 403
  if (status === 401 || status === 403) {
    return { code: 'CONFIGURATION_ERROR', retryable: false, message: sanitizeMessage(message) }
  }

  // Rate limited: 408, 429
  if (status === 408 || status === 429) {
    return { code: 'RATE_LIMITED', retryable: true, message: sanitizeMessage(message) }
  }

  // Server errors: 500-599
  if (status && status >= 500 && status < 600) {
    return { code: 'PLATFORM_ERROR', retryable: true, message: sanitizeMessage(message) }
  }

  // Network errors
  if (message.includes('ETIMEDOUT') || message.includes('ECONNREFUSED') || message.includes('ECONNRESET') || message.includes('ENOTFOUND') || message.includes('network') || message.includes('timeout')) {
    return { code: 'NETWORK_ERROR', retryable: true, message: sanitizeMessage(message) }
  }

  // Parse errors
  if (message.includes('parse') || message.includes('PARSE') || message.includes('invalid json')) {
    return { code: 'PARSE_ERROR', retryable: false, message: sanitizeMessage(message) }
  }

  // Unsupported platform
  if (message.includes('UNSUPPORTED_PLATFORM') || message.includes('not found') || message.includes('not registered')) {
    return { code: 'UNSUPPORTED_PLATFORM', retryable: false, message: sanitizeMessage(message) }
  }

  // Default: platform error, retryable
  return { code: 'PLATFORM_ERROR', retryable: true, message: sanitizeMessage(message) }
}

function sanitizeMessage(msg: string): string {
  // Remove sensitive data - API keys, tokens, credentials
  return msg.replace(/[A-Za-z0-9-_]{20,}/g, '[REDACTED]').slice(0, 500)
}

export interface ExecuteInput {
  sampleId: string
  runId: string
  workspaceId: string
  platform: string
  queryText: string
  brandSnapshot: {
    brandName: string
    brandAliases: string[]
    brandDomain?: string
  }
  competitorSnapshot: Array<{
    name: string
    domain?: string
    aliases?: string[]
  }>
}

export interface ExecuteResult {
  status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
  model?: string
  requestStartedAt?: Date
  requestCompletedAt?: Date
  latencyMs?: number
  rawAnswer?: string
  sourceCitations?: any[]
  groundingSources?: any[]
  analysis?: CitationAnalysis
  errorCode?: string
  errorMessage?: string
}

export interface SampleExecutorDeps {
  prisma: PrismaClient
  registry: {
    get: (platform: string) => PlatformAdapter | undefined
  }
  analyzeCitation: (input: {
    platformResult: any
    brand: string | { name: string; domain?: string; aliases?: string[] }
    brandDomains?: string[]
    competitors: Array<string | { name: string; domain?: string; aliases?: string[] }>
  }) => CitationAnalysis
  getCredentials?: (workspaceId: string, platform: string) => Promise<Record<string, string>>
}

export function createSampleExecutor(deps: SampleExecutorDeps) {
  const { prisma, registry, analyzeCitation, getCredentials } = deps

  async function execute(input: ExecuteInput): Promise<ExecuteResult> {
    const startTime = new Date()

    // Check run status first
    const run = await prisma.diagnosticRun.findFirst({
      where: { id: input.runId },
      select: { status: true },
    })
    if (!run || run.status === 'CANCELLED') {
      return { status: 'CANCELLED', errorCode: 'CANCELLED', errorMessage: 'Run was cancelled' }
    }

    const adapter = registry.get(input.platform)
    if (!adapter) {
      return {
        status: 'FAILED',
        errorCode: 'UNSUPPORTED_PLATFORM',
        errorMessage: `Platform ${input.platform} not registered`,
      }
    }

    // Get credentials
    let credentials: Record<string, string> = {}
    if (getCredentials) {
      try {
        credentials = await getCredentials(input.workspaceId, input.platform)
      } catch (err: any) {
        return {
          status: 'FAILED',
          errorCode: 'CONFIGURATION_ERROR',
          errorMessage: 'Platform credentials not configured',
        }
      }
    }

    try {
      const platformResult = await adapter.query(input.queryText, credentials)
      const endTime = new Date()
      const latencyMs = endTime.getTime() - startTime.getTime()

      const normalizedResult = normalizePlatformResult(platformResult)

      const analysis = analyzeCitation({
        platformResult: normalizedResult,
        brand: {
          name: input.brandSnapshot.brandName,
          domain: input.brandSnapshot.brandDomain,
          aliases: input.brandSnapshot.brandAliases,
        },
        brandDomains: input.brandSnapshot.brandDomain ? [input.brandSnapshot.brandDomain] : [],
        competitors: input.competitorSnapshot.map((c) => ({
          name: c.name,
          domain: c.domain,
          aliases: c.aliases,
        })),
      })

      // Check run status again before saving (late response guard)
      const runCheck = await prisma.diagnosticRun.findFirst({
        where: { id: input.runId },
        select: { status: true },
      })
      if (runCheck && runCheck.status === 'CANCELLED') {
        return { status: 'CANCELLED', errorCode: 'CANCELLED', errorMessage: 'Run was cancelled during execution' }
      }

      // Update sample with conditional status update
      await (prisma.diagnosticSample.update as any)({
        where: { id: input.sampleId },
        data: {
          status: 'SUCCEEDED',
          model: adapter.name,
          requestStartedAt: startTime,
          requestCompletedAt: endTime,
          latencyMs,
          rawAnswer: platformResult.answer,
          sourceCitations: normalizedResult.sourceCitations as any,
          groundingSources: normalizedResult.groundingSources as any,
          analysis: analysis as any,
        },
      })

      return {
        status: 'SUCCEEDED',
        model: adapter.name,
        requestStartedAt: startTime,
        requestCompletedAt: endTime,
        latencyMs,
        rawAnswer: platformResult.answer,
        sourceCitations: normalizedResult.sourceCitations,
        groundingSources: normalizedResult.groundingSources,
        analysis,
      }
    } catch (err: any) {
      const classified = classifySampleError(err)

      // Don't save CANCELLED errors
      if (classified.code === 'CANCELLED') {
        return { status: 'CANCELLED', errorCode: 'CANCELLED', errorMessage: 'CANCELLED' }
      }

      const endTime = new Date()
      const latencyMs = endTime.getTime() - startTime.getTime()

      await prisma.diagnosticSample.update({
        where: { id: input.sampleId },
        data: {
          status: 'FAILED',
          errorCode: classified.code,
          errorMessage: classified.message,
          requestStartedAt: startTime,
          requestCompletedAt: endTime,
          latencyMs,
        },
      })

      return {
        status: 'FAILED',
        errorCode: classified.code,
        errorMessage: classified.message,
      }
    }
  }

  return { execute }
}
