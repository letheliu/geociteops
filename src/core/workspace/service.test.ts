import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createWorkspaceService, API_KEY_CHANNEL_ERROR } from './service.js'

// 任务 4 起 Workspace.apiKeyHash 列已下线：
// create/findByApiKey 为抛错占位（由任务 9/11 基于 ApiCredential 重写），
// 此处仅验证占位行为与仍然真实的 getById/updatePlatformConfig。

function mockPrisma(overrides: Record<string, any> = {}) {
  return {
    workspace: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    ...overrides,
  } as any
}

describe('workspace service', () => {
  let prisma: ReturnType<typeof mockPrisma>
  beforeEach(() => {
    prisma = mockPrisma()
  })

  it('create 抛错占位（任务 9/11 重写：Organization + ApiCredential 签发）', async () => {
    const svc = createWorkspaceService(prisma)
    await expect(
      svc.create({ name: 'zoomer', defaultBrandName: 'zoomer AI' }),
    ).rejects.toThrow(API_KEY_CHANNEL_ERROR)
    expect(prisma.workspace.create).not.toHaveBeenCalled()
  })

  it('findByApiKey 抛错占位（任务 9/11 重写：ApiCredential.keyHash 查询）', async () => {
    const svc = createWorkspaceService(prisma)
    await expect(svc.findByApiKey('geo_xxx')).rejects.toThrow(API_KEY_CHANNEL_ERROR)
    expect(prisma.workspace.findFirst).not.toHaveBeenCalled()
  })

  it('getById 按 id 查找', async () => {
    prisma.workspace.findUnique.mockResolvedValue({ id: 'ws-1', name: 'zoomer' })
    const svc = createWorkspaceService(prisma)
    const found = await svc.getById('ws-1')
    expect(found?.id).toBe('ws-1')
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({ where: { id: 'ws-1' } })
  })

  it('updatePlatformConfig 更新配置', async () => {
    prisma.workspace.update.mockResolvedValue({ id: 'ws-1', platformConfig: { a: 1 } })
    const svc = createWorkspaceService(prisma)
    const updated = await svc.updatePlatformConfig('ws-1', { a: 1 })
    expect(updated.id).toBe('ws-1')
    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 'ws-1' },
      data: { platformConfig: { a: 1 } },
    })
  })
})
