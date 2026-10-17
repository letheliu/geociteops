import type { PrismaClient } from '@prisma/client'

export interface FinalizerDeps {
  prisma: PrismaClient
}

export interface Finalizer {
  finalize(runId: string): Promise<{ status: string } | null>
}

export function createFinalizer(deps: FinalizerDeps): Finalizer {
  const { prisma } = deps

  return {
    async finalize(runId) {
      // Count samples by status
      const grouped = await prisma.diagnosticSample.groupBy({
        by: ['status'],
        where: { runId },
        _count: { id: true },
      })

      const statusMap = new Map(grouped.map((g) => [g.status, g._count.id]))
      const runningCount = statusMap.get('RUNNING') ?? 0
      const pendingCount = statusMap.get('PENDING') ?? 0
      const succeededCount = statusMap.get('SUCCEEDED') ?? 0
      const failedCount = statusMap.get('FAILED') ?? 0

      // Bail if any samples are still in non-terminal states
      if (runningCount > 0 || pendingCount > 0) return null

      const totalUnits = succeededCount + failedCount

      let finalStatus: string
      if (succeededCount === totalUnits) {
        finalStatus = 'COMPLETED'
      } else if (succeededCount > 0) {
        finalStatus = 'PARTIAL'
      } else {
        finalStatus = 'FAILED'
      }

      // Conditionally update: only if still RUNNING
      const updated = await prisma.diagnosticRun.updateMany({
        where: { id: runId, status: 'RUNNING' },
        data: {
          status: finalStatus as any,
          completedUnits: succeededCount,
          failedUnits: failedCount,
          completedAt: new Date(),
        },
      })

      if (updated.count === 0) return null

      return { status: finalStatus }
    },
  }
}
