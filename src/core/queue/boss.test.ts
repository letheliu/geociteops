import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockStart = vi.fn().mockResolvedValue(undefined)
const mockSchedule = vi.fn().mockResolvedValue(undefined)

vi.mock('pg-boss', () => {
  return {
    default: class MockPgBoss {
      start = mockStart
      schedule = mockSchedule
    },
  }
})

describe('pg-boss queue', () => {
  beforeEach(() => {
    mockStart.mockClear()
    mockSchedule.mockClear()
  })

  it('创建实例并启动', async () => {
    const { createQueue } = await import('./boss.js')
    const boss = await createQueue()
    expect(mockStart).toHaveBeenCalled()
    expect(boss).toBeDefined()
  })

  it('注册定时任务', async () => {
    const { createQueue } = await import('./boss.js')
    const boss = await createQueue()
    await boss.schedule('citation-monitor-daily', '0 2 * * *', { workspaceId: 'w1' })
    expect(mockSchedule).toHaveBeenCalledWith('citation-monitor-daily', '0 2 * * *', { workspaceId: 'w1' })
  })
})
