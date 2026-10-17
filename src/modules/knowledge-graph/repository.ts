import type { PrismaClient, KgEntity, KgRelation } from '@prisma/client'
import type { VectorStore, SearchHit } from '../../core/vector/store.js'

export class DuplicateEntityError extends Error {
  constructor(public workspaceId: string, public name: string) {
    super(`KgEntity already exists: workspaceId="${workspaceId}" name="${name}"`)
    this.name = 'DuplicateEntityError'
  }
}

export class EntityNotFoundError extends Error {
  constructor(public workspaceId: string, public name: string) {
    super(`KgEntity not found: workspaceId="${workspaceId}" name="${name}"`)
    this.name = 'EntityNotFoundError'
  }
}

export interface KgRepositoryService {
  findEntityByName(workspaceId: string, name: string): Promise<KgEntity | null>
  findEntityById(workspaceId: string, id: string): Promise<KgEntity | null>
  findEntities(workspaceId: string, opts?: { type?: string }): Promise<KgEntity[]>
  addEntity(input: {
    workspaceId: string
    name: string
    type: string
    properties: Record<string, unknown>
    sourceUrl?: string
  }): Promise<KgEntity>
  /** 更新实体属性（消歧合并用，合并入参 properties 到已有值）。 */
  mergeEntityProperties(id: string, properties: Record<string, unknown>): Promise<KgEntity>
  removeEntity(id: string): Promise<void>

  /** 向量库：写入实体向量（按 entity.id）。容错，失败不抛。 */
  indexEntity(entity: KgEntity, vector: number[]): Promise<void>
  /** 向量库：按相似度召回实体 ID（caller 负责提供 query 向量）。 */
  searchSimilarEntities(workspaceId: string, vector: number[], topK: number): Promise<SearchHit[]>
  /** 向量库：删除实体向量。容错。 */
  removeEntityVector(id: string): Promise<void>

  findRelations(workspaceId: string, opts?: { fromId?: string; toId?: string }): Promise<KgRelation[]>
  addRelation(input: {
    workspaceId: string
    fromName: string
    toName: string
    relationType: string
    properties?: Record<string, unknown>
  }): Promise<KgRelation>
}

export function createKgRepository(prisma: PrismaClient, vector?: VectorStore): KgRepositoryService {
  return {
    async findEntityByName(workspaceId, name) {
      return prisma.kgEntity.findUnique({
        where: { workspaceId_name: { workspaceId, name } },
      })
    },

    async findEntityById(workspaceId, id) {
      return prisma.kgEntity.findFirst({ where: { id, workspaceId } })
    },

    async findEntities(workspaceId, opts) {
      const where: any = { workspaceId }
      if (opts?.type) where.type = opts.type
      return prisma.kgEntity.findMany({ where })
    },

    async addEntity(input) {
      const existing = await prisma.kgEntity.findUnique({
        where: { workspaceId_name: { workspaceId: input.workspaceId, name: input.name } },
      })
      if (existing) throw new DuplicateEntityError(input.workspaceId, input.name)
      return prisma.kgEntity.create({
        data: {
          workspaceId: input.workspaceId,
          name: input.name,
          type: input.type,
          properties: input.properties as any,
          sourceUrl: input.sourceUrl,
        },
      })
    },

    async mergeEntityProperties(id, properties) {
      const existing = await prisma.kgEntity.findUnique({ where: { id } })
      const merged = { ...((existing?.properties as Record<string, unknown>) ?? {}), ...properties }
      return prisma.kgEntity.update({ where: { id }, data: { properties: merged as any } })
    },

    async removeEntity(id) {
      await prisma.kgEntity.delete({ where: { id } })
    },

    async indexEntity(entity, v) {
      if (!vector) return
      try {
        await vector.upsert(vector.COLLECTIONS.entities, [
          {
            id: entity.id,
            vector: v,
            metadata: {
              workspaceId: entity.workspaceId,
              sourceType: entity.type,
              name: entity.name,
            },
          },
        ])
      } catch (e) {
        console.warn(`[kg-repo] indexEntity 失败 entityId=${entity.id}:`, (e as Error).message)
      }
    },

    async searchSimilarEntities(workspaceId, v, topK) {
      if (!vector) return []
      return vector.search(vector.COLLECTIONS.entities, v, topK, { workspaceId })
    },

    async removeEntityVector(id) {
      if (!vector) return
      try {
        await vector.delete(vector.COLLECTIONS.entities, [id])
      } catch (e) {
        console.warn(`[kg-repo] removeEntityVector 失败 entityId=${id}:`, (e as Error).message)
      }
    },

    async findRelations(workspaceId, opts) {
      const where: any = {
        fromEntity: { workspaceId },
        toEntity: { workspaceId },
      }
      if (opts?.fromId) where.fromEntityId = opts.fromId
      if (opts?.toId) where.toEntityId = opts.toId
      return prisma.kgRelation.findMany({ where })
    },

    async addRelation(input) {
      // 解析两端实体（限定在同一 workspace）
      const [from, to] = await Promise.all([
        prisma.kgEntity.findUnique({
          where: { workspaceId_name: { workspaceId: input.workspaceId, name: input.fromName } },
        }),
        prisma.kgEntity.findUnique({
          where: { workspaceId_name: { workspaceId: input.workspaceId, name: input.toName } },
        }),
      ])
      if (!from) throw new EntityNotFoundError(input.workspaceId, input.fromName)
      if (!to) throw new EntityNotFoundError(input.workspaceId, input.toName)

      return prisma.kgRelation.create({
        data: {
          fromEntityId: from.id,
          toEntityId: to.id,
          relationType: input.relationType,
          properties: (input.properties as any) ?? {},
        },
      })
    },
  }
}