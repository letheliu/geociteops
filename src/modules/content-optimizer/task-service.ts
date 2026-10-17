import type { PrismaClient, OptimizationTask, TaskType, TaskStatus } from '@prisma/client'
import {
  resolveWorkspaceOrganization,
  type BillingCheckpoints,
} from '../../platform/billing/entitlement-guard.js'

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

  return {
    async create(input) {
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
