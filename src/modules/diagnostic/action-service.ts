import type { PrismaClient } from '@prisma/client'
import { DiagnosticError } from './errors.js'

export interface ActionService {
  list(workspaceId: string, runId: string, horizon?: string, status?: string): Promise<any[]>
  accept(workspaceId: string, actionId: string): Promise<any>
  dismiss(workspaceId: string, actionId: string, reason?: string): Promise<any>
  convert(workspaceId: string, actionId: string): Promise<any>
}

export interface ActionServiceDeps {
  prisma: PrismaClient
  taskService: {
    create(input: {
      workspaceId: string
      type: string
      pageId?: string
      queryId?: string
      result?: Record<string, unknown>
    }): Promise<{ id: string }>
  }
}

const CONVERTIBLE_TYPES = new Set(['OPTIMIZE_EXISTING_PAGE', 'REWRITE_CONTENT', 'ADD_STRUCTURED_DATA', 'UPDATE_KG'])

export function createActionService(deps: ActionServiceDeps): ActionService {
  const { prisma, taskService } = deps

  return {
    async list(workspaceId, runId, horizon, status) {
      const where: any = { workspaceId, runId }
      if (horizon) where.horizon = horizon
      if (status) where.status = status
      return prisma.diagnosticAction.findMany({
        where,
        orderBy: [{ horizon: 'asc' }, { priority: 'asc' }],
      })
    },

    async accept(workspaceId, actionId) {
      const action = await prisma.diagnosticAction.findFirst({
        where: { id: actionId, workspaceId },
      })
      if (!action) throw new DiagnosticError('PROJECT_NOT_FOUND', 'PROJECT_NOT_FOUND')
      if (action.status !== 'PROPOSED') {
        throw new Error('Only PROPOSED actions can be accepted')
      }
      return prisma.diagnosticAction.update({
        where: { id: actionId },
        data: { status: 'ACCEPTED' },
      })
    },

    async dismiss(workspaceId, actionId, reason) {
      const action = await prisma.diagnosticAction.findFirst({
        where: { id: actionId, workspaceId },
      })
      if (!action) throw new DiagnosticError('PROJECT_NOT_FOUND', 'PROJECT_NOT_FOUND')
      if (action.status === 'CONVERTED') {
        throw new Error('Cannot dismiss a converted action')
      }
      return prisma.diagnosticAction.update({
        where: { id: actionId },
        data: { status: 'DISMISSED', dismissReason: reason ?? null },
      })
    },

    async convert(workspaceId, actionId) {
      const action = await prisma.diagnosticAction.findFirst({
        where: { id: actionId, workspaceId },
      })
      if (!action) throw new DiagnosticError('PROJECT_NOT_FOUND', 'PROJECT_NOT_FOUND')

      // Idempotent: already converted
      if (action.status === 'CONVERTED' && action.optimizationTaskId) {
        return action
      }

      if (action.status !== 'ACCEPTED') {
        throw new Error('Only ACCEPTED actions can be converted')
      }

      if (!CONVERTIBLE_TYPES.has(action.actionType)) {
        throw new DiagnosticError('ACTION_NOT_CONVERTIBLE', 'ACTION_NOT_CONVERTIBLE')
      }

      const taskType = actionTypeToTaskType(action.actionType)

      const result = await prisma.$transaction(async (tx: any) => {
        const task = await taskService.create({
          workspaceId,
          type: taskType,
          pageId: action.targetPageUrl ? undefined : undefined,
          result: {
            actionId: action.id,
            runId: action.runId,
            diagnosticActionType: action.actionType,
            targetRunQueryIds: action.targetRunQueryIds,
          },
        })

        await tx.diagnosticAction.update({
          where: { id: actionId },
          data: {
            status: 'CONVERTED',
            optimizationTaskId: task.id,
          },
        })

        return task
      })

      return {
        ...action,
        status: 'CONVERTED',
        optimizationTaskId: result.id,
      }
    },
  }
}

function actionTypeToTaskType(actionType: string): string {
  const map: Record<string, string> = {
    OPTIMIZE_EXISTING_PAGE: 'OPTIMIZE_FOR_QUERY',
    REWRITE_CONTENT: 'REWRITE_CONTENT',
    ADD_STRUCTURED_DATA: 'GENERATE_SCHEMA',
    UPDATE_KG: 'UPDATE_KG',
  }
  return map[actionType] ?? 'OPTIMIZE_FOR_QUERY'
}
