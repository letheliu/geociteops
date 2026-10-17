import { describe, it, expect, vi } from 'vitest'
import {
  encryptConfig,
  decryptConfig,
  isEncryptedConfig,
} from '../src/core/crypto/envelope.js'

describe('backfillOrganizations', () => {
  it('为无 org 的 workspace 建同名 Organization 并回填，已有 org 的跳过', async () => {
    const prisma: any = {
      workspace: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'w1', name: 'A 公司', organizationId: null },
          { id: 'w2', name: 'B 公司', organizationId: 'org-1' },
        ]),
        update: vi.fn(),
      },
      organization: { create: vi.fn().mockResolvedValue({ id: 'org-2' }) },
    }
    const { backfillOrganizations } = await import('../scripts/migrate-tob-p0.js')
    const created = await backfillOrganizations(prisma)
    expect(created).toBe(1)
    expect(prisma.organization.create).toHaveBeenCalledTimes(1)
    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 'w1' },
      data: { organizationId: 'org-2' },
    })
  })
})

describe('migrateApiKeys', () => {
  it('把 Workspace.apiKeyHash 平移到 ApiCredential，重复执行不重复插入', async () => {
    const prisma: any = {
      // 任务 4 前：apiKeyHash 列仍存在（information_schema 检查通过）
      $queryRawUnsafe: vi.fn().mockResolvedValue([{ column_name: 'apiKeyHash' }]),
      workspace: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'w1', apiKeyHash: 'hash-1' },
          { id: 'w2', apiKeyHash: 'hash-2' },
        ]),
      },
      apiCredential: {
        // 第一遍两个 workspace 均无 credential；第二遍均已存在（幂等）
        findFirst: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValue({ id: 'cred-existing' }),
        create: vi.fn(),
      },
    }
    const { migrateApiKeys } = await import('../scripts/migrate-tob-p0.js')
    const created = await migrateApiKeys(prisma)
    expect(created).toBe(2)
    expect(prisma.apiCredential.create).toHaveBeenCalledTimes(2)
    expect(prisma.apiCredential.create).toHaveBeenCalledWith({
      data: {
        workspaceId: 'w1',
        name: '迁移的默认 Key',
        keyPrefix: null,
        keyHash: 'hash-1',
        scopes: ['*'],
        createdById: expect.any(String),
      },
    })
    expect(prisma.apiCredential.create).toHaveBeenCalledWith({
      data: {
        workspaceId: 'w2',
        name: '迁移的默认 Key',
        keyPrefix: null,
        keyHash: 'hash-2',
        scopes: ['*'],
        createdById: expect.any(String),
      },
    })

    // 幂等：credential 已存在的 workspace 第二遍不再插入
    const again = await migrateApiKeys(prisma)
    expect(again).toBe(0)
    expect(prisma.apiCredential.create).toHaveBeenCalledTimes(2)
  })

  it('任务 4 删除 apiKeyHash 列后：列不存在则直接返回 0，不查询 workspace', async () => {
    const prisma: any = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]), // information_schema 中无该列
      workspace: { findMany: vi.fn() },
      apiCredential: { findFirst: vi.fn(), create: vi.fn() },
    }
    const { migrateApiKeys } = await import('../scripts/migrate-tob-p0.js')
    const created = await migrateApiKeys(prisma)
    expect(created).toBe(0)
    expect(prisma.workspace.findMany).not.toHaveBeenCalled()
    expect(prisma.apiCredential.create).not.toHaveBeenCalled()
  })
})

describe('encryptExistingConfigs', () => {
  it('仅加密非信封格式的 platformConfig，已是信封的跳过', async () => {
    const keyHex = '11'.repeat(32)
    const plain = JSON.stringify({ apiKey: 'sk-plain' })
    const sealed = encryptConfig(JSON.stringify({ apiKey: 'sk-sealed' }), keyHex)
    const prisma: any = {
      workspace: {
        // 第一遍一条明文一条信封；第二遍（模拟第一遍落库后）全部是信封
        findMany: vi.fn()
          .mockResolvedValueOnce([
            { id: 'w1', platformConfig: plain },
            { id: 'w2', platformConfig: sealed },
          ])
          .mockResolvedValue([
            { id: 'w1', platformConfig: sealed },
            { id: 'w2', platformConfig: sealed },
          ]),
        update: vi.fn(),
      },
    }
    const { encryptExistingConfigs } = await import('../scripts/migrate-tob-p0.js')
    const encrypted = await encryptExistingConfigs(prisma, keyHex)
    expect(encrypted).toBe(1)
    expect(prisma.workspace.update).toHaveBeenCalledTimes(1)
    const [args] = prisma.workspace.update.mock.calls[0]
    expect(args.where).toEqual({ id: 'w1' })
    expect(isEncryptedConfig(args.data.platformConfig)).toBe(true)
    // 加密后可解密回原文（真实行为，非 mock 自证）
    expect(decryptConfig(args.data.platformConfig, keyHex)).toBe(plain)

    // 幂等：全部已是信封后不再 update
    const again = await encryptExistingConfigs(prisma, keyHex)
    expect(again).toBe(0)
    expect(prisma.workspace.update).toHaveBeenCalledTimes(1)
  })
})
