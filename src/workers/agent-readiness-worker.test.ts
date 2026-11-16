import { describe, expect, it, vi } from 'vitest'
import { startAgentReadinessWorker } from './agent-readiness-worker.js'

describe('agent readiness worker', () => {
  it('creates the queue and runs object or array job payloads', async () => {
    let handler: (arg: unknown) => Promise<void> = async () => {}
    const boss = {
      createQueue: vi.fn(async () => {}),
      work: vi.fn(async (_name: string, fn: (arg: unknown) => Promise<void>) => {
        handler = fn
      }),
    }
    const execute = vi.fn(async () => {})
    await startAgentReadinessWorker({ boss: boss as any, execute })

    expect(boss.createQueue).toHaveBeenCalledWith('agent-readiness-audit')
    await handler([{ data: { auditId: 'a1' } }])
    await handler({ data: { auditId: 'a2' } })
    await handler([{ data: {} }])
    expect(execute.mock.calls.map((call) => call[0])).toEqual(['a1', 'a2'])
  })
})
