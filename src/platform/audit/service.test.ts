import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAuditService } from './service.js'

function mockPrisma(overrides: Record<string, any> = {}) {
  return {
    auditLog: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    ...overrides,
  } as any
}

describe('audit service', () => {
  let prisma: ReturnType<typeof mockPrisma>
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    prisma = mockPrisma()
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  describe('record', () => {
    it('透传全部字段调用 prisma.auditLog.create', async () => {
      prisma.auditLog.create.mockResolvedValue({})
      const svc = createAuditService(prisma)

      await svc.record({
        actorId: 'user-1',
        actorType: 'USER',
        action: 'workspace.update',
        organizationId: 'org-1',
        workspaceId: 'ws-1',
        target: 'Workspace:ws-1',
        diff: { before: { a: 1 }, after: { a: 2 } },
        ip: '127.0.0.1',
      })

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          actorId: 'user-1',
          actorType: 'USER',
          action: 'workspace.update',
          organizationId: 'org-1',
          workspaceId: 'ws-1',
          target: 'Workspace:ws-1',
          diff: { before: { a: 1 }, after: { a: 2 } },
          ip: '127.0.0.1',
        },
      })
    })

    it('可选字段缺省时不写入 undefined 键', async () => {
      prisma.auditLog.create.mockResolvedValue({})
      const svc = createAuditService(prisma)

      await svc.record({ actorType: 'SYSTEM', action: 'cron.tick' })

      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1)
      const arg = prisma.auditLog.create.mock.calls[0][0]
      expect(Object.keys(arg.data).sort()).toEqual(['action', 'actorType'])
    })

    it('create 抛错时吞掉异常并 console.error（审计不阻断业务）', async () => {
      prisma.auditLog.create.mockRejectedValue(new Error('db down'))
      const svc = createAuditService(prisma)

      await expect(
        svc.record({ actorType: 'USER', action: 'workspace.update' }),
      ).resolves.toBeUndefined()
      expect(consoleError).toHaveBeenCalledTimes(1)
    })
  })

  describe('list', () => {
    const log = { id: 'log-1', action: 'workspace.update' }

    function mockListResult() {
      prisma.auditLog.findMany.mockResolvedValue([log])
      prisma.auditLog.count.mockResolvedValue(1)
    }

    it('仅有值的过滤字段进入 where', async () => {
      mockListResult()
      const svc = createAuditService(prisma)

      await svc.list({
        action: 'workspace.update',
        workspaceId: 'ws-1',
        actorId: 'user-1',
        page: 2,
        pageSize: 10,
      })

      const arg = prisma.auditLog.findMany.mock.calls[0][0]
      expect(Object.keys(arg.where).sort()).toEqual(['action', 'actorId', 'workspaceId'])
      expect(arg.where).toStrictEqual({
        action: 'workspace.update',
        actorId: 'user-1',
        workspaceId: 'ws-1',
      })
      expect(arg.orderBy).toEqual({ createdAt: 'desc' })
      expect(arg.skip).toBe(10)
      expect(arg.take).toBe(10)
      expect(prisma.auditLog.count).toHaveBeenCalledWith({
        where: {
          action: 'workspace.update',
          actorId: 'user-1',
          workspaceId: 'ws-1',
        },
      })
    })

    it('过滤字段全部缺省时 where 为空对象', async () => {
      mockListResult()
      const svc = createAuditService(prisma)

      await svc.list({})

      const arg = prisma.auditLog.findMany.mock.calls[0][0]
      expect(arg.where).toStrictEqual({})
      expect(prisma.auditLog.count).toHaveBeenCalledWith({ where: {} })
    })

    it('分页默认 page=1 / pageSize=20（skip 0 / take 20）', async () => {
      mockListResult()
      const svc = createAuditService(prisma)

      await svc.list({})

      const arg = prisma.auditLog.findMany.mock.calls[0][0]
      expect(arg.skip).toBe(0)
      expect(arg.take).toBe(20)
    })

    it('pageSize 超过上限时截断为 100', async () => {
      mockListResult()
      const svc = createAuditService(prisma)

      await svc.list({ page: 3, pageSize: 500 })

      const arg = prisma.auditLog.findMany.mock.calls[0][0]
      expect(arg.skip).toBe(200)
      expect(arg.take).toBe(100)
    })

    it('返回 findMany 结果与 count 作为 { items, total }', async () => {
      mockListResult()
      const svc = createAuditService(prisma)

      const result = await svc.list({ action: 'workspace.update' })

      expect(result).toEqual({ items: [log], total: 1 })
    })
  })
})
