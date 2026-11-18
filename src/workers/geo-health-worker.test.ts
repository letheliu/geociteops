import { describe, expect, it, vi } from 'vitest'
import { GEO_HEALTH_QUEUES } from '../modules/geo-health/service.js'
import { startGeoHealthWorker } from './geo-health-worker.js'

describe('geo health worker', () => {
  it('creates the queues, including the schedule tick, and accepts object or array payloads', async () => {
    const handlers = new Map<string, (arg: unknown) => Promise<void>>()
    const dispatch = vi.fn(async () => {})
    const runPillar = vi.fn(async () => {})
    const finalize = vi.fn(async () => {})
    const runDue = vi.fn(async () => {})
    const boss = {
      createQueue: vi.fn(async () => {}),
      schedule: vi.fn(async () => {}),
      work: vi.fn(async (name: string, fn: (arg: unknown) => Promise<void>) => {
        handlers.set(name, fn)
      }),
    }
    await startGeoHealthWorker({ boss: boss as any, dispatch, runPillar, finalize, runDue })

    expect(boss.createQueue).toHaveBeenCalledWith(GEO_HEALTH_QUEUES.dispatch)
    expect(boss.createQueue).toHaveBeenCalledWith(GEO_HEALTH_QUEUES.pillar)
    expect(boss.createQueue).toHaveBeenCalledWith(GEO_HEALTH_QUEUES.finalize)
    expect(boss.createQueue).toHaveBeenCalledWith(GEO_HEALTH_QUEUES.schedule)
    expect(boss.schedule).toHaveBeenCalledWith(GEO_HEALTH_QUEUES.schedule, '* * * * *', {}, expect.objectContaining({ tz: 'Asia/Shanghai' }))

    await handlers.get(GEO_HEALTH_QUEUES.dispatch)?.([{ data: { checkId: 'c1' } }])
    await handlers.get(GEO_HEALTH_QUEUES.pillar)?.({ data: { checkId: 'c1', pillar: 'citations' } })
    await handlers.get(GEO_HEALTH_QUEUES.finalize)?.([{ data: {} }])
    await handlers.get(GEO_HEALTH_QUEUES.finalize)?.({ data: { checkId: 'c1' } })

    expect(dispatch).toHaveBeenCalledWith('c1')
    expect(runPillar).toHaveBeenCalledWith('c1', 'citations')
    expect(finalize).toHaveBeenCalledTimes(1)
    expect(finalize).toHaveBeenCalledWith('c1')
    await handlers.get(GEO_HEALTH_QUEUES.schedule)?.(undefined)
    expect(runDue).toHaveBeenCalledTimes(1)
  })
})
