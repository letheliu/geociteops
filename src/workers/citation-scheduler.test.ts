import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  startCitationScheduler,
  CITATION_QUEUES,
  DAILY_CRON,
  WEEKLY_CRON,
  MONITOR_TZ,
} from './citation-scheduler.js'
import { SlotConflictError } from '../modules/citation-monitor/monitor.js'

describe('citation scheduler', () => {
  let boss: any
  let deps: any

  /** 按队列名取出注册的 work handler */
  function handlerOf(queue: string) {
    const call = boss.work.mock.calls.find((c: any[]) => c[0] === queue)
    return call?.[1]
  }

  beforeEach(() => {
    boss = {
      createQueue: vi.fn().mockResolvedValue(undefined),
      schedule: vi.fn().mockResolvedValue(undefined),
      work: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    }
    deps = {
      boss,
      prisma: {
        workspace: {
          // 模拟真实 SQL：按 status + monitorSchedule 过滤（OFF 不会被扇出）
          findMany: vi.fn(async ({ where }: any) =>
            [
              { id: 'w1', status: 'ACTIVE', monitorSchedule: 'DAILY' },
              { id: 'w2', status: 'ACTIVE', monitorSchedule: 'DAILY' },
              { id: 'w3', status: 'ACTIVE', monitorSchedule: 'WEEKLY' },
              { id: 'w7', status: 'SUSPENDED', monitorSchedule: 'DAILY' },
              { id: 'w8', status: 'ACTIVE', monitorSchedule: 'OFF' },
            ].filter((w) => w.status === where.status && w.monitorSchedule === where.monitorSchedule),
          ),
        },
      },
      monitor: {
        startScheduledRun: vi.fn().mockResolvedValue({ runId: 'run-1', skipped: false, resumed: false, status: 'COMPLETED' }),
        resumeRun: vi.fn().mockResolvedValue(null),
        runOnce: vi.fn(),
      },
      resolveActivePlatforms: vi.fn().mockResolvedValue(['deepseek']),
      // 固定时钟：2026-10-18 18:00 UTC = 上海 10-19 02:00
      now: () => new Date('2026-10-18T18:00:00.000Z'),
    }
  })

  it('注册三个队列：daily cron / weekly cron / run', async () => {
    await startCitationScheduler(deps)
    expect(boss.createQueue).toHaveBeenCalledWith(CITATION_QUEUES.cronDaily)
    expect(boss.createQueue).toHaveBeenCalledWith(CITATION_QUEUES.cronWeekly)
    expect(boss.createQueue).toHaveBeenCalledWith(CITATION_QUEUES.run)
  })

  it('daily 02:00 与 weekly 周日 03:00，且都带 tz=Asia/Shanghai', async () => {
    await startCitationScheduler(deps)
    expect(DAILY_CRON).toBe('0 2 * * *')
    expect(WEEKLY_CRON).toBe('0 3 * * 0')
    expect(MONITOR_TZ).toBe('Asia/Shanghai')

    const daily = boss.schedule.mock.calls.find((c: any[]) => c[0] === CITATION_QUEUES.cronDaily)
    const weekly = boss.schedule.mock.calls.find((c: any[]) => c[0] === CITATION_QUEUES.cronWeekly)
    expect(daily[1]).toBe(DAILY_CRON)
    expect(weekly[1]).toBe(WEEKLY_CRON)
    expect(daily[3]).toEqual({ tz: MONITOR_TZ })
    expect(weekly[3]).toEqual({ tz: MONITOR_TZ })
  })

  it('daily cron 只扇出 monitorSchedule=DAILY 的工作区（OFF 不投递）', async () => {
    await startCitationScheduler(deps)
    await handlerOf(CITATION_QUEUES.cronDaily)({ data: {} })

    expect(deps.prisma.workspace.findMany).toHaveBeenCalledWith({
      where: { status: 'ACTIVE', monitorSchedule: 'DAILY' },
    })
    expect(deps.boss.send).toHaveBeenCalledTimes(2)
  })

  it('weekly cron 只扇出 monitorSchedule=WEEKLY 的工作区', async () => {
    await startCitationScheduler(deps)
    await handlerOf(CITATION_QUEUES.cronWeekly)({ data: {} })

    expect(deps.prisma.workspace.findMany).toHaveBeenCalledWith({
      where: { status: 'ACTIVE', monitorSchedule: 'WEEKLY' },
    })
    expect(deps.boss.send).toHaveBeenCalledTimes(1)
  })

  it('投递 per-workspace job，data 含 workspaceId 与上海日界 slotKey', async () => {
    await startCitationScheduler(deps)
    await handlerOf(CITATION_QUEUES.cronDaily)({ data: {} })

    expect(deps.boss.send).toHaveBeenCalledWith(CITATION_QUEUES.run, {
      workspaceId: 'w1',
      slotKey: 'w1:2026-10-19',
    })
    expect(deps.boss.send).toHaveBeenCalledWith(CITATION_QUEUES.run, {
      workspaceId: 'w2',
      slotKey: 'w2:2026-10-19',
    })
    // cron job 本身不抓取
    expect(deps.monitor.startScheduledRun).not.toHaveBeenCalled()
    expect(deps.monitor.runOnce).not.toHaveBeenCalled()
  })

  it('0 平台的工作区被跳过，不投递、不建 Run', async () => {
    deps.resolveActivePlatforms.mockImplementation(async (id: string) => (id === 'w1' ? [] : ['deepseek']))
    await startCitationScheduler(deps)
    await handlerOf(CITATION_QUEUES.cronDaily)({ data: {} })

    expect(deps.boss.send).toHaveBeenCalledTimes(1)
    expect(deps.boss.send).toHaveBeenCalledWith(CITATION_QUEUES.run, expect.objectContaining({ workspaceId: 'w2' }))
  })

  it('单个工作区扇出失败不影响其余工作区', async () => {
    deps.resolveActivePlatforms.mockImplementation(async (id: string) => {
      if (id === 'w1') throw new Error('boom')
      return ['deepseek']
    })
    await startCitationScheduler(deps)
    await expect(handlerOf(CITATION_QUEUES.cronDaily)({ data: {} })).resolves.toBeUndefined()
    expect(deps.boss.send).toHaveBeenCalledTimes(1)
  })

  it('run job 调 startScheduledRun 并透传平台与 slotKey', async () => {
    deps.resolveActivePlatforms.mockResolvedValue(['deepseek', 'perplexity'])
    await startCitationScheduler(deps)
    await handlerOf(CITATION_QUEUES.run)({ data: { workspaceId: 'w1', slotKey: 'w1:2026-10-19' } })

    expect(deps.monitor.startScheduledRun).toHaveBeenCalledWith({
      workspaceId: 'w1',
      platforms: ['deepseek', 'perplexity'],
      slotKey: 'w1:2026-10-19',
    })
  })

  it('run job 带 runId 时走 resumeRun（续跑不新建）', async () => {
    await startCitationScheduler(deps)
    await handlerOf(CITATION_QUEUES.run)({
      data: { workspaceId: 'w1', slotKey: 'w1:2026-10-19', runId: 'run-old' },
    })

    expect(deps.monitor.resumeRun).toHaveBeenCalledWith('run-old')
    expect(deps.monitor.startScheduledRun).not.toHaveBeenCalled()
  })

  it('run job 平台为空时直接返回，不建 Run', async () => {
    deps.resolveActivePlatforms.mockResolvedValue([])
    await startCitationScheduler(deps)
    await handlerOf(CITATION_QUEUES.run)({ data: { workspaceId: 'w1', slotKey: 'w1:2026-10-19' } })

    expect(deps.monitor.startScheduledRun).not.toHaveBeenCalled()
  })

  it('SlotConflict 被吞掉：同 slot 重复投递不报错、不重复建 Run', async () => {
    // monitor 内部负责幂等；这里确认即便冲突冒泡到调度层也不会变成故障
    deps.monitor.startScheduledRun.mockRejectedValue(new SlotConflictError('w1:2026-10-19', 'run-1'))
    await startCitationScheduler(deps)

    await expect(
      handlerOf(CITATION_QUEUES.run)({ data: { workspaceId: 'w1', slotKey: 'w1:2026-10-19' } }),
    ).resolves.toBeUndefined()
    expect(deps.monitor.startScheduledRun).toHaveBeenCalledTimes(1)
  })

  it('run job 的真实异常被捕获，不让 pg-boss 无限重试', async () => {
    deps.monitor.startScheduledRun.mockRejectedValue(new Error('db down'))
    await startCitationScheduler(deps)

    await expect(
      handlerOf(CITATION_QUEUES.run)({ data: { workspaceId: 'w1', slotKey: 'w1:2026-10-19' } }),
    ).resolves.toBeUndefined()
  })

  it('job 缺 workspaceId 时安全返回', async () => {
    await startCitationScheduler(deps)
    await handlerOf(CITATION_QUEUES.run)({ data: {} })
    expect(deps.monitor.startScheduledRun).not.toHaveBeenCalled()
  })

  it('兼容 pg-boss 以数组形式投递 job', async () => {
    await startCitationScheduler(deps)
    await handlerOf(CITATION_QUEUES.run)([{ data: { workspaceId: 'w1', slotKey: 'w1:2026-10-19' } }])
    expect(deps.monitor.startScheduledRun).toHaveBeenCalledTimes(1)
  })

  it('同 slot 重复投递时 startScheduledRun 被调用两次（幂等由 monitor 的 slotKey 保证只建一个 Run）', async () => {
    await startCitationScheduler(deps)
    const job = { data: { workspaceId: 'w1', slotKey: 'w1:2026-10-19' } }
    await handlerOf(CITATION_QUEUES.run)(job)
    await handlerOf(CITATION_QUEUES.run)(job)

    expect(deps.monitor.startScheduledRun).toHaveBeenCalledTimes(2)
    // 两次携带完全相同的 slotKey —— 这正是「单 slot 单 Run」的依据
    expect(deps.monitor.startScheduledRun.mock.calls[0][0].slotKey).toBe(
      deps.monitor.startScheduledRun.mock.calls[1][0].slotKey,
    )
  })
})
