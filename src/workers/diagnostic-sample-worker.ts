import type PgBoss from 'pg-boss'
import type { PrismaClient } from '@prisma/client'
import type { SampleExecutorDeps } from '../modules/diagnostic/executor.js'
import { createSampleExecutor } from '../modules/diagnostic/executor.js'
import { DIAGNOSTIC_QUEUES } from './diagnostic-dispatcher.js'

export interface SampleWorkerJob {
  sampleId: string
  runId: string
}

export interface SampleWorkerDeps {
  prisma: PrismaClient
  registry: SampleExecutorDeps['registry']
  analyzeCitation: SampleExecutorDeps['analyzeCitation']
  getCredentials?: SampleExecutorDeps['getCredentials']
  boss: PgBoss
}

export interface SampleWorker {
  process(job: SampleWorkerJob): Promise<{ status: string; retryable?: boolean }>
}

export function createSampleWorker(deps: SampleWorkerDeps): SampleWorker {
  const { prisma, boss } = deps
  const executor = createSampleExecutor(deps)

  return {
    async process(job) {
      const sample = await prisma.diagnosticSample.findFirst({
        where: { id: job.sampleId },
      })
      if (!sample) return { status: 'CANCELLED' }

      // Skip if already not PENDING
      if (sample.status !== 'PENDING') {
        return { status: sample.status }
      }

      const run = await prisma.diagnosticRun.findFirst({
        where: { id: job.runId },
      })
      if (!run || run.status === 'CANCELLED') {
        return { status: 'CANCELLED' }
      }

      const runQuery = await prisma.diagnosticRunQuery.findFirst({
        where: { id: sample.runQueryId },
      })
      if (!runQuery) return { status: 'CANCELLED' }

      const brandSnapshot = run.brandSnapshot as any ?? { brandName: '', brandAliases: [] }
      const competitorSnapshot = (run.competitorSnapshot as any[]) ?? []

      const result = await executor.execute({
        sampleId: job.sampleId,
        runId: job.runId,
        workspaceId: run.workspaceId,
        platform: sample.platform,
        queryText: runQuery.queryText,
        brandSnapshot: {
          brandName: brandSnapshot.brandName ?? '',
          brandAliases: brandSnapshot.brandAliases ?? [],
          brandDomain: brandSnapshot.brandDomain,
        },
        competitorSnapshot: competitorSnapshot.map((c: any) => ({
          name: c.name,
          domain: c.domain,
          aliases: c.aliases,
        })),
      })

      const retryableErrors = ['RATE_LIMITED', 'PLATFORM_ERROR', 'NETWORK_ERROR', 'PARSE_ERROR']
      const maxRetries = 3

      if (result.status === 'FAILED' && result.errorCode && retryableErrors.includes(result.errorCode)) {
        const newAttemptCount = (sample.attemptCount ?? 0) + 1
        if (newAttemptCount < maxRetries) {
          const retryDelays = [10, 30, 90]
          const delay = retryDelays[newAttemptCount - 1] ?? 90

          await boss.send(DIAGNOSTIC_QUEUES.sample, job, {
            retryDelay: delay,
            retryLimit: maxRetries - newAttemptCount,
          })

          return { status: 'FAILED', retryable: true }
        }
      }

      const isRetryable = result.status === 'FAILED' && result.errorCode
        ? retryableErrors.includes(result.errorCode)
        : false

      // Attempt to finalize after sample completes
      // Only for non-retryable results to avoid premature finalization
      if (!isRetryable) {
        try {
          await boss.send(DIAGNOSTIC_QUEUES.finalize, { runId: job.runId })
        } catch {
          // Finalization is best-effort; Dispatcher will re-submit later
        }
      }

      return { status: result.status, retryable: isRetryable }
    },
  }
}
