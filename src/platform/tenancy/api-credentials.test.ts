import { describe, expect, it, vi } from 'vitest'
import { createApiCredentialService } from './api-credentials.js'
import { createHash } from 'node:crypto'

/** 相对真实时钟的过去时间点（节流判定基于 Date.now()，fixture 须相对构造） */
function msAgo(ms: number): Date {
  return new Date(Date.now() - ms)
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function makeCredential(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cred-1',
    workspaceId: 'ws-1',
    name: '默认凭证',
    keyPrefix: 'geo_ab12',
    keyHash: sha256Hex('geo_secret'),
    scopes: ['*'],
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdById: 'user-1',
    createdAt: msAgo(3600_000),
    ...overrides,
  }
}

function makeWorkspace(status = 'ACTIVE') {
  return {
    id: 'ws-1',
    name: '客户工作区',
    status,
    organizationId: 'org-1',
  }
}

function makePrisma(credential: unknown | null, workspace: unknown | null) {
  return {
    apiCredential: {
      findUnique: vi.fn(async () => credential),
      update: vi.fn(),
    },
    workspace: {
      findUnique: vi.fn(async () => (credential ? workspace : null)),
    },
  } as any
}

describe('createApiCredentialService.findByKey', () => {
  it('命中未吊销未过期的 key：返回 credential + 关联 workspace（任意 status）', async () => {
    const prisma = makePrisma(makeCredential(), makeWorkspace('SUSPENDED'))
    const service = createApiCredentialService(prisma)
    const hit = await service.findByKey('geo_secret')
    expect(hit).not.toBeNull()
    expect(prisma.apiCredential.findUnique).toHaveBeenCalledWith({
      where: { keyHash: sha256Hex('geo_secret') },
    })
    expect(hit?.credential.id).toBe('cred-1')
    expect(hit?.workspace.id).toBe('ws-1')
    expect(hit?.workspace.status).toBe('SUSPENDED')
  })

  it('key 不存在：返回 null', async () => {
    const prisma = makePrisma(null, null)
    const service = createApiCredentialService(prisma)
    expect(await service.findByKey('geo_wrong')).toBeNull()
  })

  it('已吊销：返回 null', async () => {
    const prisma = makePrisma(makeCredential({ revokedAt: msAgo(1000) }), makeWorkspace())
    const service = createApiCredentialService(prisma)
    expect(await service.findByKey('geo_secret')).toBeNull()
  })

  it('已过期：返回 null', async () => {
    const prisma = makePrisma(
      makeCredential({ expiresAt: msAgo(1000) }),
      makeWorkspace(),
    )
    const service = createApiCredentialService(prisma)
    expect(await service.findByKey('geo_secret')).toBeNull()
  })

  it('expiresAt 在未来：命中', async () => {
    const prisma = makePrisma(
      makeCredential({ expiresAt: new Date(Date.now() + 60_000) }),
      makeWorkspace(),
    )
    const service = createApiCredentialService(prisma)
    expect((await service.findByKey('geo_secret'))?.credential.id).toBe('cred-1')
  })

  it('lastUsedAt 为 null：写入 lastUsedAt', async () => {
    const update = vi.fn(async (args: any) => makeCredential({ lastUsedAt: args.data.lastUsedAt }))
    const prisma = {
      apiCredential: { findUnique: vi.fn(async () => makeCredential()), update },
      workspace: { findUnique: vi.fn(async () => makeWorkspace()) },
    } as any
    const service = createApiCredentialService(prisma)
    await service.findByKey('geo_secret')
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('lastUsedAt 距今 >60s：节流更新 lastUsedAt', async () => {
    const update = vi.fn(async (args: any) => makeCredential({ lastUsedAt: args.data.lastUsedAt }))
    const prisma = {
      apiCredential: {
        findUnique: vi.fn(async () => makeCredential({ lastUsedAt: msAgo(61_000) })),
        update,
      },
      workspace: { findUnique: vi.fn(async () => makeWorkspace()) },
    } as any
    const service = createApiCredentialService(prisma)
    await service.findByKey('geo_secret')
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('lastUsedAt 距今 ≤60s：跳过更新（节流）', async () => {
    const update = vi.fn()
    const prisma = {
      apiCredential: {
        findUnique: vi.fn(async () => makeCredential({ lastUsedAt: msAgo(30_000) })),
        update,
      },
      workspace: { findUnique: vi.fn(async () => makeWorkspace()) },
    } as any
    const service = createApiCredentialService(prisma)
    const hit = await service.findByKey('geo_secret')
    expect(hit?.credential.id).toBe('cred-1')
    expect(update).not.toHaveBeenCalled()
  })

  it('credential 命中但 workspace 记录缺失：返回 null', async () => {
    const prisma = makePrisma(makeCredential(), null)
    const service = createApiCredentialService(prisma)
    expect(await service.findByKey('geo_secret')).toBeNull()
  })
})

describe('createApiCredentialService.issue', () => {
  function makeIssuePrisma() {
    const create = vi.fn(async ({ data }: any) => ({ id: 'cred-9', ...data, createdAt: new Date() }))
    return { prisma: { apiCredential: { create, findUnique: vi.fn(), update: vi.fn() } } as any, create }
  }

  it('生成 geo_ + 24 字节 hex 明文；库存 sha256(key)、keyPrefix 取前 8 位、scopes ["*"]', async () => {
    const { prisma, create } = makeIssuePrisma()
    const service = createApiCredentialService(prisma)
    const { credential, plaintext } = await service.issue('ws-1', '初始 Key', 'user-op')

    expect(plaintext).toMatch(/^geo_[0-9a-f]{48}$/)
    expect(plaintext.length).toBe(4 + 48)
    expect(create).toHaveBeenCalledWith({
      data: {
        workspaceId: 'ws-1',
        name: '初始 Key',
        keyHash: sha256Hex(plaintext),
        keyPrefix: plaintext.slice(0, 8),
        scopes: ['*'],
        createdById: 'user-op',
      },
    })
    expect(credential.id).toBe('cred-9')
  })

  it('两次签发产生不同明文（随机性）', async () => {
    const { prisma } = makeIssuePrisma()
    const service = createApiCredentialService(prisma)
    const a = await service.issue('ws-1', 'k1', 'user-op')
    const b = await service.issue('ws-1', 'k2', 'user-op')
    expect(a.plaintext).not.toBe(b.plaintext)
    expect(a.plaintext.slice(0, 4)).toBe('geo_')
    expect(b.plaintext.slice(0, 4)).toBe('geo_')
  })

  it('签发的明文可被 findByKey 通道按哈希命中（回环）', async () => {
    const issued = { credential: null as any, plaintext: '' }
    const prisma = {
      apiCredential: {
        create: vi.fn(async ({ data }: any) => {
          issued.credential = { ...makeCredential(), ...data }
          return issued.credential
        }),
        findUnique: vi.fn(async ({ where }: any) =>
          where.keyHash === sha256Hex(issued.plaintext) ? issued.credential : null,
        ),
        update: vi.fn(),
      },
      workspace: { findUnique: vi.fn(async () => makeWorkspace()) },
    } as any
    const service = createApiCredentialService(prisma)
    const { plaintext } = await service.issue('ws-1', '初始 Key', 'user-op')
    issued.plaintext = plaintext
    const hit = await service.findByKey(plaintext)
    expect(hit?.credential.keyHash).toBe(sha256Hex(plaintext))
    expect(hit?.workspace.id).toBe('ws-1')
  })
})

describe('createApiCredentialService.list', () => {
  it('按 workspaceId 查询并仅返回脱敏字段（不含 keyHash），按 createdAt 倒序', async () => {
    const findMany = vi.fn(async () => [])
    const prisma = { apiCredential: { findMany, findUnique: vi.fn(), update: vi.fn() } } as any
    const service = createApiCredentialService(prisma)
    await service.list('ws-1')
    expect(findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        lastUsedAt: true,
        scopes: true,
        revokedAt: true,
      },
    })
  })
})

describe('createApiCredentialService.revoke', () => {
  function makeRevokePrisma(count: number) {
    const updateMany = vi.fn(async () => ({ count }))
    return {
      prisma: { apiCredential: { updateMany, findUnique: vi.fn(), update: vi.fn() } } as any,
      updateMany,
    }
  }

  it('正常吊销：updateMany({ where: { id, revokedAt: null }, data: { revokedAt: now } })，返回命中行数', async () => {
    const { prisma, updateMany } = makeRevokePrisma(1)
    const service = createApiCredentialService(prisma)
    const before = Date.now()
    const count = await service.revoke('cred-1', 'user-op')
    const after = Date.now()

    expect(count).toBe(1)
    expect(updateMany).toHaveBeenCalledTimes(1)
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'cred-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    })
    const revokedAt = updateMany.mock.calls[0][0].data.revokedAt as Date
    expect(revokedAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(revokedAt.getTime()).toBeLessThanOrEqual(after)
  })

  it('不存在或已吊销（updateMany 命中 0 行）：抛 API_CREDENTIAL_NOT_REVOKABLE 命名错误', async () => {
    const { prisma } = makeRevokePrisma(0)
    const service = createApiCredentialService(prisma)
    await expect(service.revoke('cred-x', 'user-op')).rejects.toMatchObject({
      name: 'API_CREDENTIAL_NOT_REVOKABLE',
      message: expect.stringContaining('cred-x'),
    })
  })

  it('重复 revoke：第一次命中 1 行成功，第二次命中 0 行 → 抛错（不静默成功）', async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
    const prisma = { apiCredential: { updateMany } } as any
    const service = createApiCredentialService(prisma)

    await expect(service.revoke('cred-1', 'user-op')).resolves.toBe(1)
    await expect(service.revoke('cred-1', 'user-op')).rejects.toMatchObject({
      name: 'API_CREDENTIAL_NOT_REVOKABLE',
    })
    expect(updateMany).toHaveBeenCalledTimes(2)
  })

  it('闭环：issue → revoke 后，同一明文 findByKey 返回 null（revokedAt 非空即拒）', async () => {
    const base = makeCredential()
    let stored: Record<string, unknown> | null = null
    const prisma = {
      apiCredential: {
        create: vi.fn(async ({ data }: any) => {
          stored = { ...base, ...data }
          return stored
        }),
        updateMany: vi.fn(async () => {
          stored = { ...stored, revokedAt: new Date() }
          return { count: 1 }
        }),
        findUnique: vi.fn(async ({ where }: any) =>
          where.keyHash === (stored as any)?.keyHash ? stored : null,
        ),
        update: vi.fn(),
      },
      workspace: { findUnique: vi.fn(async () => makeWorkspace()) },
    } as any
    const service = createApiCredentialService(prisma)

    const { plaintext } = await service.issue('ws-1', '初始 Key', 'user-op')
    expect(await service.findByKey(plaintext)).not.toBeNull()

    await expect(service.revoke(base.id, 'user-op')).resolves.toBe(1)
    expect(await service.findByKey(plaintext)).toBeNull()
  })
})
