import type PgBoss from 'pg-boss'
import type { PrismaClient } from '@prisma/client'
import type { Monitor } from '../modules/citation-monitor/monitor.js'
import { SlotConflictError } from '../modules/citation-monitor/monitor.js'
import { dayKey } from '../modules/citation-monitor/aggregate.js'

/**
 * 监测调度（规格 §6）：工作区级节奏 + per-workspace 扇出。
 *
 * 分两层队列：
 * - cron job：只负责「算出该谁跑」并投递 per-workspace run job，本身不抓取
 * - run job：调 monitor.startScheduledRun / resumeRun，队列并发可独立配置
 *
 * 幂等靠 slotKey（`${workspaceId}:${YYYY-MM-DD Asia/Shanghai}`）：同 slot 重复投递
 * 只会建一个 Run——已有 Run 跳过，FAILED 的原地续跑。
 */

export const CITATION_QUEUES = {
  cronDaily: 'citation-monitor-daily',
  cronWeekly: 'citation-monitor-weekly',
  run: 'citation-monitor-run',
} as const

/** 每日 02:00 */
export const DAILY_CRON = '0 2 * * *'
/** 每周日 03:00 */
export const WEEKLY_CRON = '0 3 * * 0'
/** 调度与日界统一按上海时区解释（规格 §6） */
export const MONITOR_TZ = 'Asia/Shanghai'

export interface CitationRunJobData {
  workspaceId: string
  /** `${workspaceId}:${日界日期}` */
  slotKey: string
  /** 续跑场景携带：直接对这个 Run 补缺，不新建 */
  runId?: string
}

export interface SchedulerDeps {
  boss: PgBoss
  prisma: PrismaClient
  monitor: Monitor
  /** 解析 workspace 的有效监测平台（已注册且凭证配齐），空数组则跳过 */
  resolveActivePlatforms: (workspaceId: string) => Promise<string[]>
  dailyCron?: string
  weeklyCron?: string
  /** 可注入时钟（slotKey 日界） */
  now?: () => Date
}

/** pg-boss 不同版本把 job 以对象或数组交给 handler，这里都兼容 */
function readJob(arg: any): { data?: CitationRunJobData } {
  return (Array.isArray(arg) ? arg[0] : arg) ?? {}
}

export async function startCitationScheduler(deps: SchedulerDeps): Promise<void> {
  const now = deps.now ?? (() => new Date())
  const dailyCron = deps.dailyCron || DAILY_CRON
  const weeklyCron = deps.weeklyCron || WEEKLY_CRON

  // pg-boss v10 要求 queue 必须先存在才能 schedule / work
  await deps.boss.createQueue(CITATION_QUEUES.cronDaily)
  await deps.boss.createQueue(CITATION_QUEUES.cronWeekly)
  await deps.boss.createQueue(CITATION_QUEUES.run)

  // 两条 cron 都显式带 tz——否则会用服务器本地时区解释 02:00
  await deps.boss.schedule(CITATION_QUEUES.cronDaily, dailyCron, {}, { tz: MONITOR_TZ } as any)
  await deps.boss.schedule(CITATION_QUEUES.cronWeekly, weeklyCron, {}, { tz: MONITOR_TZ } as any)

  /** 扇出：只投递 per-workspace run job，不在 cron job 里抓取 */
  async function fanOut(rhythm: 'DAILY' | 'WEEKLY') {
    const workspaces = await deps.prisma.workspace.findMany({
      where: { status: 'ACTIVE', monitorSchedule: rhythm },
    })
    // slotKey 用上海日界，与聚合层的日桶口径一致
    const slotDay = dayKey(now())

    for (const ws of workspaces) {
      try {
        const platforms = await deps.resolveActivePlatforms(ws.id)
        // 0 平台直接跳过，不建 Run
        if (!platforms || platforms.length === 0) continue
        await deps.boss.send(CITATION_QUEUES.run, {
          workspaceId: ws.id,
          slotKey: `${ws.id}:${slotDay}`,
        } satisfies CitationRunJobData)
      } catch (err) {
        console.error(`[scheduler] workspace=${ws.id} dispatch failed:`, err)
      }
    }
  }

  await deps.boss.work(CITATION_QUEUES.cronDaily, async () => {
    // 每日首件事：回收孤儿 RUNNING（进程崩溃未收尾的 Run，规格 §6"防 RUNNING 挂死"）
    try {
      const reaped = await deps.monitor.failStaleRunningRuns()
      if (reaped > 0) console.warn(`[scheduler] 回收孤儿 RUNNING Run ${reaped} 个（疑为进程崩溃遗留）`)
    } catch (err) {
      console.error('[scheduler] 孤儿回收失败（不影响后续扇出）:', err)
    }
    await fanOut('DAILY')
  })
  await deps.boss.work(CITATION_QUEUES.cronWeekly, async () => {
    await fanOut('WEEKLY')
  })

  // run job：真正的执行入口
  await deps.boss.work(CITATION_QUEUES.run, async (arg) => {
    const { data } = readJob(arg)
    if (!data?.workspaceId) return
    try {
      const platforms = await deps.resolveActivePlatforms(data.workspaceId)
      if (!platforms || platforms.length === 0) return

      // 显式带 runId → 续跑（FAILED 补缺）；否则新建（slot 冲突由 monitor 内部消化）
      if (data.runId) {
        await deps.monitor.resumeRun(data.runId)
        return
      }
      await deps.monitor.startScheduledRun({
        workspaceId: data.workspaceId,
        platforms,
        slotKey: data.slotKey,
      })
    } catch (err) {
      // 同 slot 已被别的 worker 建过：幂等跳过，不当作故障重试
      if (err instanceof SlotConflictError) return
      console.error(`[scheduler] run failed workspace=${data.workspaceId}:`, err)
    }
  })
}
