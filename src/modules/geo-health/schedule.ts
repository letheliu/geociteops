import type { Prisma, PrismaClient } from '@prisma/client'
import { emptyProgress } from './score.js'
import { nextRunAfter, resolveScheduleCron, SCHEDULE_TZ, type ScheduleCadence } from './cron.js'
import { GeoHealthError } from './errors.js'
import { prepareHealthFields } from './run-input.js'
import type { GeoHealthScheduleSummary, GeoHealthStartInput, GeoHealthStatus, HealthLanguage } from './types.js'

const RETRY_DELAY_MS = 15 * 60 * 1000
const ACTIVE = new Set(['QUEUED', 'RUNNING'])

export interface ScheduleSaveInput extends GeoHealthStartInput {
  id?: string
  cadence: ScheduleCadence
  cron?: string
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function asLanguage(value: string): HealthLanguage {
  if (value === 'zh' || value === 'en' || value === 'auto') return value
  return 'auto'
}

function asCadence(value: string): ScheduleCadence {
  if (value === 'DAILY' || value === 'WEEKLY' || value === 'MONTHLY' || value === 'CRON') return value
  return 'WEEKLY'
}

function asStatus(value: string | null): GeoHealthStatus | null {
  if (value === 'QUEUED' || value === 'RUNNING' || value === 'SUCCEEDED' || value === 'PARTIAL' || value === 'FAILED') {
    return value
  }
  return null
}

type ScheduleRow = {
  id: string
  workspaceId: string
  brandName: string
  brandKey: string
  siteUrl: string
  industry: string | null
  competitors: unknown
  userQueries: unknown
  language: string
  cadence: string
  cron: string
  timezone: string
  enabled: boolean
  lastCheckId: string | null
  lastRunAt: Date | null
  lastStatus: string | null
  nextRunAt: Date | null
  runningCheckId: string | null
  createdAt: Date
  updatedAt: Date
}

function toSummary(row: ScheduleRow): GeoHealthScheduleSummary {
  return {
    id: row.id,
    brandName: row.brandName,
    siteUrl: row.siteUrl,
    industry: row.industry,
    competitors: asStringList(row.competitors),
    userQueries: asStringList(row.userQueries),
    language: asLanguage(row.language),
    cadence: asCadence(row.cadence),
    cron: row.cron,
    timezone: SCHEDULE_TZ,
    enabled: row.enabled,
    lastCheckId: row.lastCheckId,
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    lastStatus: asStatus(row.lastStatus),
    nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
    running: Boolean(row.runningCheckId),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function isUnique(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002'
}

export interface ScheduleRunner {
  list(workspaceId: string): Promise<GeoHealthScheduleSummary[]>
  save(workspaceId: string, input: ScheduleSaveInput): Promise<GeoHealthScheduleSummary>
  setEnabled(workspaceId: string, id: string, enabled: boolean): Promise<GeoHealthScheduleSummary>
  remove(workspaceId: string, id: string): Promise<{ id: string }>
  runDue(): Promise<{ started: string[]; skippedBusy: number; skippedInactive: number }>
}

/**
 * One schedule per workspace + brand + site. The tick claims a row before
 * creating a check, so two workers cannot start the same schedule twice.
 * Engine credentials stay on the workspace: the job carries only the check id,
 * and the pillar runner resolves keys for that check's workspace.
 */
export function createScheduleRunner(deps: {
  prisma: PrismaClient
  now?: () => Date
  enqueue(checkId: string): Promise<string | null>
}): ScheduleRunner {
  const now = deps.now ?? (() => new Date())
  const db = deps.prisma.geoHealthSchedule

  function fields(input: ScheduleSaveInput, enabled: boolean) {
    const prepared = prepareHealthFields(input)
    const resolved = resolveScheduleCron(input.cadence, input.cron, now())
    return {
      brandName: prepared.brandName,
      brandKey: prepared.brandName.toLowerCase(),
      siteUrl: prepared.siteUrl,
      industry: prepared.industry,
      competitors: prepared.competitors as unknown as Prisma.InputJsonValue,
      userQueries: prepared.userQueries as unknown as Prisma.InputJsonValue,
      language: prepared.language,
      cadence: input.cadence,
      cron: resolved.cron,
      timezone: SCHEDULE_TZ,
      enabled,
      nextRunAt: enabled ? resolved.nextRunAt : null,
    }
  }

  return {
    async list(workspaceId) {
      const rows = await db.findMany({
        where: { workspaceId },
        orderBy: [{ enabled: 'desc' }, { nextRunAt: 'asc' }],
      })
      return rows.map((row) => toSummary(row as ScheduleRow))
    },

    async save(workspaceId, input) {
      const data = fields(input, true)
      try {
        if (input.id) {
          const current = await db.findFirst({ where: { id: input.id, workspaceId } })
          if (!current) throw new GeoHealthError('NOT_FOUND', '体检计划不存在')
          const row = await db.update({ where: { id: current.id }, data })
          return toSummary(row as ScheduleRow)
        }
        const row = await db.upsert({
          where: {
            workspaceId_brandKey_siteUrl: {
              workspaceId,
              brandKey: data.brandKey,
              siteUrl: data.siteUrl,
            },
          },
          create: { workspaceId, ...data },
          update: data,
        })
        return toSummary(row as ScheduleRow)
      } catch (err) {
        if (err instanceof GeoHealthError) throw err
        if (isUnique(err)) throw new GeoHealthError('BAD_INPUT', '这个品牌和站点已经有一份体检计划')
        throw err
      }
    },

    async setEnabled(workspaceId, id, enabled) {
      const current = await db.findFirst({ where: { id, workspaceId } })
      if (!current) throw new GeoHealthError('NOT_FOUND', '体检计划不存在')
      const row = await db.update({
        where: { id },
        data: {
          enabled,
          nextRunAt: enabled ? nextRunAfter(current.cron, now()) : current.nextRunAt,
        },
      })
      return toSummary(row as ScheduleRow)
    },

    async remove(workspaceId, id) {
      const current = await db.findFirst({ where: { id, workspaceId } })
      if (!current) throw new GeoHealthError('NOT_FOUND', '体检计划不存在')
      await db.delete({ where: { id } })
      return { id }
    },

    async runDue() {
      const due = await db.findMany({
        where: { enabled: true, nextRunAt: { lte: now() } },
        orderBy: { nextRunAt: 'asc' },
        take: 25,
      })
      const started: string[] = []
      let skippedBusy = 0
      let skippedInactive = 0
      for (const schedule of due) {
        const outcome = await claimOne(deps.prisma, schedule.id, now)
        if (outcome.kind === 'busy') {
          skippedBusy += 1
          continue
        }
        if (outcome.kind === 'inactive') {
          skippedInactive += 1
          continue
        }
        if (outcome.kind !== 'start') continue
        const jobId = await deps.enqueue(outcome.checkId)
        if (jobId) {
          started.push(outcome.checkId)
          continue
        }
        await deps.prisma.geoHealthCheck.update({
          where: { id: outcome.checkId },
          data: { status: 'FAILED', error: '任务队列没有接受体检任务', finishedAt: now() },
        })
        await db.update({
          where: { id: schedule.id },
          data: {
            runningCheckId: null,
            lastStatus: 'FAILED',
            nextRunAt: new Date(now().getTime() + RETRY_DELAY_MS),
          },
        })
      }
      return { started, skippedBusy, skippedInactive }
    },
  }
}

type Claim =
  | { kind: 'start'; checkId: string }
  | { kind: 'busy' }
  | { kind: 'inactive' }
  | { kind: 'skip' }

async function claimOne(prisma: PrismaClient, scheduleId: string, now: () => Date): Promise<Claim> {
  return prisma.$transaction(async (tx) => {
    const schedule = await tx.geoHealthSchedule.findUnique({ where: { id: scheduleId } })
    const clock = now()
    if (!schedule || !schedule.enabled || !schedule.nextRunAt || schedule.nextRunAt > clock) return { kind: 'skip' }
    const workspace = await tx.workspace.findUnique({
      where: { id: schedule.workspaceId },
      select: { status: true },
    })
    if (!workspace || workspace.status !== 'ACTIVE') {
      await tx.geoHealthSchedule.update({
        where: { id: schedule.id },
        data: { nextRunAt: nextRunAfter(schedule.cron, clock) },
      })
      return { kind: 'inactive' }
    }
    if (schedule.runningCheckId) {
      const running = await tx.geoHealthCheck.findUnique({ where: { id: schedule.runningCheckId } })
      if (running && ACTIVE.has(running.status)) {
        const stale = running.status === 'QUEUED' && clock.getTime() - running.createdAt.getTime() > 3 * 60 * 1000
        if (stale) {
          await tx.geoHealthSchedule.update({
            where: { id: schedule.id },
            data: { nextRunAt: nextRunAfter(schedule.cron, clock) },
          })
          return { kind: 'start', checkId: running.id }
        }
        await tx.geoHealthSchedule.update({
          where: { id: schedule.id },
          data: { nextRunAt: nextRunAfter(schedule.cron, clock) },
        })
        return { kind: 'busy' }
      }
    }
    const check = await tx.geoHealthCheck.create({
      data: {
        workspaceId: schedule.workspaceId,
        brandName: schedule.brandName,
        siteUrl: schedule.siteUrl,
        industry: schedule.industry,
        competitors: schedule.competitors as Prisma.InputJsonValue,
        userQueries: schedule.userQueries as Prisma.InputJsonValue,
        language: schedule.language,
        status: 'QUEUED',
        trigger: 'SCHEDULED',
        scheduleId: schedule.id,
        progress: emptyProgress() as unknown as Prisma.InputJsonValue,
      },
    })
    const claimed = await tx.geoHealthSchedule.updateMany({
      where: {
        id: schedule.id,
        enabled: true,
        runningCheckId: schedule.runningCheckId,
        nextRunAt: schedule.nextRunAt,
      },
      data: {
        runningCheckId: check.id,
        lastCheckId: check.id,
        lastRunAt: clock,
        lastStatus: 'QUEUED',
        nextRunAt: nextRunAfter(schedule.cron, clock),
      },
    })
    if (claimed.count === 0) {
      await tx.geoHealthCheck.delete({ where: { id: check.id } })
      return { kind: 'skip' }
    }
    return { kind: 'start', checkId: check.id }
  })
}
