import type { PrismaClient, OptimizationTask } from '@prisma/client'
import type { EntityExtractorService } from '../../core/extract/entity-extractor.js'
import type { KgAdapterService } from '../../core/extract/adapters/kg-adapter.js'
import {
  resolveWorkspaceOrganization,
  type BillingCheckpoints,
} from '../../platform/billing/entitlement-guard.js'
import type { KgProposalSet } from './types.js'

export interface KgExtractorService {
  extractFromPage(pageId: string): Promise<{ proposals: KgProposalSet; task: OptimizationTask }>
}

export function createKgExtractor(deps: {
  prisma: PrismaClient
  extractor: EntityExtractorService
  kgAdapter: KgAdapterService
  /**
   * 计费检查点（任务 9 审查补漏，可选注入）：UPDATE_KG 任务创建 →
   * optimizationsPerMonth 软限 + OPTIMIZATION_CREATED 计量（与其他优化任务
   * 同漏斗同 key）。enforcement 开关在 guard 内部，缺省注入零行为。
   */
  billing?: BillingCheckpoints
}): KgExtractorService {
  const { prisma, extractor, kgAdapter, billing } = deps
  return {
    async extractFromPage(pageId) {
      const page = await prisma.contentPage.findUnique({ where: { id: pageId } })
      if (!page) throw new Error(`Page not found: ${pageId}`)

      const extraction = await extractor.extract(page.currentContent)
      const entities = kgAdapter.adapt(extraction.entities)

      const proposals: KgProposalSet = {
        entities,
        relations: extraction.relations.map((r) => ({
          fromName: r.fromName,
          toName: r.toName,
          relationType: r.relationType,
          properties: r.properties,
        })),
        sourcePageUrl: page.url,
        extractedAt: new Date().toISOString(),
      }

      // 任务 9：优化任务创建软限检查点（先检查后计量，超额告警不拦截）
      let meterTask: (() => void) | null = null
      if (billing) {
        const organizationId = await resolveWorkspaceOrganization(prisma, page.workspaceId)
        if (organizationId) {
          await billing.guard.softCheck(organizationId, 'optimizationsPerMonth', 1)
          meterTask = () =>
            billing.meter.record({
              organizationId,
              workspaceId: page.workspaceId,
              kind: 'OPTIMIZATION_CREATED',
              quantity: 1,
            })
        }
      }
      const task = await prisma.optimizationTask.create({
        data: {
          workspaceId: page.workspaceId,
          type: 'UPDATE_KG',
          status: 'PENDING',
          pageId,
          result: proposals as any,
          extractionProposals: proposals as any,
        },
      })
      meterTask?.()

      return { proposals, task }
    },
  }
}
