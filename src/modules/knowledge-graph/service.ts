import type { PrismaClient, KgEntity, KgRelation, OptimizationTask } from '@prisma/client'
import type { LlmProvider } from '../../core/llm/types.js'
import type { KgRepositoryService } from './repository.js'
import type { KgExtractorService } from './extractor.js'
import type { GraphExporterService } from './exporter.js'
import type { KgProposalSet, ExportInput } from './types.js'

/** 实体消歧相似度阈值：高于此值视为同一实体（异名同义），合并而非新建。 */
const SIMILARITY_THRESHOLD = Number(process.env.VECTOR_SIMILARITY_THRESHOLD || 0.85)

export interface KgService {
  // 手动 CRUD
  addEntity(input: { workspaceId: string; name: string; type: string; properties: Record<string, unknown>; sourceUrl?: string }): Promise<KgEntity>
  addRelation(input: { workspaceId: string; fromName: string; toName: string; relationType: string; properties?: Record<string, unknown> }): Promise<KgRelation>
  removeEntity(id: string): Promise<void>

  // 自动抽取
  extractFromPage(pageId: string): Promise<OptimizationTask>

  // 持久化提案（taskService onPublished 回调调用）
  persistProposals(workspaceId: string, proposals: KgProposalSet): Promise<{
    entitiesCreated: number
    entitiesSkipped: number
    entitiesMerged: number
    relationsCreated: number
    relationsSkipped: number
  }>

  // 查询
  listEntities(workspaceId: string, opts?: { type?: string }): Promise<KgEntity[]>
  listRelations(workspaceId: string, opts?: { fromId?: string; toId?: string }): Promise<KgRelation[]>
  getEntity(workspaceId: string, id: string): Promise<KgEntity | null>
  /** 语义检索：召回与 name 最相似的实体（消歧辅助 / 实体搜索）。 */
  findSimilarEntities(workspaceId: string, name: string, topK?: number): Promise<{ id: string; score: number; metadata: Record<string, unknown> }[]>

  // 导出
  exportGraph(input: ExportInput): Promise<string>
}

export function createKgService(deps: {
  prisma: PrismaClient
  repository: KgRepositoryService
  extractor: KgExtractorService
  exporter: GraphExporterService
  llm?: LlmProvider
}): KgService {
  /**
   * 入库一个实体并建立向量索引。
   * 先精确名查重 → 再向量召回消歧（异名同义合并）→ 否则新建。
   * 返回 { entity, action } 便于上层统计。
   */
  async function upsertEntityWithDisambig(
    workspaceId: string,
    e: { name: string; type: string; properties: Record<string, unknown>; sourceUrl?: string },
    sourcePageUrl?: string,
  ): Promise<{ entity: KgEntity; action: 'created' | 'merged' | 'exists' }> {
    // 1. 精确名查重
    const exact = await deps.repository.findEntityByName(workspaceId, e.name)
    if (exact) return { entity: exact, action: 'exists' }

    // 2. 向量消歧：召回相似实体，命中阈值则合并
    if (deps.llm) {
      try {
        const vec = await deps.llm.embed(e.name)
        const hits = await deps.repository.searchSimilarEntities(workspaceId, vec, 3)
        const top = hits.find((h) => h.score >= SIMILARITY_THRESHOLD)
        if (top) {
          const similar = await deps.repository.findEntityById(workspaceId, top.id)
          if (similar) {
            await deps.repository.mergeEntityProperties(similar.id, e.properties)
            // 合并后也更新向量（用更丰富的描述可重新 embed；此处保持简单用 name）
            return { entity: similar, action: 'merged' }
          }
        }
      } catch (err) {
        console.warn(`[kg] 消歧失败 name="${e.name}":`, (err as Error).message)
      }
    }

    // 3. 新建并索引
    const created = await deps.repository.addEntity({
      workspaceId,
      name: e.name,
      type: e.type,
      properties: e.properties,
      sourceUrl: e.sourceUrl ?? sourcePageUrl,
    })
    if (deps.llm) {
      try {
        const vec = await deps.llm.embed(e.name)
        await deps.repository.indexEntity(created, vec)
      } catch (err) {
        console.warn(`[kg] indexEntity 失败 name="${e.name}":`, (err as Error).message)
      }
    }
    return { entity: created, action: 'created' }
  }

  return {
    async addEntity(input) {
      const { entity } = await upsertEntityWithDisambig(input.workspaceId, input)
      return entity
    },
    addRelation: (input) => deps.repository.addRelation(input),
    async removeEntity(id) {
      await deps.repository.removeEntityVector(id)
      await deps.repository.removeEntity(id)
    },
    extractFromPage: (pageId) => deps.extractor.extractFromPage(pageId).then((r) => r.task),

    async persistProposals(workspaceId, proposals) {
      let entitiesCreated = 0
      let entitiesSkipped = 0
      let entitiesMerged = 0

      // 1. 实体去重 / 消歧合并后入库
      for (const e of proposals.entities) {
        try {
          const { action } = await upsertEntityWithDisambig(workspaceId, e, proposals.sourcePageUrl)
          if (action === 'created') entitiesCreated++
          else if (action === 'merged') entitiesMerged++
          else entitiesSkipped++
        } catch {
          entitiesSkipped++
        }
      }

      // 2. 关系（两端实体都已存在才创建）
      let relationsCreated = 0
      let relationsSkipped = 0
      for (const r of proposals.relations) {
        const [from, to] = await Promise.all([
          deps.repository.findEntityByName(workspaceId, r.fromName),
          deps.repository.findEntityByName(workspaceId, r.toName),
        ])
        if (!from || !to) {
          relationsSkipped++
          continue
        }
        try {
          await deps.repository.addRelation({
            workspaceId,
            fromName: r.fromName,
            toName: r.toName,
            relationType: r.relationType,
            properties: r.properties,
          })
          relationsCreated++
        } catch {
          relationsSkipped++
        }
      }

      return { entitiesCreated, entitiesSkipped, entitiesMerged, relationsCreated, relationsSkipped }
    },

    listEntities: (workspaceId, opts) => deps.repository.findEntities(workspaceId, opts),
    listRelations: (workspaceId, opts) => deps.repository.findRelations(workspaceId, opts),
    getEntity: (workspaceId, id) => deps.repository.findEntityById(workspaceId, id),
    async findSimilarEntities(workspaceId, name, topK = 10) {
      if (!deps.llm) throw new Error('LLM provider required for findSimilarEntities')
      const vec = await deps.llm.embed(name)
      return deps.repository.searchSimilarEntities(workspaceId, vec, topK)
    },
    exportGraph: (input) => deps.exporter.export(input),
  }
}
