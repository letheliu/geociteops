import { describe, it, expect, vi, beforeEach } from 'vitest'
import { startCitationScheduler } from './citation-scheduler.js'

describe('citation scheduler', () => {
  let boss: any
  let deps: any

  beforeEach(() => {
    boss = {
      createQueue: vi.fn().mockResolvedValue(undefined),
      schedule: vi.fn().mockResolvedValue(undefined),
      work: vi.fn().mockResolvedValue(undefined),
    }
    deps = {
      boss,
      prisma: {
        workspace: {
          findMany: vi.fn().mockResolvedValue([
            { id: 'w1', status: 'ACTIVE' },
            { id: 'w2', status: 'ACTIVE' },
          ]),
        },
      },
      monitor: {
        runOnce: vi.fn().mockResolvedValue([{ id: 'ev1' }]),
      },
      resolveActivePlatforms: vi.fn(),
    }
  })

  it('注册定时任务并订阅 work handler', async () => {
    await startCitationScheduler(deps)
    expect(boss.createQueue).toHaveBeenCalledWith('citation-monitor-daily')
    expect(boss.schedule).toHaveBeenCalledWith(
      'citation-monitor-daily',
      expect.anything(),
      expect.anything(),
    )
    expect(boss.work).toHaveBeenCalledWith(
      'citation-monitor-daily',
      expect.any(Function),
    )
  })

  it('handler 对每个 ACTIVE workspace 调 resolveActivePlatforms，并以返回平台调 monitor.runOnce', async () => {
    deps.resolveActivePlatforms.mockResolvedValue(['deepseek', 'perplexity'])
    await startCitationScheduler(deps)
    const handler = boss.work.mock.calls[0][1]
    await handler({ data: {} })

    expect(deps.resolveActivePlatforms).toHaveBeenCalledTimes(2)
    expect(deps.resolveActivePlatforms).toHaveBeenCalledWith('w1')
    expect(deps.resolveActivePlatforms).toHaveBeenCalledWith('w2')
    expect(deps.monitor.runOnce).toHaveBeenCalledWith({
      workspaceId: 'w1',
      platforms: ['deepseek', 'perplexity'],
    })
    expect(deps.monitor.runOnce).toHaveBeenCalledWith({
      workspaceId: 'w2',
      platforms: ['deepseek', 'perplexity'],
    })
  })

  it('resolveActivePlatforms 返回空数组的 workspace 被跳过', async () => {
    deps.resolveActivePlatforms.mockImplementation(
      async (wsId: string) => (wsId === 'w1' ? ['deepseek'] : [])
    )
    await startCitationScheduler(deps)
    const handler = boss.work.mock.calls[0][1]
    await handler({ data: {} })

    expect(deps.resolveActivePlatforms).toHaveBeenCalledTimes(2)
    expect(deps.monitor.runOnce).toHaveBeenCalledTimes(1)
    expect(deps.monitor.runOnce).toHaveBeenCalledWith({
      workspaceId: 'w1',
      platforms: ['deepseek'],
    })
  })

  it('单个 workspace 失败不中断其余 workspace', async () => {
    deps.resolveActivePlatforms.mockResolvedValue(['deepseek'])
    deps.monitor.runOnce
      .mockRejectedValueOnce(new Error('w1 boom'))
      .mockResolvedValueOnce([{ id: 'ev1' }])
    await startCitationScheduler(deps)
    const handler = boss.work.mock.calls[0][1]
    await expect(handler({ data: {} })).resolves.toBeUndefined()

    expect(deps.monitor.runOnce).toHaveBeenCalledTimes(2)
  })
})
