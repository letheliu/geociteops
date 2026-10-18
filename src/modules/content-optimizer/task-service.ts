import type { PrismaClient, OptimizationTask, TaskType, TaskStatus } from '@prisma/client'
import {
  resolveWorkspaceOrganization,
  type BillingCheckpoints,
} from '../../platform/billing/entitlement-guard.js'
import { dayKey, MAX_TREND_RANGE_DAYS } from '../citation-monitor/aggregate.js'
import { loadQueryBaselines } from '../citation-monitor/weak-points.js'

export interface CreateTaskInput {
  workspaceId: string
  type: TaskType
  pageId?: string
  queryId?: string
  beforeScore?: number
  afterScore?: number
  result?: Record<string, unknown>
}

export interface TaskServiceDeps {
  prisma: PrismaClient
  onPublished?: (task: OptimizationTask) => Promise<void>
  /**
   * 计费检查点（任务 9，可选注入）：优化任务创建 → optimizationsPerMonth 软限 +
   * OPTIMIZATION_CREATED 计量。enforcement 开关在 guard 内部。
   */
  billing?: BillingCheckpoints
  /** 时钟注入（发布事务的 publishedAt/lastPublishedAt），缺省系统时间 */
  now?: () => Date
}

export interface TaskService {
  create(input: CreateTaskInput): Promise<OptimizationTask>
  list(workspaceId: string, status?: TaskStatus): Promise<OptimizationTask[]>
  getById(id: string): Promise<OptimizationTask | null>
  review(id: string, approved: boolean, note?: string): Promise<OptimizationTask>
  publish(id: string): Promise<OptimizationTask>
}

export function createTaskService(deps: TaskServiceDeps): TaskService {
  const { prisma, onPublished, billing } = deps
  const now = deps.now ?? (() => new Date())

  return {
    async create(input) {
      // M2 §3.3 优化门禁兜底（规格 §4）：六入口已在前置断言，此处是直连 create
      // （如 KG extractor 保留直连、SDK 内部调用等）的最后一道闸——同样在写库之前。
      if (billing) {
        const organizationId = await resolveWorkspaceOrganization(prisma, input.workspaceId)
        if (organizationId) await billing.guard.assertOptimizationsAllowed(organizationId)
      }

      // 任务 9：优化任务创建软限检查点（先检查后计量，超额告警不拦截）
      let meterTask: (() => void) | null = null
      if (billing) {
        const organizationId = await resolveWorkspaceOrganization(prisma, input.workspaceId)
        if (organizationId) {
          await billing.guard.softCheck(organizationId, 'optimizationsPerMonth', 1)
          meterTask = () =>
            billing.meter.record({
              organizationId,
              workspaceId: input.workspaceId,
              kind: 'OPTIMIZATION_CREATED',
              quantity: 1,
            })
        }
      }
      const task = await prisma.optimizationTask.create({
        data: {
          workspaceId: input.workspaceId,
          type: input.type,
          pageId: input.pageId,
          queryId: input.queryId,
          beforeScore: input.beforeScore,
          afterScore: input.afterScore,
          result: (input.result as any) ?? undefined,
          status: 'PENDING',
        },
      })
      meterTask?.()
      return task
    },

    async list(workspaceId, status) {
      const where: any = { workspaceId }
      if (status) where.status = status
      return prisma.optimizationTask.findMany({ where })
    },

    async getById(id) {
      return prisma.optimizationTask.findUnique({ where: { id } })
    },

    async review(id, approved, note) {
      const task = await prisma.optimizationTask.findUnique({ where: { id } })
      if (!task) throw new Error(`Task not found: ${id}`)

      // M2 §3.3 状态守卫（双向）：仅 PENDING/IN_PROGRESS 可被审核。
      // approve 与 reject 同规则——否则 FAILED（建议生成失败的终态）可经 reject 被
      // 退回为 PENDING 再复活，闭环两态也可被重复审核外溢。
      if (task.status !== 'PENDING' && task.status !== 'IN_PROGRESS') {
        throw new Error(
          `Task must be PENDING or IN_PROGRESS to review, current: ${task.status}`,
        )
      }

      if (approved) {
        const updated = await prisma.optimizationTask.update({
          where: { id },
          data: { status: 'REVIEWED' },
        })
        if (task.pageId) {
          await prisma.contentPage.update({
            where: { id: task.pageId },
            data: { status: 'REVIEWED' },
          })
        }
        return updated
      }

      return prisma.optimizationTask.update({
        where: { id },
        data: { status: 'PENDING', reviewNote: note },
      })
    },

    async publish(id) {
      const task = await prisma.optimizationTask.findUnique({ where: { id } })
      if (!task) throw new Error(`Task not found: ${id}`)
      if (task.status !== 'REVIEWED') {
        throw new Error(`Task must be REVIEWED to publish, current: ${task.status}`)
      }

      // M2 §3.3 闭环任务（规格 §6.3）：有 queryId 且带建议稿 → 单交互事务直迁 AWAITING_VERIFICATION
      const result = (task.result ?? {}) as Record<string, unknown>
      const suggestion = typeof result.suggestion === 'string' ? result.suggestion : null
      if (task.queryId && suggestion) {
        const updated = await prisma.$transaction(async (tx) => {
          const publishedAt = now()

          // 基线读与任务更新同事务（读用 tx 客户端）：finishedAt <= publishedAt，
          // 并发收尾的 Run 不算发布前基线
          const baselines = await loadQueryBaselines(tx as any, {
            workspaceId: task.workspaceId,
            queryId: task.queryId as string,
            fromDay: dayKey(new Date(publishedAt.getTime() - (MAX_TREND_RANGE_DAYS - 1) * 86_400_000)),
            toDay: dayKey(publishedAt),
            finishedBefore: publishedAt,
          })
          const baseline = baselines.get(task.queryId as string)

          const page = task.pageId
            ? await tx.contentPage.findUnique({
                where: { id: task.pageId },
                select: { currentContent: true },
              })
            : null

          const migrated = await tx.optimizationTask.update({
            where: { id },
            data: {
              // 直迁 AWAITING_VERIFICATION：闭环任务不落 PUBLISHED 中间态
              status: 'AWAITING_VERIFICATION',
              publishedAt,
              baselineRunId: baseline?.runId ?? null,
              baselineSovMean: baseline?.level.sovMean ?? null,
              baselineMentionRate: baseline?.level.brandMentionRate ?? null,
              baselineValidSamples: baseline?.level.validSamples ?? null,
              // 原文保留：审阅对比与人工回滚依据（发布即覆盖，系统不自动保留版本）
              result: { ...result, originalContent: page?.currentContent ?? null },
            },
          })

          if (page) {
            // optimizedContent 置 null：旧优化 JSON 与新文不符会污染 auto-sections 的 FAQ 构建
            await tx.contentPage.update({
              where: { id: task.pageId as string },
              data: {
                currentContent: suggestion,
                publishedContent: suggestion,
                lastPublishedAt: publishedAt,
                status: 'PUBLISHED',
                optimizedContent: null,
              },
            })
          }

          return migrated
        })

        // 回调在事务提交后触发（KG 提案持久化等）；异常不影响已完成的闭环迁移
        if (onPublished) {
          try {
            await onPublished(updated)
          } catch (err) {
            console.error(`[taskService] onPublished callback failed for task ${id}:`, err)
          }
        }
        return updated
      }

      // 无 queryId（或无建议稿）的历史任务：保持原 publish 语义
      const updated = await prisma.optimizationTask.update({
        where: { id },
        data: { status: 'PUBLISHED' },
      })
      if (task.pageId) {
        await prisma.contentPage.update({
          where: { id: task.pageId },
          data: { status: 'PUBLISHED' },
        })
      }

      // 触发回调（失败不影响状态更新）
      if (onPublished) {
        try {
          await onPublished(updated)
        } catch (err) {
          console.error(`[taskService] onPublished callback failed for task ${id}:`, err)
        }
      }

      return updated
    },
  }
}
