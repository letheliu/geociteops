import { describe, expect, it, vi, afterEach } from 'vitest'
import type { Session, User, Workspace, ApiCredential } from '@prisma/client'
import { createContextWithServices } from './context.js'

const NOW = new Date('2026-10-13T08:00:00.000Z')

function makeUser(overrides: Record<string, unknown> = {}): User {
  return {
    id: 'user-1',
    username: 'alice',
    displayName: 'Alice',
    email: null,
    phone: null,
    passwordHash: 'x',
    userType: 'PLATFORM',
    platformRole: 'SUPER_ADMIN',
    organizationId: null,
    orgRole: null,
    status: 'ACTIVE',
    mustChangePassword: false,
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as unknown as User
}

function makeSession(): Session {
  return {
    id: 'sess-1',
    userId: 'user-1',
    tokenHash: 'hash',
    ip: null,
    userAgent: null,
    lastSeenAt: NOW,
    expiresAt: new Date(NOW.getTime() + 3600_000),
    revokedAt: null,
    createdAt: NOW,
  } as unknown as Session
}

function makeWorkspace(id = 'ws-1', status = 'ACTIVE', organizationId = 'org-1'): Workspace {
  return {
    id,
    name: '客户工作区',
    domain: null,
    llmsTxtUrl: null,
    defaultBrandName: 'brand',
    platformConfig: {},
    publicationConfig: {},
    status,
    organizationId,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as Workspace
}

function makeCredential(): ApiCredential {
  return {
    id: 'cred-1',
    workspaceId: 'ws-1',
    name: '默认凭证',
    keyPrefix: 'geo_ab12',
    keyHash: 'hash',
    scopes: ['*'],
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdById: 'user-1',
    createdAt: NOW,
  } as unknown as ApiCredential
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const resolved = { session: makeSession(), user: makeUser() }
  const deps = {
    prisma: {} as any,
    sessions: {
      resolve: vi.fn(async () => resolved),
    },
    workspaceService: {
      getById: vi.fn(async () => makeWorkspace()),
    },
    apiCredentials: {
      findByKey: vi.fn(async () => ({ credential: makeCredential(), workspace: makeWorkspace() })),
    },
    members: {
      resolveAccess: vi.fn(async () => 'OPERATE' as const),
      hasAssignment: vi.fn(async () => true),
      listByUser: vi.fn(async () => []),
    },
    ...overrides,
  }
  return { deps, resolved }
}

function makeOpts(headers: Record<string, string | string[] | undefined> = {}, extra: Record<string, unknown> = {}) {
  return {
    req: {
      headers,
      socket: { remoteAddress: '10.0.0.1' },
      method: 'GET',
      id: 'req-42',
      ...extra,
    },
    res: { setHeader: vi.fn() },
  } as any
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('createContextWithServices：双通道解析', () => {
  it('Cookie 有效会话 → actor = user（含 user/session），sessionToken 缓存', async () => {
    const { deps } = makeDeps()
    const ctx = await createContextWithServices(
      makeOpts({ cookie: '__Host-geo_sid=tok123' }),
      deps as any,
    )
    expect(deps.sessions.resolve).toHaveBeenCalledWith('tok123')
    expect(ctx.actor.kind).toBe('user')
    if (ctx.actor.kind === 'user') {
      expect(ctx.actor.user.id).toBe('user-1')
      expect(ctx.actor.session.id).toBe('sess-1')
    }
    expect(ctx.sessionToken).toBe('tok123')
  })

  it('GEO_COOKIE_NAME 环境变量覆盖 Cookie 名', async () => {
    vi.stubEnv('GEO_COOKIE_NAME', 'geo_sid_dev')
    const { deps } = makeDeps()
    const ctx = await createContextWithServices(
      makeOpts({ cookie: 'geo_sid_dev=tokXYZ; other=1' }),
      deps as any,
    )
    expect(deps.sessions.resolve).toHaveBeenCalledWith('tokXYZ')
    expect(ctx.actor.kind).toBe('user')
  })

  it('x-api-key 命中 → actor = apiKey + workspace 绑定', async () => {
    const { deps } = makeDeps()
    const ctx = await createContextWithServices(makeOpts({ 'x-api-key': 'geo_secret' }), deps as any)
    expect(deps.apiCredentials.findByKey).toHaveBeenCalledWith('geo_secret')
    expect(ctx.actor.kind).toBe('apiKey')
    if (ctx.actor.kind === 'apiKey') {
      expect(ctx.actor.credential.id).toBe('cred-1')
    }
    expect(ctx.workspace?.id).toBe('ws-1')
    expect(ctx.sessionToken).toBeUndefined()
  })

  it('Cookie 与 x-api-key 同时存在且会话有效 → 会话通道优先', async () => {
    const { deps } = makeDeps()
    const ctx = await createContextWithServices(
      makeOpts({ cookie: '__Host-geo_sid=tok123', 'x-api-key': 'geo_secret' }),
      deps as any,
    )
    expect(ctx.actor.kind).toBe('user')
    expect(deps.apiCredentials.findByKey).not.toHaveBeenCalled()
  })

  it('Cookie 无效（会话解析失败）→ 回退 x-api-key 通道', async () => {
    const { deps } = makeDeps({ sessions: { resolve: vi.fn(async () => null) } })
    const ctx = await createContextWithServices(
      makeOpts({ cookie: '__Host-geo_sid=bad', 'x-api-key': 'geo_secret' }),
      deps as any,
    )
    expect(ctx.actor.kind).toBe('apiKey')
    expect(ctx.workspace?.id).toBe('ws-1')
  })

  it('双无 → anonymous，authDiag = missing_header', async () => {
    const { deps } = makeDeps()
    const ctx = await createContextWithServices(makeOpts(), deps as any)
    expect(ctx.actor.kind).toBe('anonymous')
    expect(ctx.authDiag).toBe('missing_header')
    expect(ctx.workspace).toBeUndefined()
  })

  it('x-api-key 未命中 → anonymous，authDiag = key_not_found', async () => {
    const { deps } = makeDeps({
      apiCredentials: { findByKey: vi.fn(async () => null) },
    })
    const ctx = await createContextWithServices(makeOpts({ 'x-api-key': 'geo_wrong' }), deps as any)
    expect(ctx.actor.kind).toBe('anonymous')
    expect(ctx.authDiag).toBe('key_not_found')
  })
})

describe('createContextWithServices：user + x-workspace-id（P1 授权分治矩阵）', () => {
  // 行 1：SUPER_ADMIN —— workspace = getById（平台全量语义不变）
  it('SUPER_ADMIN + x-workspace-id → workspace = getById 结果（无需分配记录）', async () => {
    const { deps } = makeDeps({ members: { resolveAccess: vi.fn(), hasAssignment: vi.fn(async () => false) } })
    const ctx = await createContextWithServices(
      makeOpts({ cookie: '__Host-geo_sid=tok123', 'x-workspace-id': 'ws-9' }),
      deps as any,
    )
    expect(deps.workspaceService.getById).toHaveBeenCalledWith('ws-9')
    expect(ctx.workspace?.id).toBe('ws-1')
    expect(deps.members.hasAssignment).not.toHaveBeenCalled()
  })

  it('SUPER_ADMIN + 不存在的 workspace id → workspace 留空（procedure 报 UNAUTHORIZED）', async () => {
    const { deps } = makeDeps({ workspaceService: { getById: vi.fn(async () => null) } })
    const ctx = await createContextWithServices(
      makeOpts({ cookie: '__Host-geo_sid=tok123', 'x-workspace-id': 'ws-404' }),
      deps as any,
    )
    expect(ctx.actor.kind).toBe('user')
    expect(ctx.workspace).toBeUndefined()
  })

  // 行 2：OPERATOR —— getById 且存在分配记录（hasAssignment）
  it('OPERATOR + 有分配记录 → workspace 通过', async () => {
    const resolved = { session: makeSession(), user: makeUser({ platformRole: 'OPERATOR' }) }
    const deps = {
      prisma: {} as any,
      sessions: { resolve: vi.fn(async () => resolved) },
      workspaceService: { getById: vi.fn(async () => makeWorkspace()) },
      apiCredentials: { findByKey: vi.fn(async () => null) },
      members: { resolveAccess: vi.fn(), hasAssignment: vi.fn(async () => true) },
    }
    const ctx = await createContextWithServices(
      makeOpts({ cookie: '__Host-geo_sid=tok123', 'x-workspace-id': 'ws-1' }),
      deps as any,
    )
    expect(deps.workspaceService.getById).toHaveBeenCalledWith('ws-1')
    expect(deps.members.hasAssignment).toHaveBeenCalledWith('user-1', 'ws-1')
    expect(ctx.workspace?.id).toBe('ws-1')
  })

  it('OPERATOR + 无分配记录 → workspace 留空', async () => {
    const resolved = { session: makeSession(), user: makeUser({ platformRole: 'OPERATOR' }) }
    const deps = {
      prisma: {} as any,
      sessions: { resolve: vi.fn(async () => resolved) },
      workspaceService: { getById: vi.fn(async () => makeWorkspace()) },
      apiCredentials: { findByKey: vi.fn(async () => null) },
      members: { resolveAccess: vi.fn(), hasAssignment: vi.fn(async () => false) },
    }
    const ctx = await createContextWithServices(
      makeOpts({ cookie: '__Host-geo_sid=tok123', 'x-workspace-id': 'ws-1' }),
      deps as any,
    )
    expect(deps.members.hasAssignment).toHaveBeenCalledWith('user-1', 'ws-1')
    expect(ctx.workspace).toBeUndefined()
  })

  // 行 3：FINANCE / SUPPORT —— 不使用 GEO 功能，workspace 留空
  it('FINANCE + x-workspace-id → workspace 留空且不查 getById/成员', async () => {
    const resolved = { session: makeSession(), user: makeUser({ platformRole: 'FINANCE' }) }
    const deps = {
      prisma: {} as any,
      sessions: { resolve: vi.fn(async () => resolved) },
      workspaceService: { getById: vi.fn(async () => makeWorkspace()) },
      apiCredentials: { findByKey: vi.fn(async () => null) },
      members: { resolveAccess: vi.fn(), hasAssignment: vi.fn(async () => true) },
    }
    const ctx = await createContextWithServices(
      makeOpts({ cookie: '__Host-geo_sid=tok123', 'x-workspace-id': 'ws-1' }),
      deps as any,
    )
    expect(deps.workspaceService.getById).not.toHaveBeenCalled()
    expect(deps.members.hasAssignment).not.toHaveBeenCalled()
    expect(ctx.workspace).toBeUndefined()
  })

  it('SUPPORT + x-workspace-id → 同 FINANCE 留空', async () => {
    const resolved = { session: makeSession(), user: makeUser({ platformRole: 'SUPPORT' }) }
    const deps = {
      prisma: {} as any,
      sessions: { resolve: vi.fn(async () => resolved) },
      workspaceService: { getById: vi.fn(async () => makeWorkspace()) },
      apiCredentials: { findByKey: vi.fn(async () => null) },
      members: { resolveAccess: vi.fn(), hasAssignment: vi.fn(async () => true) },
    }
    const ctx = await createContextWithServices(
      makeOpts({ cookie: '__Host-geo_sid=tok123', 'x-workspace-id': 'ws-1' }),
      deps as any,
    )
    expect(ctx.workspace).toBeUndefined()
  })

  // 行 4：CUSTOMER + ORG_OWNER —— 本企业 workspace 直通
  it('CUSTOMER + ORG_OWNER + 本企业 workspace → 通过', async () => {
    const resolved = {
      session: makeSession(),
      user: makeUser({ userType: 'CUSTOMER', platformRole: null, organizationId: 'org-1', orgRole: 'ORG_OWNER' }),
    }
    const deps = {
      prisma: {} as any,
      sessions: { resolve: vi.fn(async () => resolved) },
      workspaceService: { getById: vi.fn(async () => makeWorkspace()) },
      apiCredentials: { findByKey: vi.fn(async () => null) },
      members: { resolveAccess: vi.fn(), hasAssignment: vi.fn() },
    }
    const ctx = await createContextWithServices(
      makeOpts({ cookie: '__Host-geo_sid=tok123', 'x-workspace-id': 'ws-1' }),
      deps as any,
    )
    expect(ctx.workspace?.id).toBe('ws-1')
    // OWNER 无需 member 记录，也不走 resolveAccess
    expect(deps.members.resolveAccess).not.toHaveBeenCalled()
    expect(deps.members.hasAssignment).not.toHaveBeenCalled()
  })

  it('CUSTOMER + ORG_OWNER + 跨企业 workspace（organizationId 不匹配）→ 留空', async () => {
    const resolved = {
      session: makeSession(),
      user: makeUser({ userType: 'CUSTOMER', platformRole: null, organizationId: 'org-1', orgRole: 'ORG_OWNER' }),
    }
    const deps = {
      prisma: {} as any,
      sessions: { resolve: vi.fn(async () => resolved) },
      workspaceService: { getById: vi.fn(async () => makeWorkspace('ws-1', 'ACTIVE', 'org-2')) },
      apiCredentials: { findByKey: vi.fn(async () => null) },
      members: { resolveAccess: vi.fn(), hasAssignment: vi.fn() },
    }
    const ctx = await createContextWithServices(
      makeOpts({ cookie: '__Host-geo_sid=tok123', 'x-workspace-id': 'ws-1' }),
      deps as any,
    )
    expect(ctx.workspace).toBeUndefined()
  })

  // 行 5：CUSTOMER + MEMBER/VIEWER —— 同 OWNER 的企业校验 + resolveAccess 非 null
  it('CUSTOMER + ORG_MEMBER + 本企业 + resolveAccess 非 null → 通过（不传 orgRole，保库值新鲜）', async () => {
    const resolved = {
      session: makeSession(),
      user: makeUser({ userType: 'CUSTOMER', platformRole: null, organizationId: 'org-1', orgRole: 'ORG_MEMBER' }),
    }
    const deps = {
      prisma: {} as any,
      sessions: { resolve: vi.fn(async () => resolved) },
      workspaceService: { getById: vi.fn(async () => makeWorkspace()) },
      apiCredentials: { findByKey: vi.fn(async () => null) },
      members: { resolveAccess: vi.fn(async () => 'OPERATE'), hasAssignment: vi.fn() },
    }
    const ctx = await createContextWithServices(
      makeOpts({ cookie: '__Host-geo_sid=tok123', 'x-workspace-id': 'ws-1' }),
      deps as any,
    )
    expect(ctx.workspace?.id).toBe('ws-1')
    // 调用形状：两参（userId, workspace ref），第三参 orgRole 不传
    expect(deps.members.resolveAccess).toHaveBeenCalledTimes(1)
    const call = deps.members.resolveAccess.mock.calls[0]
    expect(call.length).toBe(2)
    expect(call[0]).toBe('user-1')
    expect(call[1]).toMatchObject({ id: 'ws-1', organizationId: 'org-1' })
  })

  it('CUSTOMER + ORG_MEMBER + resolveAccess null（无 member 记录）→ 留空', async () => {
    const resolved = {
      session: makeSession(),
      user: makeUser({ userType: 'CUSTOMER', platformRole: null, organizationId: 'org-1', orgRole: 'ORG_MEMBER' }),
    }
    const deps = {
      prisma: {} as any,
      sessions: { resolve: vi.fn(async () => resolved) },
      workspaceService: { getById: vi.fn(async () => makeWorkspace()) },
      apiCredentials: { findByKey: vi.fn(async () => null) },
      members: { resolveAccess: vi.fn(async () => null), hasAssignment: vi.fn() },
    }
    const ctx = await createContextWithServices(
      makeOpts({ cookie: '__Host-geo_sid=tok123', 'x-workspace-id': 'ws-1' }),
      deps as any,
    )
    expect(ctx.workspace).toBeUndefined()
  })

  it('CUSTOMER + ORG_VIEWER + 本企业 + resolveAccess 非 null → 通过', async () => {
    const resolved = {
      session: makeSession(),
      user: makeUser({ userType: 'CUSTOMER', platformRole: null, organizationId: 'org-1', orgRole: 'ORG_VIEWER' }),
    }
    const deps = {
      prisma: {} as any,
      sessions: { resolve: vi.fn(async () => resolved) },
      workspaceService: { getById: vi.fn(async () => makeWorkspace()) },
      apiCredentials: { findByKey: vi.fn(async () => null) },
      members: { resolveAccess: vi.fn(async () => 'VIEW'), hasAssignment: vi.fn() },
    }
    const ctx = await createContextWithServices(
      makeOpts({ cookie: '__Host-geo_sid=tok123', 'x-workspace-id': 'ws-1' }),
      deps as any,
    )
    expect(ctx.workspace?.id).toBe('ws-1')
  })

  it('CUSTOMER + ORG_MEMBER + 跨企业 → 留空且 resolveAccess 不被调（企业校验先行拦截）', async () => {
    const resolved = {
      session: makeSession(),
      user: makeUser({ userType: 'CUSTOMER', platformRole: null, organizationId: 'org-1', orgRole: 'ORG_MEMBER' }),
    }
    const deps = {
      prisma: {} as any,
      sessions: { resolve: vi.fn(async () => resolved) },
      workspaceService: { getById: vi.fn(async () => makeWorkspace('ws-1', 'ACTIVE', 'org-2')) },
      apiCredentials: { findByKey: vi.fn(async () => null) },
      members: { resolveAccess: vi.fn(async () => 'OPERATE'), hasAssignment: vi.fn() },
    }
    const ctx = await createContextWithServices(
      makeOpts({ cookie: '__Host-geo_sid=tok123', 'x-workspace-id': 'ws-1' }),
      deps as any,
    )
    expect(deps.members.resolveAccess).not.toHaveBeenCalled()
    expect(ctx.workspace).toBeUndefined()
  })

  // 行 6：CUSTOMER 无 orgRole —— workspace 留空
  it('CUSTOMER 无 orgRole + x-workspace-id → 留空且不查 getById', async () => {
    const resolved = {
      session: makeSession(),
      user: makeUser({ userType: 'CUSTOMER', platformRole: null, organizationId: 'org-1', orgRole: null }),
    }
    const deps = {
      prisma: {} as any,
      sessions: { resolve: vi.fn(async () => resolved) },
      workspaceService: { getById: vi.fn(async () => makeWorkspace()) },
      apiCredentials: { findByKey: vi.fn(async () => null) },
      members: { resolveAccess: vi.fn(), hasAssignment: vi.fn() },
    }
    const ctx = await createContextWithServices(
      makeOpts({ cookie: '__Host-geo_sid=tok123', 'x-workspace-id': 'ws-1' }),
      deps as any,
    )
    expect(deps.workspaceService.getById).not.toHaveBeenCalled()
    expect(ctx.workspace).toBeUndefined()
  })

  it('apiKey 通道带 x-workspace-id → 保持 credential 绑定的 workspace（不受头影响）', async () => {
    const { deps } = makeDeps()
    const ctx = await createContextWithServices(
      makeOpts({ 'x-api-key': 'geo_secret', 'x-workspace-id': 'ws-other' }),
      deps as any,
    )
    expect(ctx.workspace?.id).toBe('ws-1')
    expect(deps.workspaceService.getById).not.toHaveBeenCalled()
  })
})

describe('createContextWithServices：requestMeta 与 res', () => {
  it('ip 取 x-forwarded-for 首段；headers 小写化快照；requestId/userAgent 提取', async () => {
    const { deps } = makeDeps()
    const ctx = await createContextWithServices(
      makeOpts({
        'X-Forwarded-For': '203.0.113.9, 10.0.0.2',
        'User-Agent': 'vitest-agent',
        'X-Api-Key': 'geo_secret',
      }),
      deps as any,
    )
    expect(ctx.requestMeta.ip).toBe('203.0.113.9')
    expect(ctx.requestMeta.userAgent).toBe('vitest-agent')
    expect(ctx.requestMeta.requestId).toBe('req-42')
    expect(ctx.requestMeta.headers['x-forwarded-for']).toBe('203.0.113.9, 10.0.0.2')
    expect(ctx.requestMeta.headers['user-agent']).toBe('vitest-agent')
    expect(ctx.requestMeta.headers['X-Forwarded-For']).toBeUndefined()
  })

  it('无 x-forwarded-for → 回退 fastify req.ip，再回退 socket.remoteAddress', async () => {
    const { deps } = makeDeps()
    const withFastifyIp = await createContextWithServices(makeOpts({}, { ip: '192.0.2.5' }), deps as any)
    expect(withFastifyIp.requestMeta.ip).toBe('192.0.2.5')

    const raw = await createContextWithServices(
      { req: { headers: {}, socket: { remoteAddress: '10.0.0.1' } } } as any,
      deps as any,
    )
    expect(raw.requestMeta.ip).toBe('10.0.0.1')
  })

  it('IP 信任边界现状语义：XFF 首值无条件优先（直连部署下可被伪造，按 IP 的限速随之失效）', async () => {
    // 本条钉死的是**现状**而非期望：部署前提是"恒在清洗 XFF 的反代之后"。
    // 若将来引入 trustProxy / 多级 XFF 解析，本断言应随之改写——它是部署形态的哨兵。
    const { deps } = makeDeps()
    const ctx = await createContextWithServices(
      makeOpts(
        { 'X-Forwarded-For': '198.51.100.66, 10.0.0.1' },
        // socket 地址与 XFF 首值完全不同，说明取的是 XFF 而非连接来源
        { ip: '10.0.0.9' },
      ),
      deps as any,
    )
    expect(ctx.requestMeta.ip).toBe('198.51.100.66')

    // 无 XFF 时才回落连接地址（反代场景下即反代自身 IP）
    const noHeader = await createContextWithServices(
      makeOpts({}, { ip: '10.0.0.9' }),
      deps as any,
    )
    expect(noHeader.requestMeta.ip).toBe('10.0.0.9')
  })

  it('headers 值为数组时取首项，无对应头时为 undefined', async () => {
    const { deps } = makeDeps()
    const ctx = await createContextWithServices(
      makeOpts({ 'X-Forwarded-For': ['203.0.113.9', '10.0.0.2'] }),
      deps as any,
    )
    expect(ctx.requestMeta.headers['x-forwarded-for']).toBe('203.0.113.9')
    expect(ctx.requestMeta.headers['x-workspace-id']).toBeUndefined()
  })

  it('res 原样透传', async () => {
    const { deps } = makeDeps()
    const opts = makeOpts()
    const ctx = await createContextWithServices(opts, deps as any)
    expect(ctx.res).toBe(opts.res)
  })

  it('requestMeta.method 取 req.method（GET 视为 query）', async () => {
    const { deps } = makeDeps()
    const ctx = await createContextWithServices(makeOpts({}, { method: 'POST' }), deps as any)
    expect(ctx.requestMeta.method).toBe('POST')
  })
})
