import type { ContentPage, Prisma, PrismaClient } from '@prisma/client'
import {
  resolveWorkspaceOrganization,
  type BillingCheckpoints,
} from '../../platform/billing/entitlement-guard.js'

// ---------------------------------------------------------------------------
// 内容页服务（任务 9 从 content router 的 pages.upsert 下沉）：
// 创建路径挂 maxPages 软限检查点 + PAGE_CREATED 计量；更新路径不检查不计量。
// ---------------------------------------------------------------------------

export interface PageUpsertInput {
  workspaceId: string
  url: string
  /** 新建时的页面类型（更新时仅在显式传入时覆盖） */
  pageType?: string
  /** 新建时的当前内容（更新时仅在显式传入时覆盖） */
  currentContent?: string
  /** 优化结果（orchestrator 写回路径） */
  optimizedContent?: string
  optimizationScore?: number
  /**
   * update 分支是否回写 pageType/currentContent（缺省 true——router upsert 语义：
   * 用户重提交覆盖页面内容）。orchestrator 优化复跑传 false：已存在页只更新
   * 优化结果，不覆盖原始页面内容（保持任务 9 前的直接 upsert 行为）。
   */
  updateContent?: boolean
}

export interface PageService {
  /**
   * 按(workspaceId, url) upsert：新建前 softCheck('maxPages')（软限不拦截，
   * 超额 audit 告警），新建成功后 meter.record(PAGE_CREATED)；已存在页更新
   * 不消耗配额。enforcement 开关在 guard 内部，业务不感知。
   */
  upsert(input: PageUpsertInput): Promise<ContentPage>
}

export interface PageServiceDeps {
  prisma: PrismaClient
  /** 计费检查点（任务 9，可选注入——缺省不检查便于存量测试） */
  billing?: BillingCheckpoints
}

export function createPageService(deps: PageServiceDeps): PageService {
  const { prisma, billing } = deps

  return {
    async upsert(input) {
      const where = {
        workspaceId_url: { workspaceId: input.workspaceId, url: input.url },
      }
      // 先探测存在性：upsert 的 update 分支不消耗页面配额，仅 create 分支检查
      const existing = billing
        ? await prisma.contentPage.findUnique({ where, select: { id: true } })
        : null

      let meterPage: (() => void) | null = null
      if (billing && !existing) {
        const organizationId = await resolveWorkspaceOrganization(prisma, input.workspaceId)
        if (organizationId) {
          await billing.guard.softCheck(organizationId, 'maxPages', 1)
          meterPage = () =>
            billing.meter.record({
              organizationId,
              workspaceId: input.workspaceId,
              kind: 'PAGE_CREATED',
              quantity: 1,
            })
        }
      }

      const create: Prisma.ContentPageUncheckedCreateInput = {
        workspaceId: input.workspaceId,
        url: input.url,
        pageType: input.pageType ?? 'landing',
        currentContent: input.currentContent ?? '',
      }
      if (input.optimizedContent !== undefined) create.optimizedContent = input.optimizedContent
      if (input.optimizationScore !== undefined) create.optimizationScore = input.optimizationScore

      const update: Prisma.ContentPageUpdateInput = {}
      const updateContent = input.updateContent !== false
      if (updateContent && input.pageType !== undefined) update.pageType = input.pageType
      if (updateContent && input.currentContent !== undefined) {
        update.currentContent = input.currentContent
      }
      if (input.optimizedContent !== undefined) update.optimizedContent = input.optimizedContent
      if (input.optimizationScore !== undefined) {
        update.optimizationScore = input.optimizationScore
      }

      const page = await prisma.contentPage.upsert({ where, create, update })
      meterPage?.()
      return page
    },
  }
}
