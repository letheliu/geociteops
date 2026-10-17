import type { PrismaClient, DiagnosticRun, DiagnosticRunStatus } from '@prisma/client'
import {
  resolveWorkspaceOrganization,
  type BillingCheckpoints,
} from '../../platform/billing/entitlement-guard.js'
import { DiagnosticError } from './errors.js'
import type { RunDraftConfig } from './types.js'

export interface CreateRunDraftInput {
  projectId: string
  queryIds: string[]
  platforms: string[]
  samplesPerQuery: number
  locale: string
  timezone: string
}

export interface RunValidationError {
  code: string
  message: string
  type: 'error' | 'warning'
}

export interface RunValidationResult {
  valid: boolean
  errors: RunValidationError[]
  warnings: RunValidationError[]
  totalUnits: number
}

export interface DiagnosticRunService {
  list(workspaceId: string, projectId?: string): Promise<DiagnosticRun[]>
  get(workspaceId: string, runId: string): Promise<DiagnosticRun>
  createDraft(workspaceId: string, input: CreateRunDraftInput): Promise<DiagnosticRun>
  updateDraft(workspaceId: string, runId: string, input: RunDraftConfig): Promise<DiagnosticRun>
  validate(workspaceId: string, runId: string): Promise<RunValidationResult>
  markReady(workspaceId: string, runId: string): Promise<DiagnosticRun>
  start(workspaceId: string, runId: string): Promise<DiagnosticRun>
  cancel(workspaceId: string, runId: string): Promise<DiagnosticRun>
  retryDispatch(workspaceId: string, runId: string): Promise<DiagnosticRun>
  retryFailed(workspaceId: string, runId: string, sampleIds?: string[]): Promise<DiagnosticRun>
  createRetest(workspaceId: string, baselineRunId: string): Promise<DiagnosticRun>
}

export interface DiagnosticRunServiceDeps {
  prisma: PrismaClient
  registry: {
    get: (platform: string) => any
    list: () => string[]
  }
  dispatchRun?: (runId: string) => Promise<void>
  /**
   * 计费检查点（任务 9，可选注入）：run 创建 → diagnosticRunsPerMonth 软限 +
   * samplesPerRun 上限 + DIAGNOSTIC_RUN 计量。enforcement 开关在 guard 内部。
   */
  billing?: BillingCheckpoints
}

const MAX_TOTAL_UNITS = 500

export function createRunService(deps: DiagnosticRunServiceDeps): DiagnosticRunService {
  const { prisma, registry, dispatchRun, billing } = deps

  /**
   * run 创建检查点（任务 9）：先 softCheck（月度软限，超额仅告警）再
   * checkSamplesPerRun（上限硬拒）；返回创建成功后的计量闭包。
   */
  async function checkpointRunCreation(
    workspaceId: string,
    samplesPerQuery: number,
  ): Promise<(() => void) | null> {
    if (!billing) return null
    const organizationId = await resolveWorkspaceOrganization(prisma, workspaceId)
    if (!organizationId) return null
    await billing.guard.softCheck(organizationId, 'diagnosticRunsPerMonth', 1)
    await billing.guard.checkSamplesPerRun(organizationId, samplesPerQuery)
    return () =>
      billing.meter.record({
        organizationId,
        workspaceId,
        kind: 'DIAGNOSTIC_RUN',
        quantity: 1,
      })
  }

  async function findRunOrThrow(workspaceId: string, runId: string): Promise<DiagnosticRun> {
    const run = await prisma.diagnosticRun.findFirst({
      where: { id: runId, workspaceId },
    })
    if (!run) throw new DiagnosticError('PROJECT_NOT_FOUND', 'PROJECT_NOT_FOUND')
    return run
  }

  const VALID_TRANSITIONS: Record<DiagnosticRunStatus, DiagnosticRunStatus[]> = {
    DRAFT: ['READY'],
    READY: ['RUNNING', 'CANCELLED'],
    RUNNING: ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'],
    PARTIAL: ['RUNNING'],
    FAILED: ['RUNNING'],
    COMPLETED: [],
    CANCELLED: [],
  }

  function assertTransition(from: DiagnosticRunStatus, to: DiagnosticRunStatus): void {
    const allowed = VALID_TRANSITIONS[from]
    if (!allowed || !allowed.includes(to)) {
      throw new DiagnosticError('RUN_NOT_STARTABLE', `Cannot transition from ${from} to ${to}`)
    }
  }

  return {
    async list(workspaceId, projectId?) {
      const where: any = { workspaceId }
      if (projectId) where.projectId = projectId
      return prisma.diagnosticRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
      })
    },

    async get(workspaceId, runId) {
      return findRunOrThrow(workspaceId, runId)
    },

    async createDraft(workspaceId, input) {
      const meterRun = await checkpointRunCreation(workspaceId, input.samplesPerQuery)
      const run = await prisma.diagnosticRun.create({
        data: {
          workspaceId,
          projectId: input.projectId,
          runType: 'BASELINE',
          status: 'DRAFT',
          draftConfig: {
            queryIds: input.queryIds,
            platforms: input.platforms,
            samplesPerQuery: input.samplesPerQuery,
            locale: input.locale,
            timezone: input.timezone,
          },
        },
      })
      meterRun?.()
      return run
    },

    async updateDraft(workspaceId, runId, input) {
      const run = await findRunOrThrow(workspaceId, runId)
      if (run.status !== 'DRAFT') {
        throw new DiagnosticError('RUN_NOT_EDITABLE', 'RUN_NOT_EDITABLE')
      }
      // 任务 9 审查补漏（Important-2）：草稿更新同样受 samplesPerRun 上限约束——
      // 创建时校验后 updateDraft 仍可把 samplesPerQuery 抬到 zod 上限，这里复查堵住
      if (billing) {
        const organizationId = await resolveWorkspaceOrganization(prisma, workspaceId)
        if (organizationId) {
          await billing.guard.checkSamplesPerRun(organizationId, input.samplesPerQuery)
        }
      }
      return prisma.diagnosticRun.update({
        where: { id: runId },
        data: { draftConfig: input as any },
      })
    },

    async validate(workspaceId, runId) {
      const run = await findRunOrThrow(workspaceId, runId)
      const errors: RunValidationError[] = []
      const warnings: RunValidationError[] = []

      const config = run.draftConfig as any as RunDraftConfig | null
      if (!config) {
        errors.push({ code: 'NO_CONFIG', message: 'No draft config', type: 'error' })
        return { valid: false, errors, warnings, totalUnits: 0 }
      }

      const totalUnits = config.queryIds.length * config.platforms.length * config.samplesPerQuery

      // Check confirmed queries
      if (config.queryIds.length === 0) {
        errors.push({ code: 'NO_CONFIRMED_QUERIES', message: 'NO_CONFIRMED_QUERIES', type: 'error' })
      }

      // Check platforms registered
      if (config.platforms.length === 0) {
        errors.push({ code: 'NO_PLATFORMS', message: 'No platforms selected', type: 'error' })
      }
      for (const p of config.platforms) {
        if (!registry.get(p)) {
          errors.push({ code: 'PLATFORM_NOT_CONFIGURED', message: `Platform ${p} not configured`, type: 'error' })
        }
      }

      // Check scope
      if (totalUnits > MAX_TOTAL_UNITS) {
        errors.push({ code: 'RUN_SCOPE_TOO_LARGE', message: `Scope ${totalUnits} exceeds maximum ${MAX_TOTAL_UNITS}`, type: 'error' })
      }

      // Warnings
      if (config.platforms.length === 1) {
        warnings.push({ code: 'SINGLE_PLATFORM', message: 'Only one platform selected', type: 'warning' })
      }
      if (config.samplesPerQuery === 1) {
        warnings.push({ code: 'SINGLE_SAMPLE', message: 'Only sampling once per query', type: 'warning' })
      }

      return { valid: errors.length === 0, errors, warnings, totalUnits }
    },

    async markReady(workspaceId, runId) {
      const run = await findRunOrThrow(workspaceId, runId)
      if (run.status !== 'DRAFT') {
        throw new DiagnosticError('RUN_NOT_EDITABLE', 'RUN_NOT_EDITABLE')
      }
      const config = run.draftConfig as any as RunDraftConfig | null
      if (!config) throw new Error('No draft config')

      const project = await prisma.diagnosticProject.findFirst({
        where: { id: run.projectId, workspaceId },
      })
      if (!project) throw new DiagnosticError('PROJECT_NOT_FOUND', 'PROJECT_NOT_FOUND')

      const queries = await prisma.diagnosticQuery.findMany({
        where: { id: { in: config.queryIds }, projectId: run.projectId },
      })

      const result = await prisma.$transaction(async (tx: any) => {
        // Create run queries
        const runQueriesData = queries.map((q, i) => ({
          runId,
          sourceQueryId: q.id,
          queryText: q.queryText,
          queryType: q.queryType,
          intentLabel: q.intentLabel,
          targetAudience: q.targetAudience,
          mappedPageUrl: q.mappedPageUrl,
          priority: q.priority,
          orderIndex: i,
        }))

        await tx.diagnosticRunQuery.createMany({ data: runQueriesData })

        // Update run with snapshots
        const totalUnits = config.queryIds.length * config.platforms.length * config.samplesPerQuery
        const updated = await tx.diagnosticRun.update({
          where: { id: runId },
          data: {
            status: 'READY',
            brandSnapshot: {
              brandName: project.brandName,
              brandAliases: project.brandAliases,
              brandDomain: project.brandDomain,
            },
            competitorSnapshot: project.competitors,
            platformSnapshot: config.platforms,
            samplingSnapshot: {
              samplesPerQuery: config.samplesPerQuery,
              locale: config.locale,
              timezone: config.timezone,
            },
            totalUnits,
            dispatchStatus: 'NOT_STARTED',
          },
        })

        return updated
      })

      return result
    },

    async start(workspaceId, runId) {
      const run = await findRunOrThrow(workspaceId, runId)
      if (run.status !== 'READY') {
        throw new DiagnosticError('RUN_NOT_STARTABLE', 'RUN_NOT_STARTABLE')
      }

      const config = run.draftConfig as any as RunDraftConfig | null
      const platforms = (run.platformSnapshot as string[]) ?? config?.platforms ?? []
      const sampling = (run.samplingSnapshot as any) ?? { samplesPerQuery: 1, locale: 'zh-CN', timezone: 'Asia/Shanghai' }
      const runQueries = await prisma.diagnosticRunQuery.findMany({ where: { runId } })

      const result = await prisma.$transaction(async (tx: any) => {
        // Create all samples
        const samples: any[] = []
        for (const rq of runQueries) {
          for (const platform of platforms) {
            for (let i = 0; i < sampling.samplesPerQuery; i++) {
              samples.push({
                workspaceId,
                runId,
                runQueryId: rq.id,
                platform,
                sampleIndex: i,
                status: 'PENDING',
              })
            }
          }
        }

        if (samples.length > 0) {
          await tx.diagnosticSample.createMany({ data: samples })
        }

        const updated = await tx.diagnosticRun.update({
          where: { id: runId },
          data: {
            status: 'RUNNING',
            dispatchStatus: 'PENDING',
            startedAt: new Date(),
          },
        })

        return updated
      })

      // After transaction: dispatch
      if (dispatchRun) {
        try {
          await dispatchRun(runId)
          await prisma.diagnosticRun.update({
            where: { id: runId },
            data: { dispatchStatus: 'QUEUED' },
          })
        } catch (err: any) {
          await prisma.diagnosticRun.update({
            where: { id: runId },
            data: {
              dispatchStatus: 'FAILED',
              dispatchError: err.message ?? 'QUEUE_UNAVAILABLE',
            },
          })
        }
      }

      return result
    },

    async cancel(workspaceId, runId) {
      const run = await findRunOrThrow(workspaceId, runId)
      if (!['READY', 'RUNNING', 'PARTIAL', 'FAILED'].includes(run.status)) {
        throw new DiagnosticError('RUN_NOT_STARTABLE', 'Cannot cancel in current status')
      }

      // Cancel pending samples
      await prisma.diagnosticSample.updateMany({
        where: { runId, status: 'PENDING' },
        data: { status: 'CANCELLED' },
      })

      return prisma.diagnosticRun.update({
        where: { id: runId },
        data: { status: 'CANCELLED', completedAt: new Date() },
      })
    },

    async retryDispatch(workspaceId, runId) {
      const run = await findRunOrThrow(workspaceId, runId)
      if (run.status !== 'RUNNING') {
        throw new DiagnosticError('RUN_NOT_STARTABLE', 'Can only retry dispatch for RUNNING runs')
      }

      await prisma.diagnosticRun.update({
        where: { id: runId },
        data: { dispatchStatus: 'PENDING' },
      })

      if (dispatchRun) {
        try {
          await dispatchRun(runId)
          await prisma.diagnosticRun.update({
            where: { id: runId },
            data: { dispatchStatus: 'QUEUED' },
          })
        } catch (err: any) {
          await prisma.diagnosticRun.update({
            where: { id: runId },
            data: {
              dispatchStatus: 'FAILED',
              dispatchError: err.message ?? 'QUEUE_UNAVAILABLE',
            },
          })
        }
      }

      return findRunOrThrow(workspaceId, runId)
    },

    async retryFailed(workspaceId, runId, sampleIds) {
      const run = await findRunOrThrow(workspaceId, runId)
      if (!['RUNNING', 'PARTIAL', 'FAILED'].includes(run.status)) {
        throw new DiagnosticError('RUN_NOT_STARTABLE', 'Cannot retry in current status')
      }

      const where: any = { runId, status: 'FAILED' }
      if (sampleIds) where.id = { in: sampleIds }

      await prisma.diagnosticSample.updateMany({
        where,
        data: { status: 'PENDING', errorCode: null, errorMessage: null },
      })

      return findRunOrThrow(workspaceId, runId)
    },

    async createRetest(workspaceId, baselineRunId) {
      const baseline = await findRunOrThrow(workspaceId, baselineRunId)
      if (baseline.status !== 'COMPLETED' && baseline.status !== 'PARTIAL') {
        throw new Error('Baseline run must be COMPLETED or PARTIAL')
      }

      // 复测沿用基线采样数做上限校验（配置缺失/非法时跳过该子检查）
      const baselineSamples = (baseline.draftConfig as any)?.samplesPerQuery
      const meterRun = await checkpointRunCreation(
        workspaceId,
        typeof baselineSamples === 'number' ? baselineSamples : 0,
      )
      const draft = await prisma.diagnosticRun.create({
        data: {
          workspaceId,
          projectId: baseline.projectId,
          runType: 'RETEST',
          baselineRunId: baseline.id,
          status: 'DRAFT',
          draftConfig: baseline.draftConfig as any,
        },
      })
      meterRun?.()

      return draft
    },
  }
}
