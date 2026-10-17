import type PgBoss from 'pg-boss'
import type { PrismaClient } from '@prisma/client'

export const DIAGNOSTIC_QUEUES = {
  dispatch: 'diagnostic-run-dispatch',
  sample: 'diagnostic-sample-execute',
  finalize: 'diagnostic-run-finalize',
} as const

export interface DispatcherDeps {
  boss: PgBoss
  prisma: PrismaClient
}

export interface Dispatcher {
  dispatch(runId: string): Promise<void>
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const { boss, prisma } = deps

  return {
    async dispatch(runId) {
      const pendingSamples = await prisma.diagnosticSample.findMany({
        where: { runId, status: 'PENDING' },
        select: { id: true },
      })

      for (const sample of pendingSamples) {
        await boss.send(DIAGNOSTIC_QUEUES.sample, {
          sampleId: sample.id,
          runId,
        })
      }
    },
  }
}
