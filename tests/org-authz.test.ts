import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { Session, User, Workspace, WorkspaceMember } from '@prisma/client'
import { appRouter } from '../src/router.js'
import { createContextWithServices } from '../src/core/trpc/context.js'
import { createSessionService } from '../src/core/auth/session.js'
import { createWorkspaceService } from '../src/core/workspace/service.js'
import { createApiCredentialService } from '../src/platform/tenancy/api-credentials.js'
import { createMemberService } from '../src/platform/tenancy/member-service.js'

/**
 * 任务 11：跨租户越权矩阵集成测试（P1 审查重点五条）。
 *
 * 与单元测试（context.test.ts 直接 mock deps）不同，这里走**端到端解析链**：
 * 原始请求头 → createContextWithServices（真实 session/workspace/member 服务，
 * 仅 prisma 为内存 mock）→ 真实 appRouter.createCaller（完整中间件链：
 * csrfGuard → requireUser → orgProcedure/protectedProcedure）。
 *
 * 覆盖：
 * ① 企业 A 的 ORG_MEMBER 带 x-workspace-id 指向企业 B 的 workspace → 业务 query
 *    被拒（授权分治：workspace 留空 → UNAUTHORIZED，服务层未被触达）；
 * ② ORG_VIEWER + WorkspaceMember(OPERATE) → 合成降为 VIEW：mutation FORBIDDEN
 *    （文案含"只读"）、query ✓；
 * ③ ORG_MEMBER 调 org.members.create / org.workspaces.create / org.credentials.issue
 *    → orgProcedure 权限点 FORBIDDEN（service 未被触达）；
 * ④ OPERATOR 无分配 → 业务 query 拒；SUPER_ADMIN assignOperator（经真实
 *    members.upsert 落 OPERATE）后 → 同会话 ✓；
 * ⑤ 成员 access 从 OPERATE 降为 VIEW / 被移除（改 mock 数据后同 token 再请求）
 *    → 写 FORBIDDEN（只读）/ query UNAUTHORIZED——授权实时判定，不缓存进会话。
 */

const NOW = new Date()

function makeUser(overrides: Record<string, unknown> = {}): User {
  return {
    id: 'user-x',
    username: 'userx',
    displayName: 'User X',
    email: null,
    phone: null,
    passwordHash: 'x',
    userType: 'CUSTOMER',
    platformRole: null,
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

function makeWorkspace(id: string, organizationId: string): Workspace {
  return {
    id,
    name: `工作区-${id}`,
    domain: 'acme.com',
    llmsTxtUrl: null,
    defaultBrandName: 'Acme',
    platformConfig: '{}',
    publicationConfig: '{}',
    status: 'ACTIVE',
    organizationId,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as Workspace
}

/** 内存态：mock prisma 的数据源（resolveAccess/hasAssignment/upsert 实时读写这里） */
interface State {
  users: Map<string, User>
  workspaces: Map<string, Workspace>
  /** key: `${workspaceId}:${userId}` */
  members: Map<string, WorkspaceMember>
  /** key: tokenHash；value 为带 user 的会话行 */
  sessions: Map<string, Session & { user: User }>
}

function makeMember(
  workspaceId: string,
  userId: string,
  access: WorkspaceMember['access'],
): WorkspaceMember {
  return {
    id: `wm-${workspaceId}-${userId}`,
    workspaceId,
    userId,
    access,
    isPrimary: false,
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as WorkspaceMember
}

/**
 * mock prisma：只实现被测链路真实服务触达的模型方法
 * （session.findUnique / workspace.findUnique / user.findUnique /
 *  workspaceMember.findUnique|upsert|findMany），其余不存在即测试失败。
 */
function makeMockPrisma(state: State) {
  return {
    session: {
      findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) =>
        state.sessions.get(where.tokenHash) ?? null,
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        for (const [hash, session] of state.sessions) {
          if (session.id === where.id) {
            const updated = { ...session, ...data } as Session & { user: User }
            state.sessions.set(hash, updated)
            return updated
          }
        }
        return null
      }),
    },
    workspace: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        state.workspaces.get(where.id) ?? null,
      ),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        state.users.get(where.id) ?? null,
      ),
    },
    workspaceMember: {
      findUnique: vi.fn(
        async ({ where }: { where: { workspaceId_userId: { workspaceId: string; userId: string } } }) =>
          state.members.get(`${where.workspaceId_userId.workspaceId}:${where.workspaceId_userId.userId}`) ??
          null,
      ),
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        [...state.members.values()].filter((m) => m.userId === where.userId),
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: { workspaceId_userId: { workspaceId: string; userId: string } }
          create: { workspaceId: string; userId: string; access: WorkspaceMember['access'] }
        }) => {
          const key = `${where.workspaceId_userId.workspaceId}:${where.workspaceId_userId.userId}`
          const row = makeMember(create.workspaceId, create.userId, create.access)
          state.members.set(key, row)
          return row
        },
      ),
    },
  } as unknown as Parameters<typeof createSessionService>[0]
}

const sha256Hex = (token: string) => createHash('sha256').update(token).digest('hex')

/** 装配全套固定设施：org-1（owner/member/viewer）+ org-2（ws-b1）+ 平台 admin/operator */
function makeFixture() {
  const state: State = {
    users: new Map(),
    workspaces: new Map(),
    members: new Map(),
    sessions: new Map(),
  }

  const users = {
    /** org-1 企业所有者 */
    owner: makeUser({
      id: 'u-owner',
      username: 'owner1',
      orgRole: 'ORG_OWNER',
      organizationId: 'org-1',
    }),
    /** org-1 成员（默认授权 ws-a1 的 OPERATE） */
    member: makeUser({
      id: 'u-member',
      username: 'member1',
      orgRole: 'ORG_MEMBER',
      organizationId: 'org-1',
    }),
    /** org-1 只读角色（被授予 OPERATE 记录，合成仍应降为 VIEW） */
    viewer: makeUser({
      id: 'u-viewer',
      username: 'viewer1',
      orgRole: 'ORG_VIEWER',
      organizationId: 'org-1',
    }),
    /** 平台超级管理员 */
    admin: makeUser({
      id: 'u-admin',
      username: 'admin1',
      userType: 'PLATFORM',
      platformRole: 'SUPER_ADMIN',
    }),
    /** 平台运营/顾问（授权依赖 WorkspaceMember 分配记录） */
    operator: makeUser({
      id: 'u-operator',
      username: 'operator1',
      userType: 'PLATFORM',
      platformRole: 'OPERATOR',
    }),
  }

  const workspaces = {
    wsA1: makeWorkspace('ws-a1', 'org-1'),
    wsB1: makeWorkspace('ws-b1', 'org-2'),
  }

  for (const user of Object.values(users)) state.users.set(user.id, user)
  for (const ws of Object.values(workspaces)) state.workspaces.set(ws.id, ws)

  // viewer 持 OPERATE 记录：§2.2 合成规则（min）下最终仍只读
  state.members.set('ws-a1:u-viewer', makeMember('ws-a1', 'u-viewer', 'OPERATE'))

  const prisma = makeMockPrisma(state)
  const deps = {
    prisma,
    sessions: createSessionService(prisma),
    workspaceService: createWorkspaceService(prisma),
    apiCredentials: createApiCredentialService(prisma),
    members: createMemberService(prisma),
  }

  /** 业务/org 路由 handler 消费的 services（org 与 workspaceAdmin 为越权断言用的探针） */
  const orgProbe = {
    membersCreate: vi.fn(),
    createWorkspace: vi.fn(),
    issueCredential: vi.fn(),
  }
  const services = {
    getWorkspaceSummary: vi.fn(async () => ({
      competitors: ['figma.com'],
      platforms: { deepseek: { configured: true, hint: 'b12c' } },
    })),
    taskService: { review: vi.fn(async () => ({ id: 't-1' })) },
    queryLibrary: { listActive: vi.fn(async () => []) },
    org: orgProbe,
    workspaceAdmin: {
      /** 探针转真：经真实 members.upsert 落 OPERATE（模拟任务 6 的分配闭环） */
      assignOperator: vi.fn(
        async (workspaceId: string, userId: string) =>
          deps.members.upsert(workspaceId, userId, 'OPERATE'),
      ),
    },
  }

  /** 发放会话（真实 createSessionService 会写 mock prisma——这里直接落内存态） */
  function login(userId: string): string {
    const token = `tok-${userId}-${Math.random().toString(36).slice(2, 10)}`
    const session = {
      id: `sess-${userId}`,
      userId,
      tokenHash: sha256Hex(token),
      ip: null,
      userAgent: null,
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
      revokedAt: null,
      createdAt: new Date(),
    } as unknown as Session & { user: User }
    session.user = state.users.get(userId)!
    state.sessions.set(session.tokenHash, session)
    return token
  }

  /**
   * 端到端 caller：真实 createContextWithServices（Cookie 会话 + x-workspace-id
   * 授权分治）→ 合并 services（同 server.ts 的 `{ ...ctx, services }`）→ createCaller。
   */
  async function makeCaller(token: string, extraHeaders: Record<string, string> = {}) {
    const headers: Record<string, string | string[] | undefined> = {
      cookie: `__Host-geo_sid=${token}`,
      'x-geo-csrf': '1',
      ...extraHeaders,
    }
    const ctx = await createContextWithServices(
      {
        req: { headers, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', id: 'req-1' },
        res: { setHeader: vi.fn() },
      } as any,
      deps as any,
    )
    return appRouter.createCaller({ ...ctx, services } as any)
  }

  return { state, deps, services, orgProbe, users, workspaces, login, makeCaller }
}

describe('越权矩阵 ①：跨企业 x-workspace-id（授权分治留空 → UNAUTHORIZED）', () => {
  it('org-1 的 ORG_MEMBER 指向 org-2 的 ws-b1 → workspace.get UNAUTHORIZED，服务层未触达', async () => {
    const f = makeFixture()
    const token = f.login(f.users.member.id)
    const caller = await f.makeCaller(token, { 'x-workspace-id': f.workspaces.wsB1.id })

    await expect(caller.workspace.get()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: expect.stringContaining('无法解析工作区'),
    })
    expect(f.services.getWorkspaceSummary).not.toHaveBeenCalled()
  })

  it('同请求改为本企业未授权 workspace（无 member 记录）→ 同样 UNAUTHORIZED', async () => {
    const f = makeFixture()
    const token = f.login(f.users.member.id)
    // ws-a2 属 org-1 但成员无 WorkspaceMember 记录（resolveAccess → null）
    const wsA2 = makeWorkspace('ws-a2', 'org-1')
    f.state.workspaces.set(wsA2.id, wsA2)
    const caller = await f.makeCaller(token, { 'x-workspace-id': 'ws-a2' })

    await expect(caller.workspace.get()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })
})

describe('越权矩阵 ②：ORG_VIEWER + WorkspaceMember(OPERATE)（合成降为 VIEW）', () => {
  it('query ✓（workspace.get 返回脱敏投影）', async () => {
    const f = makeFixture()
    const token = f.login(f.users.viewer.id)
    const caller = await f.makeCaller(token, { 'x-workspace-id': f.workspaces.wsA1.id })

    const result = await caller.workspace.get()
    expect(result.id).toBe('ws-a1')
    expect(f.services.getWorkspaceSummary).toHaveBeenCalledWith('ws-a1')
  })

  it('mutation FORBIDDEN（文案含"只读"），业务服务未被触达', async () => {
    const f = makeFixture()
    const token = f.login(f.users.viewer.id)
    const caller = await f.makeCaller(token, { 'x-workspace-id': f.workspaces.wsA1.id })

    await expect(caller.tasks.review({ id: 't-1', approved: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('只读'),
    })
    expect(f.services.taskService.review).not.toHaveBeenCalled()
  })
})

describe('越权矩阵 ③：ORG_MEMBER 调 owner 级 org.* 端点（orgProcedure 权限点）', () => {
  it.each([
    {
      label: 'org.members.create（org.manage）',
      run: (caller: any) =>
        caller.org.members.create({ displayName: '越权成员', orgRole: 'ORG_MEMBER' }),
      probe: (f: ReturnType<typeof makeFixture>) => f.orgProbe.membersCreate,
    },
    {
      label: 'org.workspaces.create（workspace.manage）',
      run: (caller: any) =>
        caller.org.workspaces.create({ name: '越权ws', defaultBrandName: 'X' }),
      probe: (f: ReturnType<typeof makeFixture>) => f.orgProbe.createWorkspace,
    },
    {
      label: 'org.credentials.issue（credential.write）',
      run: (caller: any) =>
        caller.org.credentials.issue({ workspaceId: 'ws-a1', name: '越权Key' }),
      probe: (f: ReturnType<typeof makeFixture>) => f.orgProbe.issueCredential,
    },
  ])('$label → FORBIDDEN，service 未被触达', async ({ run, probe }) => {
    const f = makeFixture()
    const token = f.login(f.users.member.id)
    // member 在 ws-a1 有 OPERATE 记录：即便业务授权在场，org 管理面仍须拒
    f.state.members.set('ws-a1:u-member', makeMember('ws-a1', 'u-member', 'OPERATE'))
    const caller = await f.makeCaller(token, { 'x-workspace-id': 'ws-a1' })

    await expect(run(caller)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('ORG_MEMBER'),
    })
    expect(probe(f)).not.toHaveBeenCalled()
  })
})

describe('越权矩阵 ④：OPERATOR 分配闭环（无分配拒 → assignOperator 后放行）', () => {
  it('无分配记录 → workspace.get UNAUTHORIZED', async () => {
    const f = makeFixture()
    const token = f.login(f.users.operator.id)
    const caller = await f.makeCaller(token, { 'x-workspace-id': f.workspaces.wsA1.id })

    await expect(caller.workspace.get()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(f.services.getWorkspaceSummary).not.toHaveBeenCalled()
  })

  it('SUPER_ADMIN assignOperator（真实 members.upsert 落 OPERATE）→ 同会话 token 再请求 ✓', async () => {
    const f = makeFixture()
    const operatorToken = f.login(f.users.operator.id)
    const adminToken = f.login(f.users.admin.id)

    // 平台侧分配（admin 无需 x-workspace-id：platformProcedure 只看平台角色）
    const admin = await f.makeCaller(adminToken)
    await admin.admin.workspace.assignOperator({
      workspaceId: f.workspaces.wsA1.id,
      userId: f.users.operator.id,
    })
    expect(f.services.workspaceAdmin.assignOperator).toHaveBeenCalledWith(
      f.workspaces.wsA1.id,
      f.users.operator.id,
      { isPrimary: undefined },
      f.users.admin.id,
    )
    // 分配真实落库（mock prisma 内存态）：hasAssignment 下一请求即命中
    expect(f.state.members.get('ws-a1:u-operator')?.access).toBe('OPERATE')

    const caller = await f.makeCaller(operatorToken, { 'x-workspace-id': f.workspaces.wsA1.id })
    const result = await caller.workspace.get()
    expect(result.id).toBe('ws-a1')
    expect(f.services.getWorkspaceSummary).toHaveBeenCalledWith('ws-a1')
  })
})

describe('越权矩阵 ⑤：成员降级/移除的实时性（同会话下一请求即生效）', () => {
  it('access OPERATE → 写 ✓；降为 VIEW 后同 token 写 FORBIDDEN（只读）、query 仍 ✓', async () => {
    const f = makeFixture()
    const token = f.login(f.users.member.id)
    f.state.members.set('ws-a1:u-member', makeMember('ws-a1', 'u-member', 'OPERATE'))

    // 降级前：OPERATE 可写
    const before = await f.makeCaller(token, { 'x-workspace-id': 'ws-a1' })
    await expect(before.tasks.review({ id: 't-1', approved: true })).resolves.toMatchObject({
      id: 't-1',
    })
    expect(f.services.taskService.review).toHaveBeenCalledTimes(1)

    // 降级（OWNER 侧 setAccess 落库 = 改成员记录），会话不重发
    f.state.members.set('ws-a1:u-member', makeMember('ws-a1', 'u-member', 'VIEW'))

    const after = await f.makeCaller(token, { 'x-workspace-id': 'ws-a1' })
    await expect(after.tasks.review({ id: 't-1', approved: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('只读'),
    })
    expect(f.services.taskService.review).toHaveBeenCalledTimes(1)
    // 只读降级不影响读
    await expect(after.workspace.get()).resolves.toMatchObject({ id: 'ws-a1' })
  })

  it('移除记录（授权回收）后同 token → workspace 留空，query 也 UNAUTHORIZED', async () => {
    const f = makeFixture()
    const token = f.login(f.users.member.id)
    f.state.members.set('ws-a1:u-member', makeMember('ws-a1', 'u-member', 'OPERATE'))

    const before = await f.makeCaller(token, { 'x-workspace-id': 'ws-a1' })
    await expect(before.workspace.get()).resolves.toMatchObject({ id: 'ws-a1' })

    f.state.members.delete('ws-a1:u-member')

    const after = await f.makeCaller(token, { 'x-workspace-id': 'ws-a1' })
    await expect(after.workspace.get()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })
})

/**
 * 正向钉住（审查修复）：非 VIEW 访问级的业务 mutation 必须放行——
 * ORG_OWNER（resolveUserWorkspace 常量 MANAGE）与平台 OPERATOR（常量 OPERATE）。
 * ②⑤只钉住了 VIEW 拒写；若 context.ts 的常量赋值被改坏（如误写 'VIEW'），
 * 这两条会变红，防止 VIEW 写拦截误伤管理/运维角色。
 */
describe('正向钉住：OWNER（MANAGE）/ OPERATOR（OPERATE）的写放行', () => {
  it('ORG_OWNER + x-workspace-id 本企业 ws → 业务 mutation ✓（服务被触达）', async () => {
    const f = makeFixture()
    const token = f.login(f.users.owner.id)
    const caller = await f.makeCaller(token, { 'x-workspace-id': f.workspaces.wsA1.id })

    await expect(caller.tasks.review({ id: 't-1', approved: true })).resolves.toMatchObject({
      id: 't-1',
    })
    expect(f.services.taskService.review).toHaveBeenCalledWith('t-1', true, undefined)
  })

  it('平台 OPERATOR（OPERATE 分配记录在场）→ 业务 mutation ✓（服务被触达）', async () => {
    const f = makeFixture()
    // 分配记录（等价 assignOperator 的 upsert 产物：access 恒 OPERATE）
    f.state.members.set('ws-a1:u-operator', makeMember('ws-a1', 'u-operator', 'OPERATE'))
    const token = f.login(f.users.operator.id)
    const caller = await f.makeCaller(token, { 'x-workspace-id': f.workspaces.wsA1.id })

    await expect(caller.tasks.review({ id: 't-1', approved: true })).resolves.toMatchObject({
      id: 't-1',
    })
    expect(f.services.taskService.review).toHaveBeenCalledWith('t-1', true, undefined)
  })
})
