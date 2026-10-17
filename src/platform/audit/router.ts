import { z } from 'zod'
import { router, platformProcedure } from '../../core/trpc/init.js'
import type { Context } from '../../core/trpc/init.js'
import { getPrismaClient } from '../../core/db/client.js'
import { createAuditService } from './service.js'
import type { AuditService } from './service.js'

let defaultService: AuditService | undefined

/**
 * 取 audit service：优先 ctx.services.audit（测试/组装注入），
 * 否则惰性构建默认实例（真实 prisma）。
 */
function getAuditService(ctx: Context): AuditService {
  const injected = (ctx as { services?: { audit?: AuditService } }).services?.audit
  if (injected) return injected
  if (!defaultService) {
    defaultService = createAuditService(getPrismaClient())
  }
  return defaultService
}

/**
 * 审计日志查询路由（挂载于 appRouter.admin.audit，platformProcedure('audit.view')）。
 */
export const auditRouter = router({
  list: platformProcedure('audit.view')
    .input(
      z
        .object({
          page: z.number().int().min(1).default(1),
          pageSize: z.number().int().min(1).max(100).default(20),
          action: z.string().optional(),
          workspaceId: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => getAuditService(ctx).list(input ?? {})),
})
