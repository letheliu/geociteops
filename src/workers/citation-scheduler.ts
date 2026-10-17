import type PgBoss from 'pg-boss'
import type { PrismaClient } from '@prisma/client'
import type { Monitor } from '../modules/citation-monitor/monitor.js'

export interface SchedulerDeps {
  boss: PgBoss
  prisma: PrismaClient
  monitor: Monitor
  cron?: string
  /** 解析 workspace 的有效监测平台（已注册且凭证配齐），空数组则跳过 */
  resolveActivePlatforms: (workspaceId: string) => Promise<string[]>
}

const DEFAULT_CRON = '0 2 * * *' // 每日 02:00

export async function startCitationScheduler(deps: SchedulerDeps): Promise<void> {
  const jobName = 'citation-monitor-daily'
  const cron = deps.cron || DEFAULT_CRON

  // pg-boss v10 要求 queue 必须先存在才能 schedule / work
  await deps.boss.createQueue(jobName)

  await deps.boss.schedule(jobName, cron, {})

  await deps.boss.work(jobName, async () => {
    const workspaces = await deps.prisma.workspace.findMany({
      where: { status: 'ACTIVE' },
    })
    for (const ws of workspaces) {
      try {
        const activePlatforms = await deps.resolveActivePlatforms(ws.id)
        if (!activePlatforms || activePlatforms.length === 0) continue
        await deps.monitor.runOnce({
          workspaceId: ws.id,
          platforms: activePlatforms,
        })
      } catch (err) {
        console.error(`[scheduler] workspace=${ws.id} failed:`, err)
      }
    }
  })
}
