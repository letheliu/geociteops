import type PgBoss from 'pg-boss'
import { GEO_HEALTH_QUEUES, type GeoHealthPillarJob } from '../modules/geo-health/service.js'
import type { PillarId } from '../modules/geo-health/types.js'

export interface GeoHealthWorkerDeps {
  boss: PgBoss
  dispatch(checkId: string): Promise<void>
  runPillar(checkId: string, pillar: PillarId): Promise<void>
  finalize(checkId: string): Promise<void>
}

function readData(arg: unknown): { checkId?: string; pillar?: PillarId } | undefined {
  const job = (Array.isArray(arg) ? arg[0] : arg) as { data?: GeoHealthPillarJob } | undefined
  return job?.data
}

/** Three queues: fan-out, one pillar at a time, then a single finalize. A failed pillar does not fail the others. */
export async function startGeoHealthWorker(deps: GeoHealthWorkerDeps): Promise<void> {
  await deps.boss.createQueue(GEO_HEALTH_QUEUES.dispatch)
  await deps.boss.createQueue(GEO_HEALTH_QUEUES.pillar)
  await deps.boss.createQueue(GEO_HEALTH_QUEUES.finalize)

  await deps.boss.work(GEO_HEALTH_QUEUES.dispatch, async (arg) => {
    const data = readData(arg)
    if (!data?.checkId) return
    await deps.dispatch(data.checkId)
  })

  await deps.boss.work(GEO_HEALTH_QUEUES.pillar, async (arg) => {
    const data = readData(arg)
    if (!data?.checkId || !data.pillar) return
    await deps.runPillar(data.checkId, data.pillar)
  })

  await deps.boss.work(GEO_HEALTH_QUEUES.finalize, async (arg) => {
    const data = readData(arg)
    if (!data?.checkId) return
    await deps.finalize(data.checkId)
  })
}
