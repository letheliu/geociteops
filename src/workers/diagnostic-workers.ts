import type PgBoss from 'pg-boss'
import type { PrismaClient } from '@prisma/client'
import { DIAGNOSTIC_QUEUES, createDispatcher } from './diagnostic-dispatcher.js'
import { createSampleWorker } from './diagnostic-sample-worker.js'
import { createFinalizer } from './diagnostic-finalizer.js'
import type { SampleExecutorDeps } from '../modules/diagnostic/executor.js'

export interface DiagnosticWorkersDeps {
  boss: PgBoss
  prisma: PrismaClient
  registry: SampleExecutorDeps['registry']
  analyzeCitation: SampleExecutorDeps['analyzeCitation']
  getCredentials?: SampleExecutorDeps['getCredentials']
}

export async function startDiagnosticWorkers(deps: DiagnosticWorkersDeps): Promise<void> {
  const { boss, prisma, registry, analyzeCitation, getCredentials } = deps

  // Create queues
  await boss.createQueue(DIAGNOSTIC_QUEUES.dispatch)
  await boss.createQueue(DIAGNOSTIC_QUEUES.sample)
  await boss.createQueue(DIAGNOSTIC_QUEUES.finalize)

  // Register dispatch worker: reads PENDING samples and sends sample jobs
  await boss.work(DIAGNOSTIC_QUEUES.dispatch, async ([job]) => {
    if (!job?.data) return
    const { runId } = job.data as { runId: string }
    const dispatcher = createDispatcher({ boss, prisma })
    await dispatcher.dispatch(runId)
  })

  // Register sample worker: executes individual samples
  const sampleWorker = createSampleWorker({ prisma, registry, analyzeCitation, getCredentials, boss })
  await boss.work(DIAGNOSTIC_QUEUES.sample, async ([job]) => {
    if (!job?.data) return
    const data = job.data as { sampleId: string; runId: string }
    await sampleWorker.process(data)
  })

  // Register finalizer: aggregates sample statuses
  const finalizer = createFinalizer({ prisma })
  await boss.work(DIAGNOSTIC_QUEUES.finalize, async ([job]) => {
    if (!job?.data) return
    const { runId } = job.data as { runId: string }
    await finalizer.finalize(runId)
  })
}
