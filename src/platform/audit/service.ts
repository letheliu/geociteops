import type { Prisma, PrismaClient, AuditLog } from '@prisma/client'

/** 审计写进入参：actorType/action 必填，其余均可选 */
export interface AuditRecordInput {
  actorId?: string
  actorType: string
  action: string
  organizationId?: string
  workspaceId?: string
  target?: string
  diff?: Prisma.InputJsonValue
  ip?: string
}

/** 审计查询入参：各过滤字段仅有值时生效 */
export interface AuditListQuery {
  page?: number
  pageSize?: number
  action?: string
  workspaceId?: string
  actorId?: string
}

export interface AuditListResult {
  items: AuditLog[]
  total: number
}

export interface AuditService {
  /** 写审计日志；异常吞掉并 console.error（审计不阻断业务），永不抛出 */
  record(input: AuditRecordInput): Promise<void>
  list(query: AuditListQuery): Promise<AuditListResult>
}

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

export function createAuditService(prisma: PrismaClient): AuditService {
  return {
    async record(input) {
      const data: Prisma.AuditLogUncheckedCreateInput = {
        actorType: input.actorType,
        action: input.action,
      }
      if (input.actorId !== undefined) data.actorId = input.actorId
      if (input.organizationId !== undefined) data.organizationId = input.organizationId
      if (input.workspaceId !== undefined) data.workspaceId = input.workspaceId
      if (input.target !== undefined) data.target = input.target
      if (input.diff !== undefined) data.diff = input.diff
      if (input.ip !== undefined) data.ip = input.ip

      try {
        await prisma.auditLog.create({ data })
      } catch (error) {
        // 审计失败只记日志，不阻断业务主流程
        console.error('[audit] 写入审计日志失败', { action: input.action, error })
      }
    },

    async list(query) {
      const page = query.page ?? 1
      const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)

      const where: Prisma.AuditLogWhereInput = {}
      if (query.action) where.action = query.action
      if (query.workspaceId) where.workspaceId = query.workspaceId
      if (query.actorId) where.actorId = query.actorId

      const [items, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.auditLog.count({ where }),
      ])
      return { items, total }
    },
  }
}
