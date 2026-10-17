import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TRPCError } from '@trpc/server'
import type { ApiCredential, Session, User, Workspace } from '@prisma/client'
import {
  router,
  publicProcedure,
  authedProcedure,
  platformProcedure,
  orgProcedure,
  protectedProcedure,
  PLATFORM_ROLE_PERMISSIONS,
  ORG_ROLE_PERMISSIONS,
} from './init.js'

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

function makeWorkspace(status: Workspace['status']): Workspace {
  return {
    id: 'ws-1',
    name: '客户工作区',
    domain: null,
    llmsTxtUrl: null,
    defaultBrandName: 'brand',
    platformConfig: {},
    publicationConfig: {},
    status,
    organizationId: 'org-1',
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as Workspace
}

const CSRF_HEADERS = { 'x-geo-csrf': 'token' }

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    actor: { kind: 'apiKey', credential: makeCredential() } as any,
    workspace: makeWorkspace('ACTIVE'),
    requestMeta: {
      ip: '1.2.3.4',
      requestId: 'req-1',
      headers: { ...CSRF_HEADERS },
    },
    ...overrides,
  } as any
}

/** 统一断言：createCaller 调用抛出指定 code 且（可选）文案含关键词 */
async function expectTrpcError(
  fn: () => Promise<unknown>,
  code: 'FORBIDDEN' | 'UNAUTHORIZED',
  messageContains?: string,
) {
  let error: unknown
  try {
    await fn()
  } catch (e) {
    error = e
  }
  expect(error).toBeInstanceOf(TRPCError)
  const trpcError = error as TRPCError
  expect(trpcError.code).toBe(code)
  if (messageContains) {
    expect(trpcError.message).toContain(messageContains)
  }
}

// ===== 矩阵测试用的真实 router（protectedProcedure） =====
const matrixRouter = router({
  read: protectedProcedure.query(() => 'ok'),
  write: protectedProcedure.mutation(() => 'ok'),
})

describe('protectedProcedure：P0 矩阵（BILLING_ENFORCEMENT 默认 off，服务状态恒 ACTIVE，按 workspace.status 判定）', () => {
  it('ACTIVE：read ✓ / write ✓（apiKey 通道）', async () => {
    const caller = matrixRouter.createCaller(makeCtx({ workspace: makeWorkspace('ACTIVE') }))
    expect(await caller.read()).toBe('ok')
    expect(await caller.write()).toBe('ok')
  })

  it('ACTIVE：read ✓ / write ✓（user + workspace 通道）', async () => {
    const caller = matrixRouter.createCaller(
      makeCtx({
        actor: { kind: 'user', user: makeUser(), session: makeSession() },
        workspace: makeWorkspace('ACTIVE'),
      }),
    )
    expect(await caller.read()).toBe('ok')
    expect(await caller.write()).toBe('ok')
  })

  it('SUSPENDED：read ✓ / write 抛 FORBIDDEN（文案含"只读"）', async () => {
    const caller = matrixRouter.createCaller(makeCtx({ workspace: makeWorkspace('SUSPENDED') }))
    expect(await caller.read()).toBe('ok')
    await expectTrpcError(() => caller.write(), 'FORBIDDEN', '只读')
  })

  it('ARCHIVED：read ✓ / write 抛 FORBIDDEN（文案含"只读"）', async () => {
    const caller = matrixRouter.createCaller(makeCtx({ workspace: makeWorkspace('ARCHIVED') }))
    expect(await caller.read()).toBe('ok')
    await expectTrpcError(() => caller.write(), 'FORBIDDEN', '只读')
  })

  it('workspace 为空：read/write 均抛 UNAUTHORIZED（authDiag 风格可定位文案）', async () => {
    const caller = matrixRouter.createCaller(
      makeCtx({ workspace: undefined, authDiag: 'missing_header' }),
    )
    await expectTrpcError(() => caller.read(), 'UNAUTHORIZED')
    await expectTrpcError(() => caller.write(), 'UNAUTHORIZED')
  })

  it('workspace 为空且 authDiag=key_not_found：文案可定位到 Key 问题', async () => {
    const caller = matrixRouter.createCaller(
      makeCtx({ workspace: undefined, authDiag: 'key_not_found' }),
    )
    await expectTrpcError(() => caller.read(), 'UNAUTHORIZED', 'API Key')
  })

  it('mustChangePassword 用户 + workspace：query/mutation 均 FORBIDDEN（文案含"修改密码"，终审补漏）', async () => {
    const caller = matrixRouter.createCaller(
      makeCtx({
        actor: {
          kind: 'user',
          user: makeUser({ mustChangePassword: true }),
          session: makeSession(),
        },
        workspace: makeWorkspace('ACTIVE'),
      }),
    )
    await expectTrpcError(() => caller.read(), 'FORBIDDEN', '修改密码')
    await expectTrpcError(() => caller.write(), 'FORBIDDEN', '修改密码')
  })

  it('mustChangePassword 约束不影响 apiKey 通道：read/write 照常放行', async () => {
    // apiKey actor 无 user/mustChangePassword 概念，SDK 直连不受该约束影响
    const caller = matrixRouter.createCaller(makeCtx({ workspace: makeWorkspace('ACTIVE') }))
    expect(await caller.read()).toBe('ok')
    expect(await caller.write()).toBe('ok')
  })
})

// ===== csrf 守卫 =====
const csrfRouter = router({
  pubRead: publicProcedure.query(() => 'ok'),
  pubWrite: publicProcedure.mutation(() => 'ok'),
  protWrite: protectedProcedure.mutation(() => 'ok'),
})

describe('csrf 守卫（publicProcedure 挂载，全部 procedure 家族继承）', () => {
  it('mutation 缺 x-geo-csrf：publicProcedure 也拒（auth.login 场景），FORBIDDEN 含 CSRF 提示', async () => {
    const caller = csrfRouter.createCaller(
      makeCtx({ workspace: undefined, requestMeta: { ip: '1', requestId: 'r', headers: {} } }),
    )
    await expectTrpcError(() => caller.pubWrite(), 'FORBIDDEN', 'CSRF')
  })

  it('query 缺 x-geo-csrf：放行', async () => {
    const caller = csrfRouter.createCaller(
      makeCtx({ workspace: undefined, requestMeta: { ip: '1', requestId: 'r', headers: {} } }),
    )
    expect(await caller.pubRead()).toBe('ok')
  })

  it('mutation 带 x-geo-csrf：放行', async () => {
    const caller = csrfRouter.createCaller(makeCtx())
    expect(await caller.pubWrite()).toBe('ok')
  })

  it('protectedProcedure 的 mutation 同样受 csrf 守卫（缺头即拒）', async () => {
    const caller = csrfRouter.createCaller(
      makeCtx({ requestMeta: { ip: '1', requestId: 'r', headers: {} } }),
    )
    await expectTrpcError(() => caller.protWrite(), 'FORBIDDEN', 'CSRF')
  })
})

// ===== requireUser（authedProcedure） =====
const authedRouter = router({
  auth: router({
    me: authedProcedure.query(() => 'me-ok'),
    changePassword: authedProcedure.mutation(() => 'changed'),
  }),
  admin: router({
    list: authedProcedure.query(() => 'list-ok'),
  }),
})

describe('authedProcedure（requireUser）', () => {
  it('anonymous → UNAUTHORIZED', async () => {
    const caller = authedRouter.createCaller(makeCtx({ actor: { kind: 'anonymous' }, workspace: undefined }))
    await expectTrpcError(() => caller.auth.me(), 'UNAUTHORIZED')
  })

  it('apiKey actor（非用户会话）→ UNAUTHORIZED', async () => {
    const caller = authedRouter.createCaller(makeCtx())
    await expectTrpcError(() => caller.auth.me(), 'UNAUTHORIZED')
  })

  it('mustChangePassword 用户：auth.* 放行（me/changePassword）', async () => {
    const caller = authedRouter.createCaller(
      makeCtx({
        actor: {
          kind: 'user',
          user: makeUser({ mustChangePassword: true }),
          session: makeSession(),
        },
        workspace: undefined,
      }),
    )
    expect(await caller.auth.me()).toBe('me-ok')
    expect(await caller.auth.changePassword()).toBe('changed')
  })

  it('mustChangePassword 用户：非 auth.* 拒绝，FORBIDDEN 文案含"修改密码"', async () => {
    const caller = authedRouter.createCaller(
      makeCtx({
        actor: {
          kind: 'user',
          user: makeUser({ mustChangePassword: true }),
          session: makeSession(),
        },
        workspace: undefined,
      }),
    )
    await expectTrpcError(() => caller.admin.list(), 'FORBIDDEN', '修改密码')
  })

  it('正常用户：全部放行', async () => {
    const caller = authedRouter.createCaller(
      makeCtx({
        actor: { kind: 'user', user: makeUser(), session: makeSession() },
        workspace: undefined,
      }),
    )
    expect(await caller.auth.me()).toBe('me-ok')
    expect(await caller.admin.list()).toBe('list-ok')
  })
})

// ===== platformProcedure =====
function platformCaller(role: User['platformRole']) {
  const testRouter = router({
    userManage: platformProcedure('user.manage').query(() => 'user-manage-ok'),
    auditView: platformProcedure('audit.view').query(() => 'audit-view-ok'),
    multi: platformProcedure('workspace.manage', 'credential.write').query(() => 'multi-ok'),
  })
  return testRouter.createCaller(
    makeCtx({
      actor: { kind: 'user', user: makeUser({ platformRole: role }), session: makeSession() },
      workspace: undefined,
    }),
  )
}

describe('platformProcedure（平台角色权限表）', () => {
  it('无 platformRole → FORBIDDEN', async () => {
    const caller = platformCaller(null)
    await expectTrpcError(() => caller.userManage(), 'FORBIDDEN')
  })

  it('SUPER_ADMIN（'*'）恒过：任意权限点放行', async () => {
    const caller = platformCaller('SUPER_ADMIN')
    expect(await caller.userManage()).toBe('user-manage-ok')
    expect(await caller.auditView()).toBe('audit-view-ok')
    expect(await caller.multi()).toBe('multi-ok')
  })

  it('OPERATOR：user.manage 拒 / audit.view 过 / 多权限全含则过', async () => {
    const caller = platformCaller('OPERATOR')
    await expectTrpcError(() => caller.userManage(), 'FORBIDDEN')
    expect(await caller.auditView()).toBe('audit-view-ok')
    expect(await caller.multi()).toBe('multi-ok')
  })

  it('OPERATOR：多权限含未授权点（user.manage + audit.view）→ 拒', async () => {
    const testRouter = router({
      mixed: platformProcedure('user.manage', 'audit.view').query(() => 'mixed-ok'),
    })
    const caller = testRouter.createCaller(
      makeCtx({
        actor: {
          kind: 'user',
          user: makeUser({ platformRole: 'OPERATOR' }),
          session: makeSession(),
        },
        workspace: undefined,
      }),
    )
    await expectTrpcError(() => caller.mixed(), 'FORBIDDEN')
  })

  it('FINANCE / SUPPORT：无 user.manage/audit.view 的角色（资金域/订单只读）调所需权限点外端点全拒', async () => {
    await expectTrpcError(() => platformCaller('FINANCE').auditView(), 'FORBIDDEN')
    await expectTrpcError(() => platformCaller('SUPPORT').userManage(), 'FORBIDDEN')
  })
})

describe('PLATFORM_ROLE_PERMISSIONS 常量表', () => {
  it('SUPER_ADMIN 通配；OPERATOR P0 四权限 + P2 订单运维两项；FINANCE/SUPPORT 资金域/只读（P2 §2.2）', () => {
    expect(PLATFORM_ROLE_PERMISSIONS.SUPER_ADMIN).toEqual(['*'])
    expect(PLATFORM_ROLE_PERMISSIONS.OPERATOR).toEqual([
      'workspace.manage',
      'workspace.enter',
      'credential.write',
      'audit.view',
      'order.view',
      'order.manage',
    ])
    expect(PLATFORM_ROLE_PERMISSIONS.FINANCE).toEqual([
      'order.view',
      'payment.confirm',
      'refund.manage',
      'invoice.manage',
    ])
    expect(PLATFORM_ROLE_PERMISSIONS.SUPPORT).toEqual(['order.view'])
  })
})

// ===== orgProcedure =====
/** 构造客户用户（organizationId 默认 org-1） */
function makeCustomer(overrides: Record<string, unknown> = {}): User {
  return makeUser({
    userType: 'CUSTOMER',
    platformRole: null,
    organizationId: 'org-1',
    ...overrides,
  })
}

function orgCaller(user: User) {
  const testRouter = router({
    info: orgProcedure().query(() => 'info-ok'),
    orgManage: orgProcedure('org.manage').query(() => 'org-manage-ok'),
    wsManage: orgProcedure('workspace.manage').query(() => 'ws-manage-ok'),
    multi: orgProcedure('org.manage', 'credential.write').query(() => 'multi-ok'),
  })
  return testRouter.createCaller(
    makeCtx({
      actor: { kind: 'user', user, session: makeSession() },
      workspace: undefined,
    }),
  )
}

describe('orgProcedure（企业角色权限表，语义与 platformProcedure 同构）', () => {
  it('PLATFORM 用户（即使有平台角色）→ FORBIDDEN', async () => {
    const caller = orgCaller(makeUser({ platformRole: 'SUPER_ADMIN' }))
    await expectTrpcError(() => caller.info(), 'FORBIDDEN')
    await expectTrpcError(() => caller.orgManage(), 'FORBIDDEN')
  })

  it('CUSTOMER 无 orgRole → FORBIDDEN', async () => {
    const caller = orgCaller(makeCustomer({ orgRole: null }))
    await expectTrpcError(() => caller.info(), 'FORBIDDEN')
  })

  it('ORG_OWNER（'*' 通配）恒过：任意权限点放行（含无权限点端点）', async () => {
    const caller = orgCaller(makeCustomer({ orgRole: 'ORG_OWNER' }))
    expect(await caller.info()).toBe('info-ok')
    expect(await caller.orgManage()).toBe('org-manage-ok')
    expect(await caller.wsManage()).toBe('ws-manage-ok')
    expect(await caller.multi()).toBe('multi-ok')
  })

  it('ORG_MEMBER：无权限点端点过、任何权限点（单/多）拒', async () => {
    const caller = orgCaller(makeCustomer({ orgRole: 'ORG_MEMBER' }))
    expect(await caller.info()).toBe('info-ok')
    await expectTrpcError(() => caller.orgManage(), 'FORBIDDEN')
    await expectTrpcError(() => caller.wsManage(), 'FORBIDDEN')
    await expectTrpcError(() => caller.multi(), 'FORBIDDEN')
  })

  it('ORG_VIEWER：P1 空权限表，全拒（info 除外）', async () => {
    const caller = orgCaller(makeCustomer({ orgRole: 'ORG_VIEWER' }))
    expect(await caller.info()).toBe('info-ok')
    await expectTrpcError(() => caller.orgManage(), 'FORBIDDEN')
    await expectTrpcError(() => caller.multi(), 'FORBIDDEN')
  })
})

describe('ORG_ROLE_PERMISSIONS 常量表', () => {
  it("ORG_OWNER 通配；ORG_MEMBER = ['order.view']（任务 4 Ruling 14）；ORG_VIEWER 为空", () => {
    expect(ORG_ROLE_PERMISSIONS.ORG_OWNER).toEqual(['*'])
    expect(ORG_ROLE_PERMISSIONS.ORG_MEMBER).toEqual(['order.view'])
    expect(ORG_ROLE_PERMISSIONS.ORG_VIEWER).toEqual([])
  })
})

// ===== §3.3 服务状态列（任务 10：BILLING_ENFORCEMENT=on 时 requireWorkspace 追加） =====

type SvcState = 'ACTIVE' | 'GRACE' | 'NONE'

/** 注入用 fake resolver：记录调用（断言被查询/未被查询）并返回固定状态 */
function makeStateResolver(state: SvcState, calls: string[] = []) {
  return {
    serviceState: {
      resolve: async (organizationId: string) => {
        calls.push(organizationId)
        return state
      },
      invalidate: () => {},
    },
    calls,
  }
}

/** §3.3 期望值：null = 放行；否则 FORBIDDEN + 文案关键词 */
function expectOutcome(ws: Workspace['status'], svc: SvcState) {
  // NONE（无有效服务）：终审裁定——全拒仅限 workspace=ACTIVE（§3.3"ACTIVE+NONE"行）；
  // SUSPENDED/ARCHIVED × NONE 历史数据只读开放（§5.2"任意服务状态 query ✓"显式，
  // 比 ACTIVE 行更具体），mutation 仍拒（回落既有 workspace.status 只读文案）
  if (svc === 'NONE') {
    if (ws === 'ACTIVE') {
      return {
        query: { code: 'FORBIDDEN' as const, msg: '无有效服务' },
        mutation: { code: 'FORBIDDEN' as const, msg: '无有效服务' },
      }
    }
    return { query: null, mutation: { code: 'FORBIDDEN' as const, msg: '只读' } }
  }
  // GRACE（宽限期只读）：query 放行 / mutation 拒（文案"宽限期只读，请续费"）
  if (svc === 'GRACE') {
    return { query: null, mutation: { code: 'FORBIDDEN' as const, msg: '宽限期只读，请续费' } }
  }
  // svc ACTIVE：回落既有 P0 行为（唯一依据 workspace.status）
  if (ws === 'ACTIVE') return { query: null, mutation: null }
  return { query: null, mutation: { code: 'FORBIDDEN' as const, msg: '只读' } }
}

async function assertCell(
  ctxOverrides: Record<string, unknown>,
  wsStatus: Workspace['status'],
  svc: SvcState,
) {
  const caller = matrixRouter.createCaller(makeCtx(ctxOverrides))
  const expected = expectOutcome(wsStatus, svc)
  if (expected.query) {
    await expectTrpcError(() => caller.read(), expected.query.code, expected.query.msg)
  } else {
    expect(await caller.read()).toBe('ok')
  }
  if (expected.mutation) {
    await expectTrpcError(() => caller.write(), expected.mutation.code, expected.mutation.msg)
  } else {
    expect(await caller.write()).toBe('ok')
  }
}

describe('protectedProcedure：§3.3 服务状态矩阵（BILLING_ENFORCEMENT=on，resolver 经 ctx.services 注入）', () => {
  const prevEnv = process.env.BILLING_ENFORCEMENT
  beforeEach(() => {
    process.env.BILLING_ENFORCEMENT = 'on'
  })
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.BILLING_ENFORCEMENT
    else process.env.BILLING_ENFORCEMENT = prevEnv
  })

  // 穷举：workspace 状态 × 服务状态 × query/mutation × 双通道（apiKey SDK / user 控制台）
  for (const wsStatus of ['ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const) {
    for (const svc of ['ACTIVE', 'GRACE', 'NONE'] as const) {
      it(`apiKey（SDK）通道：workspace=${wsStatus} × 服务=${svc}`, async () => {
        const { serviceState, calls } = makeStateResolver(svc)
        await assertCell(
          { workspace: makeWorkspace(wsStatus), services: { serviceState } },
          wsStatus,
          svc,
        )
        // resolver 按工作区所属企业查询（read/write 各一次，apiKey 通道同矩阵，§3.4）
        expect([...new Set(calls)]).toEqual(['org-1'])
      })

      it(`user（控制台）通道：workspace=${wsStatus} × 服务=${svc}`, async () => {
        const { serviceState, calls } = makeStateResolver(svc)
        await assertCell(
          {
            actor: { kind: 'user', user: makeUser(), session: makeSession() },
            workspace: makeWorkspace(wsStatus),
            services: { serviceState },
          },
          wsStatus,
          svc,
        )
        expect([...new Set(calls)]).toEqual(['org-1'])
      })
    }
  }

  it('终审裁定：SUSPENDED × NONE 历史数据只读——query ✓ / mutation 拒且文案为工作区"只读"（非"无有效服务"）', async () => {
    const { serviceState } = makeStateResolver('NONE')
    const caller = matrixRouter.createCaller(
      makeCtx({ workspace: makeWorkspace('SUSPENDED'), services: { serviceState } }),
    )
    expect(await caller.read()).toBe('ok')
    let error: unknown
    try {
      await caller.write()
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(TRPCError)
    const trpcError = error as TRPCError
    expect(trpcError.code).toBe('FORBIDDEN')
    expect(trpcError.message).toContain('只读')
    expect(trpcError.message).not.toContain('无有效服务')
  })

  it('终审裁定：ARCHIVED × NONE 同——query ✓ / mutation FORBIDDEN"只读"', async () => {
    const { serviceState } = makeStateResolver('NONE')
    const caller = matrixRouter.createCaller(
      makeCtx({ workspace: makeWorkspace('ARCHIVED'), services: { serviceState } }),
    )
    expect(await caller.read()).toBe('ok')
    await expectTrpcError(() => caller.write(), 'FORBIDDEN', '只读')
  })

  it('判定顺序：SUSPENDED + GRACE 的 mutation 报"宽限期只读"而非"已暂停"（服务状态列先于 workspace.status）', async () => {
    const { serviceState } = makeStateResolver('GRACE')
    const caller = matrixRouter.createCaller(
      makeCtx({ workspace: makeWorkspace('SUSPENDED'), services: { serviceState } }),
    )
    let error: unknown
    try {
      await caller.write()
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(TRPCError)
    const trpcError = error as TRPCError
    expect(trpcError.code).toBe('FORBIDDEN')
    expect(trpcError.message).toContain('宽限期只读，请续费')
    expect(trpcError.message).not.toContain('已暂停')
  })

  it('workspace 为空仍先报 UNAUTHORIZED（服务状态列在其后，不产生额外查询）', async () => {
    const { serviceState, calls } = makeStateResolver('NONE')
    const caller = matrixRouter.createCaller(
      makeCtx({ workspace: undefined, services: { serviceState } }),
    )
    await expectTrpcError(() => caller.read(), 'UNAUTHORIZED')
    await expectTrpcError(() => caller.write(), 'UNAUTHORIZED')
    expect(calls).toEqual([])
  })
})

describe('protectedProcedure：BILLING_ENFORCEMENT 未开启 → 服务状态列完全跳过（P0/P1 零行为变化）', () => {
  const prevEnv = process.env.BILLING_ENFORCEMENT
  beforeEach(() => {
    delete process.env.BILLING_ENFORCEMENT
  })
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.BILLING_ENFORCEMENT
    else process.env.BILLING_ENFORCEMENT = prevEnv
  })

  it('注入会返回 NONE 的 resolver 也不被调用：ACTIVE workspace 读写照常放行', async () => {
    const { serviceState, calls } = makeStateResolver('NONE')
    const caller = matrixRouter.createCaller(
      makeCtx({ workspace: makeWorkspace('ACTIVE'), services: { serviceState } }),
    )
    expect(await caller.read()).toBe('ok')
    expect(await caller.write()).toBe('ok')
    expect(calls).toEqual([])
  })

  it('SUSPENDED workspace：既有只读行为不变（query ✓ / mutation FORBIDDEN"只读"），resolver 零调用', async () => {
    const { serviceState, calls } = makeStateResolver('NONE')
    const caller = matrixRouter.createCaller(
      makeCtx({ workspace: makeWorkspace('SUSPENDED'), services: { serviceState } }),
    )
    expect(await caller.read()).toBe('ok')
    await expectTrpcError(() => caller.write(), 'FORBIDDEN', '只读')
    expect(calls).toEqual([])
  })

  it('BILLING_ENFORCEMENT=off（显式关闭）同样跳过：读写放行', async () => {
    process.env.BILLING_ENFORCEMENT = 'off'
    const { serviceState, calls } = makeStateResolver('NONE')
    const caller = matrixRouter.createCaller(
      makeCtx({ workspace: makeWorkspace('ACTIVE'), services: { serviceState } }),
    )
    expect(await caller.read()).toBe('ok')
    expect(await caller.write()).toBe('ok')
    expect(calls).toEqual([])
  })

  it('P1 授权分治不受影响：workspaceAccess=VIEW 的 mutation 仍拒（与开关无关）', async () => {
    const { serviceState, calls } = makeStateResolver('ACTIVE')
    const caller = matrixRouter.createCaller(
      makeCtx({
        workspace: makeWorkspace('ACTIVE'),
        workspaceAccess: 'VIEW',
        services: { serviceState },
      }),
    )
    expect(await caller.read()).toBe('ok')
    await expectTrpcError(() => caller.write(), 'FORBIDDEN', 'VIEW')
    expect(calls).toEqual([]) // off：服务状态列不查，直接被 VIEW 拒
  })
})
