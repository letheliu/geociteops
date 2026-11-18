import type { PrismaClient } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { GeoHealthError } from './errors.js'
import { createScheduleRunner } from './schedule.js'

function memory() {
  const schedules = new Map<string, any>()
  const checks = new Map<string, any>()
  const workspaces = new Map<string, { id: string; status: string }>([
    ['ws-1', { id: 'ws-1', status: 'ACTIVE' }],
    ['ws-off', { id: 'ws-off', status: 'SUSPENDED' }],
  ])
  let scheduleSeq = 0
  let checkSeq = 0

  function matchSchedule(row: any, where: any): boolean {
    if (!where) return true
    if (where.id && row.id !== where.id) return false
    if (where.workspaceId && row.workspaceId !== where.workspaceId) return false
    if (where.enabled === true && row.enabled !== true) return false
    if (where.nextRunAt?.lte && !(row.nextRunAt instanceof Date) ) return false
    if (where.nextRunAt?.lte && row.nextRunAt > where.nextRunAt.lte) return false
    if ('runningCheckId' in where && row.runningCheckId !== where.runningCheckId) return false
    if (where.nextRunAt instanceof Date && row.nextRunAt?.getTime() !== where.nextRunAt.getTime()) return false
    return true
  }

  const scheduleDb = {
    findMany: vi.fn(async ({ where }: any) => [...schedules.values()].filter((row) => matchSchedule(row, where))),
    findFirst: vi.fn(async ({ where }: any) => [...schedules.values()].find((row) => matchSchedule(row, where)) ?? null),
    findUnique: vi.fn(async ({ where }: any) => schedules.get(where.id) ?? null),
    update: vi.fn(async ({ where, data }: any) => {
      const row = schedules.get(where.id)
      Object.assign(row, data)
      return row
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const row = schedules.get(where.id)
      if (!row || !matchSchedule(row, where)) return { count: 0 }
      Object.assign(row, data)
      return { count: 1 }
    }),
    delete: vi.fn(async ({ where }: any) => {
      schedules.delete(where.id)
    }),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const key = where.workspaceId_brandKey_siteUrl
      const existing = [...schedules.values()].find((row) => row.workspaceId === key.workspaceId && row.brandKey === key.brandKey && row.siteUrl === key.siteUrl)
      if (existing) {
        Object.assign(existing, update)
        return existing
      }
      const row = { id: `sched-${++scheduleSeq}`, runningCheckId: null, lastCheckId: null, lastRunAt: null, lastStatus: null, createdAt: new Date(), updatedAt: new Date(), ...create }
      schedules.set(row.id, row)
      return row
    }),
  }
  const checkDb = {
    create: vi.fn(async ({ data }: any) => {
      const row = { id: `check-${++checkSeq}`, createdAt: new Date(), ...data }
      checks.set(row.id, row)
      return row
    }),
    findUnique: vi.fn(async ({ where }: any) => checks.get(where.id) ?? null),
    update: vi.fn(async ({ where, data }: any) => {
      Object.assign(checks.get(where.id), data)
      return checks.get(where.id)
    }),
    delete: vi.fn(async ({ where }: any) => {
      checks.delete(where.id)
    }),
  }
  const prisma = {
    geoHealthSchedule: scheduleDb,
    geoHealthCheck: checkDb,
    workspace: { findUnique: vi.fn(async ({ where }: any) => workspaces.get(where.id) ?? null) },
    $transaction: async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
  }
  return { prisma: prisma as unknown as PrismaClient, schedules, checks }
}

const FORM = {
  brandName: 'Acme Draw',
  siteUrl: 'https://acmedraw.example',
  industry: '插画生成',
  competitors: ['Northwind Ink'],
  queries: ['Acme Draw 是什么'],
  language: 'zh' as const,
  cadence: 'WEEKLY' as const,
}

describe('health check schedules', () => {
  it('stores one schedule per brand and site, and rejects a cron that is too frequent', async () => {
    const { prisma } = memory()
    const now = new Date('2026-11-17T10:00:00+08:00')
    const runner = createScheduleRunner({ prisma, now: () => now, enqueue: vi.fn(async () => 'job') })
    const saved = await runner.save('ws-1', FORM)
    expect(saved.cron).toBe('0 4 * * 1')
    expect(saved.timezone).toBe('Asia/Shanghai')
    expect(saved.nextRunAt).toBe(new Date('2026-11-23T04:00:00+08:00').toISOString())
    const again = await runner.save('ws-1', { ...FORM, cadence: 'DAILY' })
    expect(again.id).toBe(saved.id)
    expect(again.cron).toBe('0 4 * * *')
    await expect(runner.save('ws-1', { ...FORM, cadence: 'CRON', cron: '* * * * *' })).rejects.toBeInstanceOf(GeoHealthError)
    expect(await runner.list('ws-1')).toHaveLength(1)
    await runner.remove('ws-1', saved.id)
    expect(await runner.list('ws-1')).toHaveLength(0)
  })

  it('starts one check for the schedule workspace and does not start a second while it is running', async () => {
    const { prisma, schedules, checks } = memory()
    const enqueued: string[] = []
    let clock = new Date('2026-11-23T05:00:00+08:00')
    const runner = createScheduleRunner({
      prisma,
      now: () => clock,
      enqueue: async (checkId) => {
        enqueued.push(checkId)
        return 'job'
      },
    })
    const saved = await runner.save('ws-1', FORM)
    const quiet = await runner.runDue()
    expect(quiet.started).toEqual([])

    clock = new Date('2026-11-23T04:00:00+08:00')
    schedules.get(saved.id).nextRunAt = new Date('2026-11-23T03:00:00+08:00')
    const first = await runner.runDue()
    expect(first.started).toHaveLength(1)
    const check = checks.get(first.started[0]!)
    check.createdAt = new Date(clock)
    expect(check.workspaceId).toBe('ws-1')
    expect(check.trigger).toBe('SCHEDULED')
    expect(check.scheduleId).toBe(saved.id)
    expect(enqueued).toEqual([check.id])
    expect(schedules.get(saved.id).runningCheckId).toBe(check.id)

    schedules.get(saved.id).nextRunAt = new Date('2026-11-23T03:30:00+08:00')
    const second = await runner.runDue()
    expect(second.started).toEqual([])
    expect(second.skippedBusy).toBe(1)
    expect(checks.size).toBe(1)
    expect(schedules.get(saved.id).nextRunAt.getTime()).toBeGreaterThan(clock.getTime())
  })

  it('skips a suspended workspace and does not leave a running check when the queue refuses the job', async () => {
    const { prisma, schedules, checks } = memory()
    const clock = new Date('2026-11-23T05:00:00+08:00')
    const runner = createScheduleRunner({
      prisma,
      now: () => clock,
      enqueue: async () => null,
    })
    const off = await runner.save('ws-off', { ...FORM, brandName: 'Other', siteUrl: 'https://other.example' })
    schedules.get(off.id).nextRunAt = new Date('2026-11-23T03:00:00+08:00')
    const skipped = await runner.runDue()
    expect(skipped.skippedInactive).toBe(1)
    expect(checks.size).toBe(0)

    const saved = await runner.save('ws-1', FORM)
    schedules.get(saved.id).nextRunAt = new Date('2026-11-23T03:00:00+08:00')
    const refused = await runner.runDue()
    expect(refused.started).toEqual([])
    const check = [...checks.values()][0]
    expect(check.status).toBe('FAILED')
    expect(schedules.get(saved.id).runningCheckId).toBeNull()
    expect(schedules.get(saved.id).lastStatus).toBe('FAILED')
  })
})
