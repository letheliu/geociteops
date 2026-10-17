import { describe, it, expect, vi } from 'vitest'
import { createKgRepository, DuplicateEntityError, EntityNotFoundError } from './repository.js'
import type { PrismaClient } from '@prisma/client'

function mockPrisma() {
  const entities = new Map<string, any>([
    ['w1::zoomer AI', { id: 'e1', workspaceId: 'w1', name: 'zoomer AI', type: 'SoftwareApplication', properties: {} }],
    ['w2::zoomer AI', { id: 'e2', workspaceId: 'w2', name: 'zoomer AI', type: 'SoftwareApplication', properties: {} }],
  ])
  return {
    kgEntity: {
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
        if (where.workspaceId_name) {
          const key = `${where.workspaceId_name.workspaceId}::${where.workspaceId_name.name}`
          return entities.get(key) ?? null
        }
        if (where.id) {
          return Array.from(entities.values()).find((e) => e.id === where.id) ?? null
        }
        return null
      }),
      findFirst: vi.fn().mockImplementation(async ({ where }: any) => {
        if (where.id && where.workspaceId) {
          return Array.from(entities.values()).find((e) => e.id === where.id && e.workspaceId === where.workspaceId) ?? null
        }
        if (where.name) {
          return Array.from(entities.values()).find((e) => e.name === where.name) ?? null
        }
        return null
      }),
      findMany: vi.fn().mockResolvedValue(Array.from(entities.values())),
      create: vi.fn().mockImplementation(async ({ data }: any) => {
        const id = `e-${Math.random()}`
        const entity = { id, ...data }
        entities.set(`${data.workspaceId}::${data.name}`, entity)
        return entity
      }),
      delete: vi.fn().mockResolvedValue({}),
    },
    kgRelation: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ id: 'r1', ...data })),
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaClient
}

describe('KgRepository', () => {
  it('addEntity 插入新实体', async () => {
    const repo = createKgRepository(mockPrisma())
    const entity = await repo.addEntity({
      workspaceId: 'w1', name: 'NewEntity', type: 'Product', properties: {},
    })
    expect(entity.id).toBeDefined()
    expect(entity.name).toBe('NewEntity')
  })

  it('addEntity 重复 name 时抛 DuplicateEntityError', async () => {
    const repo = createKgRepository(mockPrisma())
    await expect(
      repo.addEntity({ workspaceId: 'w1', name: 'zoomer AI', type: 'X', properties: {} }),
    ).rejects.toThrow(DuplicateEntityError)
  })

  it('findEntityByName 返回已知实体', async () => {
    const repo = createKgRepository(mockPrisma())
    const entity = await repo.findEntityByName('w1', 'zoomer AI')
    expect(entity?.id).toBe('e1')
  })

  it('findEntityByName 对未知实体返回 null', async () => {
    const repo = createKgRepository(mockPrisma())
    expect(await repo.findEntityByName('w1', 'unknown')).toBeNull()
  })

  it('findEntities 按 workspace 查询', async () => {
    const repo = createKgRepository(mockPrisma())
    const list = await repo.findEntities('w1')
    expect(list.length).toBeGreaterThanOrEqual(1)
  })

  it('addRelation 在两端实体都存在时成功', async () => {
    const prisma = mockPrisma()
    const repo = createKgRepository(prisma)
    await repo.addEntity({ workspaceId: 'w1', name: 'A', type: 'X', properties: {} })
    await repo.addEntity({ workspaceId: 'w1', name: 'B', type: 'X', properties: {} })
    const rel = await repo.addRelation({ workspaceId: 'w1', fromName: 'A', toName: 'B', relationType: 'competitor' })
    expect(rel.id).toBeDefined()
  })

  it('addRelation 任一端实体不存在时抛 EntityNotFoundError', async () => {
    const repo = createKgRepository(mockPrisma())
    await expect(
      repo.addRelation({ workspaceId: 'w1', fromName: 'missing', toName: 'B', relationType: 'competitor' }),
    ).rejects.toThrow(EntityNotFoundError)
  })

  it('addRelation 不会跨 workspace 串到同名实体', async () => {
    const repo = createKgRepository(mockPrisma())
    // w1 中没有 zoomer AI 之外的实体，但 w2 有
    await expect(
      repo.addRelation({ workspaceId: 'w2', fromName: 'zoomer AI', toName: 'missingInW2', relationType: 'competitor' }),
    ).rejects.toThrow(EntityNotFoundError)
  })

  it('findEntityById 限定 workspaceId', async () => {
    const repo = createKgRepository(mockPrisma())
    // w2 中的 e2 在 w1 中查不到
    expect(await repo.findEntityById('w1', 'e2')).toBeNull()
    // 同样 id 但 w1 中也没有
    expect(await repo.findEntityById('w1', 'e1')).not.toBeNull()
  })

  it('removeEntity 调用 prisma.delete', async () => {
    const prisma = mockPrisma()
    const repo = createKgRepository(prisma)
    await repo.removeEntity('e1')
    expect((prisma.kgEntity as any).delete).toHaveBeenCalledWith({ where: { id: 'e1' } })
  })
})