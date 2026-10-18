import { TRPCError } from '@trpc/server'
import { router, protectedProcedure } from '../trpc/init.js'

/** workspace.get 的脱敏投影：绝不回传 platformConfig（无论密文还是明文） */
export interface WorkspaceGetProjection {
  id: string
  name: string
  domain: string | null
  llmsTxtUrl: string | null
  defaultBrandName: string
  status: string
  platformSummary: Record<string, { configured: boolean; hint: string }>
  competitors: string[]
  /** 监测采样数 N（生效前的配置值，实际会被 unit cap 钳制，见规格 §6） */
  monitorSampleCount: number
  /** 监测节奏：DAILY / WEEKLY / OFF */
  monitorSchedule: 'DAILY' | 'WEEKLY' | 'OFF'
}

/**
 * Workspace 路由（任务 12 后仅剩查询）：
 * - get：脱敏投影——基础字段取 ctx.workspace，平台配置概况与竞品列表经
 *   ctx.services.getWorkspaceSummary（= CredentialResolver.getSummary，server.ts 装配），
 *   只暴露 configured/hint，凭证明文与密文均不出服务端；
 * - register / setPlatformConfig 已于任务 12 下线：
 *   工作区开通与凭证写入统一走 admin.workspace（platformProcedure 鉴权）。
 */
export const workspaceRouter = router({
  get: protectedProcedure.query(async ({ ctx }): Promise<WorkspaceGetProjection> => {
    const getSummary = ctx.services?.getWorkspaceSummary as
      | ((workspaceId: string) => Promise<{
          competitors: string[]
          platforms: Record<string, { configured: boolean; hint: string }>
        }>)
      | undefined
    if (!getSummary) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'services.getWorkspaceSummary 未装配：workspace.get 无法生成脱敏概况',
      })
    }

    const summary = await getSummary(ctx.workspace.id)
    const ws = ctx.workspace
    return {
      id: ws.id,
      name: ws.name,
      domain: ws.domain,
      llmsTxtUrl: ws.llmsTxtUrl,
      defaultBrandName: ws.defaultBrandName,
      status: ws.status,
      platformSummary: summary.platforms,
      competitors: summary.competitors,
      monitorSampleCount: ws.monitorSampleCount,
      monitorSchedule: ws.monitorSchedule,
    }
  }),
})
