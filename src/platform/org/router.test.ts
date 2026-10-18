import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { PrismaClient, User } from '@prisma/client'
import { orgRouter } from './router.js'
import { QuotaExceededError } from '../billing/entitlement-guard.js'
import { createOrgService } from './service.js'
import { ApiCredentialNotRevokableError } from '../tenancy/api-credentials.js'
import type { IdentityService } from '../identity/service.js'
import type { WorkspaceAdminService } from '../tenancy/workspace-admin.js'

const NOW = new Date('2026-10-13T08:00:00.000Z')

function makeUser(overrides: Record<string, unknown> = {}): User {
  return {
    id: 'user-1',
    username: 'owner',
    displayName: 'Owner',
    email: null,
    phone: null,
    passwordHash: 'x',
    userType: 'CUSTOMER',
    platformRole: null,
    organizationId: 'org-1',
    orgRole: 'ORG_OWNER',
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

function makePrisma() {
  return {
    organization: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    workspace: {
      findUnique: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    apiCredential: {
      findUnique: vi.fn(),
    },
  } as unknown as PrismaClient & Record<string, Record<string, ReturnType<typeof vi.fn>>>
}

function makeIdentity() {
  return {
    createOrgUser: vi.fn(),
    setStatus: vi.fn(),
    resetPassword: vi.fn(async () => 'TempPass12345'),
  } as unknown as IdentityService & Record<string, ReturnType<typeof vi.fn>>
}

function makeMembers() {
  return {
    listOrgMembers: vi.fn(),
    upsert: vi.fn(),
  }
}

function makeAudit() {
  return {
    record: vi.fn(async () => {}),
    list: vi.fn(),
  }
}

function makeWorkspaceAdmin() {
  return {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    setCompetitors: vi.fn(),
    setPlatformCredentials: vi.fn(),
  }
}

/** P0 api-credentials service 替身（org service 只做企业边界包装，逻辑全透传） */
function makeCredentials() {
  return {
    list: vi.fn(),
    issue: vi.fn(),
    revoke: vi.fn(),
  }
}

let prisma: ReturnType<typeof makePrisma>
let identity: ReturnType<typeof makeIdentity>
let members: ReturnType<typeof makeMembers>
let audit: ReturnType<typeof makeAudit>
let credentials: ReturnType<typeof makeCredentials> & Record<string, ReturnType<typeof vi.fn>>
let workspaceAdmin: ReturnType<typeof makeWorkspaceAdmin> &
  Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  prisma = makePrisma()
  identity = makeIdentity()
  members = makeMembers()
  audit = makeAudit()
  credentials = makeCredentials() as ReturnType<typeof makeCredentials> &
    Record<string, ReturnType<typeof vi.fn>>
  workspaceAdmin = makeWorkspaceAdmin() as ReturnType<typeof makeWorkspaceAdmin> &
    Record<string, ReturnType<typeof vi.fn>>
})

/** 组装真实 org service（mock prisma/identity/members/audit/workspaceAdmin）：
 *  越权校验/审计断言需要穿透 router 触达 service 逻辑。 */
function buildService() {
  return createOrgService({
    prisma,
    identity,
    members,
    audit,
    credentials: credentials as any,
    workspaceAdmin: workspaceAdmin as unknown as WorkspaceAdminService,
  })
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    actor: {
      kind: 'user',
      user: makeUser(),
      session: { id: 'sess-1' },
    },
    requestMeta: {
      ip: '1.2.3.4',
      requestId: 'req-1',
      method: 'GET',
      headers: { 'x-geo-csrf': 'test' },
    },
    services: { org: buildService() },
    ...overrides,
  } as any
}

/** 按角色构造客户用户 ctx（organizationId 默认 org-1） */
function ctxWithOrgRole(orgRole: string | null, overrides: Record<string, unknown> = {}) {
  return makeCtx({
    actor: {
      kind: 'user',
      user: makeUser({ orgRole }),
      session: { id: 'sess-1' },
    },
    ...overrides,
  })
}

function orgInfo() {
  return {
    id: 'org-1',
    name: '企业A',
    creditCode: '91310000MA1FL8XXXX',
    industry: '互联网',
    status: 'ACTIVE',
  }
}

function orgMemberUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-9',
    username: 'zhang',
    displayName: '张三',
    orgRole: 'ORG_MEMBER',
    status: 'ACTIVE',
    lastLoginAt: null,
    ...overrides,
  }
}

/** workspace 归属探针行（service 越权校验的最小查询形状） */
function wsRef(organizationId: string) {
  return { id: 'ws-1', organizationId }
}

/** P0 WorkspaceAdminView 投影样例（org 侧复用同一投影） */
function adminWorkspaceView(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ws-1',
    name: '华东区',
    domain: 'acme.com',
    llmsTxtUrl: null,
    defaultBrandName: 'Acme',
    status: 'ACTIVE',
    organizationId: 'org-1',
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    organization: null,
    ...overrides,
  }
}

const platformSummaryFixture = {
  competitors: ['beta.com'],
  platforms: {
    deepseek: { configured: true, hint: '已配置 1 项凭证' },
    doubao: { configured: false, hint: '未配置' },
  },
}

/** ApiCredential 完整行（issue 返回值；org 侧须脱敏为不含 keyHash 的 summary） */
function credentialRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cred-1',
    workspaceId: 'ws-1',
    name: '备份 Key',
    keyPrefix: 'geo_ab12',
    keyHash: 'sha256-of-plaintext',
    scopes: ['*'],
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdById: 'user-1',
    createdAt: NOW,
    ...overrides,
  }
}

/** ApiCredentialSummary 脱敏投影样例（与 list/issue 的返回形状一致） */
function credentialSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cred-1',
    name: '备份 Key',
    keyPrefix: 'geo_ab12',
    lastUsedAt: null,
    scopes: ['*'],
    revokedAt: null,
    ...overrides,
  }
}

describe('orgRouter：权限矩阵（orgProcedure）', () => {
  it('PLATFORM 用户（含 SUPER_ADMIN）→ FORBIDDEN，不触达 service', async () => {
    const caller = orgRouter.createCaller(
      ctxWithOrgRole('ORG_OWNER', {
        actor: {
          kind: 'user',
          user: makeUser({ userType: 'PLATFORM', platformRole: 'SUPER_ADMIN', orgRole: null }),
          session: { id: 'sess-1' },
        },
      }),
    )
    await expect(caller.info.get()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(caller.members.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(prisma.organization.findUnique).not.toHaveBeenCalled()
    expect(members.listOrgMembers).not.toHaveBeenCalled()
  })

  it('CUSTOMER 无 orgRole → FORBIDDEN', async () => {
    const caller = orgRouter.createCaller(ctxWithOrgRole(null))
    await expect(caller.info.get()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(prisma.organization.findUnique).not.toHaveBeenCalled()
  })

  it('CUSTOMER 有 orgRole 但未挂靠企业（organizationId 脏数据）→ FORBIDDEN', async () => {
    const caller = orgRouter.createCaller(
      ctxWithOrgRole('ORG_OWNER', {
        actor: {
          kind: 'user',
          user: makeUser({ organizationId: null }),
          session: { id: 'sess-1' },
        },
      }),
    )
    await expect(caller.info.get()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('ORG_MEMBER：info.get（无权限点）过、org.manage 端点全拒（403）', async () => {
    prisma.organization.findUnique.mockResolvedValue(orgInfo())
    const caller = orgRouter.createCaller(ctxWithOrgRole('ORG_MEMBER'))

    await expect(caller.info.get()).resolves.toMatchObject({ id: 'org-1' })

    const calls = [
      () => caller.info.update({ name: '新名' }),
      () => caller.members.list(),
      () =>
        caller.members.create({ displayName: '张三', orgRole: 'ORG_MEMBER' }),
      () =>
        caller.members.setAccess({ userId: 'user-9', workspaceId: 'ws-1', access: 'VIEW' }),
      () => caller.members.setStatus({ userId: 'user-9', status: 'DISABLED' }),
      () => caller.members.resetPassword({ userId: 'user-9' }),
      () => caller.workspaces.create({ name: '华东区', defaultBrandName: 'Acme' }),
      () => caller.credentials.issue({ workspaceId: 'ws-1', name: '备份 Key' }),
      () => caller.credentials.revoke({ credentialId: 'cred-1' }),
    ]
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    expect(prisma.organization.update).not.toHaveBeenCalled()
    expect(identity.createOrgUser).not.toHaveBeenCalled()
    expect(members.upsert).not.toHaveBeenCalled()
    expect(identity.setStatus).not.toHaveBeenCalled()
    expect(identity.resetPassword).not.toHaveBeenCalled()
    expect(workspaceAdmin.create).not.toHaveBeenCalled()
    expect(credentials.issue).not.toHaveBeenCalled()
    expect(credentials.revoke).not.toHaveBeenCalled()
  })

  it('ORG_VIEWER：org.manage 端点同样全拒', async () => {
    const caller = orgRouter.createCaller(ctxWithOrgRole('ORG_VIEWER'))
    await expect(caller.members.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(caller.members.resetPassword({ userId: 'user-9' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('ORG_OWNER（'*' 通配）全端点放行', async () => {
    prisma.organization.findUnique.mockResolvedValue(orgInfo())
    prisma.organization.update.mockResolvedValue({ ...orgInfo(), name: '新名' })
    members.listOrgMembers.mockResolvedValue([{ user: orgMemberUser() }])
    identity.createOrgUser.mockResolvedValue({
      user: makeUser({ id: 'user-9', username: 'zhang', orgRole: 'ORG_MEMBER' }),
      password: 'TempPass12345',
    })
    prisma.workspace.findUnique.mockResolvedValue({ id: 'ws-1', organizationId: 'org-1' })
    prisma.user.findUnique.mockResolvedValue({ id: 'user-9', organizationId: 'org-1' })
    identity.setStatus.mockResolvedValue(makeUser({ id: 'user-9', status: 'DISABLED' }))

    const caller = orgRouter.createCaller(makeCtx())
    await expect(caller.info.get()).resolves.toMatchObject({ id: 'org-1' })
    await expect(caller.info.update({ name: '新名' })).resolves.toMatchObject({ name: '新名' })
    await expect(caller.members.list()).resolves.toHaveLength(1)
    await expect(
      caller.members.create({ displayName: '张三', orgRole: 'ORG_MEMBER' }),
    ).resolves.toMatchObject({ password: 'TempPass12345' })
    await expect(
      caller.members.setAccess({ userId: 'user-9', workspaceId: 'ws-1', access: 'VIEW' }),
    ).resolves.toEqual({ ok: true })
    await expect(
      caller.members.setStatus({ userId: 'user-9', status: 'DISABLED' }),
    ).resolves.toMatchObject({ status: 'DISABLED' })
    await expect(caller.members.resetPassword({ userId: 'user-9' })).resolves.toEqual({
      password: 'TempPass12345',
    })
  })
})

describe('orgRouter.info', () => {
  it('info.get：按 actor.organizationId 定位，返回本企业投影（含 creditCode/industry/status）', async () => {
    prisma.organization.findUnique.mockResolvedValue(orgInfo())
    const caller = orgRouter.createCaller(makeCtx())

    const result = await caller.info.get()

    expect(prisma.organization.findUnique).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      select: {
        id: true,
        name: true,
        creditCode: true,
        industry: true,
        status: true,
      },
    })
    expect(result).toEqual(orgInfo())
  })

  it('info.get：企业不存在 → NOT_FOUND', async () => {
    prisma.organization.findUnique.mockResolvedValue(null)
    const caller = orgRouter.createCaller(makeCtx())
    await expect(caller.info.get()).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('info.update：更新字段 + audit org.update（actorId=ctx.userId，diff=变更字段）', async () => {
    prisma.organization.findUnique.mockResolvedValue(orgInfo())
    prisma.organization.update.mockResolvedValue({ ...orgInfo(), name: '新名', industry: '制造业' })
    const caller = orgRouter.createCaller(makeCtx())

    const result = await caller.info.update({ name: '新名', industry: '制造业' })

    expect(prisma.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { name: '新名', industry: '制造业' },
      select: {
        id: true,
        name: true,
        creditCode: true,
        industry: true,
        status: true,
      },
    })
    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'user-1',
      actorType: 'USER',
      action: 'org.update',
      organizationId: 'org-1',
      target: 'Organization:org-1',
      diff: { name: '新名', industry: '制造业' },
    })
    expect(result).toMatchObject({ name: '新名', industry: '制造业' })
  })

  it('info.update：企业不存在 → NOT_FOUND，不写库不审计', async () => {
    prisma.organization.findUnique.mockResolvedValue(null)
    const caller = orgRouter.createCaller(makeCtx())
    await expect(caller.info.update({ name: '新名' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(prisma.organization.update).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })
})

describe('orgRouter.members.list', () => {
  it('透传 actor.organizationId，返回成员视图（含 orgRole/status/lastLoginAt/displayName/username）', async () => {
    members.listOrgMembers.mockResolvedValue([{ user: orgMemberUser({ lastLoginAt: NOW }) }])
    const caller = orgRouter.createCaller(makeCtx())

    const result = await caller.members.list()

    expect(members.listOrgMembers).toHaveBeenCalledWith('org-1')
    expect(result).toEqual([
      {
        user: {
          id: 'user-9',
          username: 'zhang',
          displayName: '张三',
          orgRole: 'ORG_MEMBER',
          status: 'ACTIVE',
          lastLoginAt: NOW,
        },
      },
    ])
  })
})

describe('orgRouter.members.create', () => {
  it('zod 物理排除 ORG_OWNER：orgRole 传 ORG_OWNER → 拒（zod 400），不触达 identity', async () => {
    const caller = orgRouter.createCaller(makeCtx())
    await expect(
      caller.members.create({ displayName: '越权者', orgRole: 'ORG_OWNER' as any }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(identity.createOrgUser).not.toHaveBeenCalled()
  })

  it('透传 identity.createOrgUser（organizationId=本企业、actorId），返回用户投影+一次性密码', async () => {
    identity.createOrgUser.mockResolvedValue({
      user: makeUser({
        id: 'user-9',
        username: 'zhang',
        displayName: '张三',
        email: 'zhang@acme.com',
        orgRole: 'ORG_MEMBER',
        mustChangePassword: true,
      }),
      password: 'TempPass12345',
    })
    const caller = orgRouter.createCaller(makeCtx())

    const result = await caller.members.create({
      username: 'zhang',
      email: 'zhang@acme.com',
      displayName: '张三',
      orgRole: 'ORG_MEMBER',
    })

    expect(identity.createOrgUser).toHaveBeenCalledWith({
      organizationId: 'org-1',
      username: 'zhang',
      email: 'zhang@acme.com',
      displayName: '张三',
      orgRole: 'ORG_MEMBER',
      password: undefined,
      actorId: 'user-1',
    })
    expect(result).toEqual({
      user: {
        id: 'user-9',
        username: 'zhang',
        displayName: '张三',
        email: 'zhang@acme.com',
        orgRole: 'ORG_MEMBER',
        status: 'ACTIVE',
        mustChangePassword: true,
      },
      password: 'TempPass12345',
    })
  })

  it('displayName 为空 / username 过短 → zod 拒绝，不触达 identity', async () => {
    const caller = orgRouter.createCaller(makeCtx())
    await expect(
      caller.members.create({ displayName: '', orgRole: 'ORG_VIEWER' }),
    ).rejects.toThrow()
    await expect(
      caller.members.create({ displayName: '张三', orgRole: 'ORG_VIEWER', username: 'ab' }),
    ).rejects.toThrow()
    expect(identity.createOrgUser).not.toHaveBeenCalled()
  })
})

describe('orgRouter.members.setAccess', () => {
  function wsRef(organizationId: string) {
    return { id: 'ws-1', organizationId }
  }

  it('workspace 属他企业 → FORBIDDEN（403），不 upsert 不审计', async () => {
    prisma.workspace.findUnique.mockResolvedValue(wsRef('org-2'))
    const caller = orgRouter.createCaller(makeCtx())

    await expect(
      caller.members.setAccess({ userId: 'user-9', workspaceId: 'ws-1', access: 'VIEW' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    expect(members.upsert).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('workspace 不存在 → NOT_FOUND', async () => {
    prisma.workspace.findUnique.mockResolvedValue(null)
    const caller = orgRouter.createCaller(makeCtx())
    await expect(
      caller.members.setAccess({ userId: 'user-9', workspaceId: 'ws-x', access: 'VIEW' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('user 属他企业 → FORBIDDEN（403），不 upsert 不审计', async () => {
    prisma.workspace.findUnique.mockResolvedValue(wsRef('org-1'))
    prisma.user.findUnique.mockResolvedValue({ id: 'user-9', organizationId: 'org-2' })
    const caller = orgRouter.createCaller(makeCtx())

    await expect(
      caller.members.setAccess({ userId: 'user-9', workspaceId: 'ws-1', access: 'MANAGE' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    expect(members.upsert).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('user 不存在 → NOT_FOUND', async () => {
    prisma.workspace.findUnique.mockResolvedValue(wsRef('org-1'))
    prisma.user.findUnique.mockResolvedValue(null)
    const caller = orgRouter.createCaller(makeCtx())
    await expect(
      caller.members.setAccess({ userId: 'user-404', workspaceId: 'ws-1', access: 'VIEW' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('正常路径：members.upsert(workspaceId, userId, access) + audit member.set_access', async () => {
    prisma.workspace.findUnique.mockResolvedValue(wsRef('org-1'))
    prisma.user.findUnique.mockResolvedValue({ id: 'user-9', organizationId: 'org-1' })
    const caller = orgRouter.createCaller(makeCtx())

    const result = await caller.members.setAccess({
      userId: 'user-9',
      workspaceId: 'ws-1',
      access: 'OPERATE',
    })

    expect(members.upsert).toHaveBeenCalledWith('ws-1', 'user-9', 'OPERATE')
    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'user-1',
      actorType: 'USER',
      action: 'member.set_access',
      organizationId: 'org-1',
      workspaceId: 'ws-1',
      target: 'User:user-9',
      diff: { workspaceId: 'ws-1', access: 'OPERATE' },
    })
    expect(result).toEqual({ ok: true })
  })

  it('access 非法值 → zod 拒绝', async () => {
    const caller = orgRouter.createCaller(makeCtx())
    await expect(
      caller.members.setAccess({
        userId: 'user-9',
        workspaceId: 'ws-1',
        access: 'ROOT' as any,
      }),
    ).rejects.toThrow()
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled()
  })
})

describe('orgRouter.members.setStatus', () => {
  it('透传 identity.setStatus（DISABLED 联动 revoke 由 identity 侧完成）', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'user-9', organizationId: 'org-1' })
    identity.setStatus.mockResolvedValue(makeUser({ id: 'user-9', status: 'DISABLED' }))
    const caller = orgRouter.createCaller(makeCtx())

    const result = await caller.members.setStatus({ userId: 'user-9', status: 'DISABLED' })

    expect(identity.setStatus).toHaveBeenCalledWith('user-9', 'DISABLED', 'user-1')
    expect(result).toEqual({ id: 'user-9', status: 'DISABLED' })
  })

  it('目标 user 属他企业 → FORBIDDEN，不透传 identity', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'user-9', organizationId: 'org-2' })
    const caller = orgRouter.createCaller(makeCtx())
    await expect(
      caller.members.setStatus({ userId: 'user-9', status: 'DISABLED' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(identity.setStatus).not.toHaveBeenCalled()
  })

  it('status 非法值 → zod 拒绝', async () => {
    const caller = orgRouter.createCaller(makeCtx())
    await expect(
      caller.members.setStatus({ userId: 'user-9', status: 'BANNED' as any }),
    ).rejects.toThrow()
  })
})

describe('orgRouter.members.resetPassword', () => {
  it('校验目标 user 属本企业后透传 identity.resetPassword，返回一次性密码', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'user-9', organizationId: 'org-1' })
    const caller = orgRouter.createCaller(makeCtx())

    const result = await caller.members.resetPassword({ userId: 'user-9' })

    expect(identity.resetPassword).toHaveBeenCalledWith('user-9', 'user-1')
    expect(result).toEqual({ password: 'TempPass12345' })
  })

  it('目标 user 属他企业 → FORBIDDEN，不透传 identity', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'user-9', organizationId: 'org-2' })
    const caller = orgRouter.createCaller(makeCtx())
    await expect(caller.members.resetPassword({ userId: 'user-9' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(identity.resetPassword).not.toHaveBeenCalled()
  })

  it('目标 user 不存在 → NOT_FOUND', async () => {
    prisma.user.findUnique.mockResolvedValue(null)
    const caller = orgRouter.createCaller(makeCtx())
    await expect(caller.members.resetPassword({ userId: 'user-404' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})

describe('orgRouter.members：ORG_OWNER 目标保护（终审修复：禁用/重置仅平台侧）', () => {
  it('setStatus 目标为 ORG_OWNER（含自己）→ FORBIDDEN，不透传 identity（无副作用）', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      organizationId: 'org-1',
      orgRole: 'ORG_OWNER',
    })
    const caller = orgRouter.createCaller(makeCtx())

    await expect(
      caller.members.setStatus({ userId: 'user-1', status: 'DISABLED' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('请联系平台'),
    })
    expect(identity.setStatus).not.toHaveBeenCalled()
  })

  it('resetPassword 目标为 ORG_OWNER → FORBIDDEN，不透传 identity（防企业内账号接管）', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-owner2',
      organizationId: 'org-1',
      orgRole: 'ORG_OWNER',
    })
    const caller = orgRouter.createCaller(makeCtx())

    await expect(
      caller.members.resetPassword({ userId: 'user-owner2' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('请联系平台'),
    })
    expect(identity.resetPassword).not.toHaveBeenCalled()
  })

  it('目标为 ORG_MEMBER → setStatus/resetPassword 正常（回归钉住）', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-9',
      organizationId: 'org-1',
      orgRole: 'ORG_MEMBER',
    })
    identity.setStatus.mockResolvedValue(makeUser({ id: 'user-9', status: 'DISABLED' }))
    const caller = orgRouter.createCaller(makeCtx())

    await expect(
      caller.members.setStatus({ userId: 'user-9', status: 'DISABLED' }),
    ).resolves.toEqual({ id: 'user-9', status: 'DISABLED' })
    await expect(caller.members.resetPassword({ userId: 'user-9' })).resolves.toEqual({
      password: 'TempPass12345',
    })
    expect(identity.setStatus).toHaveBeenCalledWith('user-9', 'DISABLED', 'user-1')
    expect(identity.resetPassword).toHaveBeenCalledWith('user-9', 'user-1')
  })
})

describe('orgRouter.workspaces.list', () => {
  it('ORG_MEMBER 可见（orgProcedure() 无权限门槛），数据源限定本企业（workspaceAdmin.list 收到 organizationId=本企业）', async () => {
    workspaceAdmin.list.mockResolvedValue({
      items: [adminWorkspaceView({ organization: { id: 'org-1', name: '企业A' } })],
      total: 1,
    })
    const caller = orgRouter.createCaller(ctxWithOrgRole('ORG_MEMBER'))

    const result = await caller.workspaces.list()

    expect(workspaceAdmin.list).toHaveBeenCalledWith({ organizationId: 'org-1' })
    expect(result).toEqual({
      items: [adminWorkspaceView({ organization: { id: 'org-1', name: '企业A' } })],
      total: 1,
    })
  })

  it('筛选参数透传（q/status/分页），但 organizationId 强制=本企业（zod 剥离客户端注入的他企业 id）', async () => {
    workspaceAdmin.list.mockResolvedValue({ items: [], total: 0 })
    const caller = orgRouter.createCaller(makeCtx())

    await caller.workspaces.list({
      q: 'acme',
      status: 'ACTIVE',
      page: 2,
      pageSize: 50,
      organizationId: 'org-2',
    } as any)

    expect(workspaceAdmin.list).toHaveBeenCalledWith({
      q: 'acme',
      status: 'ACTIVE',
      page: 2,
      pageSize: 50,
      organizationId: 'org-1',
    })
  })
})

describe('orgRouter.workspaces.get', () => {
  it('越权（他企业 workspaceId）→ FORBIDDEN（403），不触达 workspaceAdmin', async () => {
    prisma.workspace.findUnique.mockResolvedValue(wsRef('org-2'))
    const caller = orgRouter.createCaller(makeCtx())

    await expect(caller.workspaces.get({ workspaceId: 'ws-1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(workspaceAdmin.get).not.toHaveBeenCalled()
  })

  it('workspace 不存在 → NOT_FOUND', async () => {
    prisma.workspace.findUnique.mockResolvedValue(null)
    const caller = orgRouter.createCaller(makeCtx())
    await expect(caller.workspaces.get({ workspaceId: 'ws-x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('属本企业 → 透传 workspaceAdmin.get，返回 WorkspaceAdminView 投影 + platformSummary', async () => {
    prisma.workspace.findUnique.mockResolvedValue(wsRef('org-1'))
    workspaceAdmin.get.mockResolvedValue({
      workspace: adminWorkspaceView({ organization: { id: 'org-1', name: '企业A' } }),
      platformSummary: platformSummaryFixture,
    })
    const caller = orgRouter.createCaller(makeCtx())

    const result = await caller.workspaces.get({ workspaceId: 'ws-1' })

    expect(workspaceAdmin.get).toHaveBeenCalledWith('ws-1')
    expect(result).toEqual({
      workspace: adminWorkspaceView({ organization: { id: 'org-1', name: '企业A' } }),
      platformSummary: platformSummaryFixture,
    })
  })
})

describe('orgRouter.workspaces.getPlatformSummary', () => {
  it('越权（他企业 workspaceId）→ FORBIDDEN（403），不触达 workspaceAdmin', async () => {
    prisma.workspace.findUnique.mockResolvedValue(wsRef('org-2'))
    const caller = orgRouter.createCaller(makeCtx())

    await expect(
      caller.workspaces.getPlatformSummary({ workspaceId: 'ws-1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(workspaceAdmin.get).not.toHaveBeenCalled()
  })

  it('属本企业 → 与 workspace-admin.get 同源（复用其 getSummary），仅返回 platformSummary', async () => {
    prisma.workspace.findUnique.mockResolvedValue(wsRef('org-1'))
    workspaceAdmin.get.mockResolvedValue({
      workspace: adminWorkspaceView(),
      platformSummary: platformSummaryFixture,
    })
    const caller = orgRouter.createCaller(makeCtx())

    const result = await caller.workspaces.getPlatformSummary({ workspaceId: 'ws-1' })

    expect(workspaceAdmin.get).toHaveBeenCalledWith('ws-1')
    expect(result).toEqual(platformSummaryFixture)
  })
})

describe('orgRouter.workspaces.create', () => {
  it('ORG_MEMBER 拒（403），不触达 workspaceAdmin', async () => {
    const caller = orgRouter.createCaller(ctxWithOrgRole('ORG_MEMBER'))
    await expect(
      caller.workspaces.create({ name: '华东区', defaultBrandName: 'Acme' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(workspaceAdmin.create).not.toHaveBeenCalled()
  })

  it('ORG_OWNER：organizationId 强制=本企业透传 workspaceAdmin.create，返回 { workspace, apiKey 一次 }', async () => {
    workspaceAdmin.create.mockResolvedValue({
      workspace: adminWorkspaceView(),
      apiKey: 'zk_live_once',
    })
    const caller = orgRouter.createCaller(makeCtx())

    const result = await caller.workspaces.create({
      name: '华东区',
      defaultBrandName: 'Acme',
      domain: 'acme.com',
    })

    expect(workspaceAdmin.create).toHaveBeenCalledTimes(1)
    const [createInput, actorId] = workspaceAdmin.create.mock.calls[0]
    expect(createInput).toEqual({
      name: '华东区',
      defaultBrandName: 'Acme',
      domain: 'acme.com',
      organizationId: 'org-1',
    })
    // 物理排除：组织二选一字段绝不透传（organizationId 由 actor 派生，不走现场建组织）
    expect(createInput).not.toHaveProperty('newOrganizationName')
    expect(actorId).toBe('user-1')
    expect(result).toEqual({ workspace: adminWorkspaceView(), apiKey: 'zk_live_once' })
  })

  it('zod 物理排除组织二选一字段：newOrganizationName/organizationId → BAD_REQUEST，不触达 workspaceAdmin', async () => {
    const caller = orgRouter.createCaller(makeCtx())
    await expect(
      caller.workspaces.create({
        name: '华东区',
        defaultBrandName: 'Acme',
        newOrganizationName: '现场新建企业',
      } as any),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      caller.workspaces.create({
        name: '华东区',
        defaultBrandName: 'Acme',
        organizationId: 'org-2',
      } as any),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(workspaceAdmin.create).not.toHaveBeenCalled()
  })

  it('name/defaultBrandName 必填：缺失 → zod 拒绝', async () => {
    const caller = orgRouter.createCaller(makeCtx())
    await expect(
      caller.workspaces.create({ name: '', defaultBrandName: 'Acme' }),
    ).rejects.toThrow()
    await expect(caller.workspaces.create({ name: '华东区' } as any)).rejects.toThrow()
    expect(workspaceAdmin.create).not.toHaveBeenCalled()
  })

  it('任务 9：workspaceAdmin.create 的配额硬拒（QuotaExceededError）经 org 链路如实上抛', async () => {
    const quotaError = new Error('配额超限：企业 org-1 的 maxWorkspaces 上限 3，当前 3（QUOTA_EXCEEDED）')
    quotaError.name = 'QUOTA_EXCEEDED'
    workspaceAdmin.create.mockRejectedValue(quotaError)
    const caller = orgRouter.createCaller(makeCtx())

    await expect(
      caller.workspaces.create({ name: '华东区', defaultBrandName: 'Acme' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('QUOTA_EXCEEDED') })
    expect(workspaceAdmin.create).toHaveBeenCalledTimes(1)
  })
})

describe('orgRouter.workspaces.update', () => {
  it('越权（他企业 workspaceId）→ FORBIDDEN（403），不透传 workspaceAdmin', async () => {
    prisma.workspace.findUnique.mockResolvedValue(wsRef('org-2'))
    const caller = orgRouter.createCaller(makeCtx())

    await expect(
      caller.workspaces.update({ workspaceId: 'ws-1', name: '新名' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(workspaceAdmin.update).not.toHaveBeenCalled()
  })

  it('属本企业 → 透传 workspaceAdmin.update（workspaceId, patch, actorId）', async () => {
    prisma.workspace.findUnique.mockResolvedValue(wsRef('org-1'))
    workspaceAdmin.update.mockResolvedValue(adminWorkspaceView({ name: '新名' }))
    const caller = orgRouter.createCaller(makeCtx())

    const result = await caller.workspaces.update({
      workspaceId: 'ws-1',
      name: '新名',
      domain: 'new.acme.com',
    })

    expect(workspaceAdmin.update).toHaveBeenCalledWith(
      'ws-1',
      { name: '新名', domain: 'new.acme.com' },
      'user-1',
    )
    expect(result).toEqual(adminWorkspaceView({ name: '新名' }))
  })
})

describe('orgRouter.workspaces.setCompetitors', () => {
  it('越权（他企业 workspaceId）→ FORBIDDEN（403），不透传 workspaceAdmin', async () => {
    prisma.workspace.findUnique.mockResolvedValue(wsRef('org-2'))
    const caller = orgRouter.createCaller(makeCtx())

    await expect(
      caller.workspaces.setCompetitors({ workspaceId: 'ws-1', competitors: ['beta.com'] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(workspaceAdmin.setCompetitors).not.toHaveBeenCalled()
  })

  it('属本企业 → 透传 workspaceAdmin.setCompetitors（workspaceId, competitors, actorId）', async () => {
    prisma.workspace.findUnique.mockResolvedValue(wsRef('org-1'))
    workspaceAdmin.setCompetitors.mockResolvedValue(adminWorkspaceView())
    const caller = orgRouter.createCaller(makeCtx())

    const result = await caller.workspaces.setCompetitors({
      workspaceId: 'ws-1',
      competitors: ['beta.com', 'gamma.com'],
    })

    expect(workspaceAdmin.setCompetitors).toHaveBeenCalledWith(
      'ws-1',
      ['beta.com', 'gamma.com'],
      'user-1',
    )
    expect(result).toEqual(adminWorkspaceView())
  })
})

describe('orgRouter.workspaces.setPlatformCredentials', () => {
  it('越权（他企业 workspaceId）→ FORBIDDEN（403），不透传 workspaceAdmin', async () => {
    prisma.workspace.findUnique.mockResolvedValue(wsRef('org-2'))
    const caller = orgRouter.createCaller(makeCtx())

    await expect(
      caller.workspaces.setPlatformCredentials({
        workspaceId: 'ws-1',
        platform: 'deepseek',
        values: { apiKey: 'sk-x' },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(workspaceAdmin.setPlatformCredentials).not.toHaveBeenCalled()
  })

  it('属本企业 → 透传 workspaceAdmin.setPlatformCredentials（workspaceId, platform, values, actorId）', async () => {
    prisma.workspace.findUnique.mockResolvedValue(wsRef('org-1'))
    workspaceAdmin.setPlatformCredentials.mockResolvedValue(adminWorkspaceView())
    const caller = orgRouter.createCaller(makeCtx())

    const result = await caller.workspaces.setPlatformCredentials({
      workspaceId: 'ws-1',
      platform: 'deepseek',
      values: { apiKey: 'sk-x' },
    })

    expect(workspaceAdmin.setPlatformCredentials).toHaveBeenCalledWith(
      'ws-1',
      'deepseek',
      { apiKey: 'sk-x' },
      'user-1',
    )
    expect(result).toEqual(adminWorkspaceView())
  })

  it('输入形状与 admin 版一致：platform 空串 / competitors 空串元素 → zod 拒绝', async () => {
    const caller = orgRouter.createCaller(makeCtx())
    await expect(
      caller.workspaces.setPlatformCredentials({
        workspaceId: 'ws-1',
        platform: '',
        values: {},
      }),
    ).rejects.toThrow()
    await expect(
      caller.workspaces.setCompetitors({ workspaceId: 'ws-1', competitors: [''] }),
    ).rejects.toThrow()
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled()
  })
})

describe('orgRouter.credentials.list', () => {
  it('ORG_MEMBER 可见（orgProcedure() 无权限门槛）：workspace 属本企业 → 透传 credentials.list，返回脱敏列表', async () => {
    prisma.workspace.findUnique.mockResolvedValue(wsRef('org-1'))
    credentials.list.mockResolvedValue([credentialSummary()])
    const caller = orgRouter.createCaller(ctxWithOrgRole('ORG_MEMBER'))

    const result = await caller.credentials.list({ workspaceId: 'ws-1' })

    expect(credentials.list).toHaveBeenCalledWith('ws-1')
    expect(result).toEqual([credentialSummary()])
  })

  it('越权（他企业 workspaceId）→ FORBIDDEN（403），不触达 credentials.list', async () => {
    prisma.workspace.findUnique.mockResolvedValue(wsRef('org-2'))
    const caller = orgRouter.createCaller(makeCtx())

    await expect(caller.credentials.list({ workspaceId: 'ws-1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(credentials.list).not.toHaveBeenCalled()
  })

  it('workspace 不存在 → NOT_FOUND', async () => {
    prisma.workspace.findUnique.mockResolvedValue(null)
    const caller = orgRouter.createCaller(makeCtx())
    await expect(caller.credentials.list({ workspaceId: 'ws-x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})

describe('orgRouter.credentials.issue', () => {
  it('属本企业 → 透传 credentials.issue(workspaceId, name, createdById=操作者)，返回脱敏 credential + 一次性明文', async () => {
    prisma.workspace.findUnique.mockResolvedValue(wsRef('org-1'))
    credentials.issue.mockResolvedValue({
      credential: credentialRow({ name: '备份 Key' }),
      plaintext: 'geo_once_plaintext',
    })
    const caller = orgRouter.createCaller(makeCtx())

    const result = await caller.credentials.issue({ workspaceId: 'ws-1', name: '备份 Key' })

    expect(credentials.issue).toHaveBeenCalledWith('ws-1', '备份 Key', 'user-1')
    expect(result.plaintext).toBe('geo_once_plaintext')
    expect(result.credential).toEqual(credentialSummary({ name: '备份 Key' }))
    // 红线：keyHash 不出 service 边界
    expect(result.credential).not.toHaveProperty('keyHash')
  })

  it('越权（他企业 workspaceId）→ FORBIDDEN（403），不签发', async () => {
    prisma.workspace.findUnique.mockResolvedValue(wsRef('org-2'))
    const caller = orgRouter.createCaller(makeCtx())

    await expect(
      caller.credentials.issue({ workspaceId: 'ws-1', name: '备份 Key' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(credentials.issue).not.toHaveBeenCalled()
  })

  it('name 边界：空串 / 超 100 字符 → zod 拒绝，不触达 credentials', async () => {
    const caller = orgRouter.createCaller(makeCtx())
    await expect(
      caller.credentials.issue({ workspaceId: 'ws-1', name: '' }),
    ).rejects.toThrow()
    await expect(
      caller.credentials.issue({ workspaceId: 'ws-1', name: 'k'.repeat(101) }),
    ).rejects.toThrow()
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled()
    expect(credentials.issue).not.toHaveBeenCalled()
  })
})

describe('orgRouter.credentials.revoke', () => {
  it('凭证不存在 → NOT_FOUND，不触达 revoke 不审计', async () => {
    prisma.apiCredential.findUnique.mockResolvedValue(null)
    const caller = orgRouter.createCaller(makeCtx())

    await expect(caller.credentials.revoke({ credentialId: 'cred-x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(credentials.revoke).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('越权（credential 属他企业 workspace）→ FORBIDDEN（403），不触达 revoke 不审计', async () => {
    prisma.apiCredential.findUnique.mockResolvedValue({ id: 'cred-1', workspaceId: 'ws-1' })
    prisma.workspace.findUnique.mockResolvedValue(wsRef('org-2'))
    const caller = orgRouter.createCaller(makeCtx())

    await expect(caller.credentials.revoke({ credentialId: 'cred-1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(credentials.revoke).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('属本企业 → 越权校验后透传 credentials.revoke(credentialId, actorId) + audit credential.revoke', async () => {
    prisma.apiCredential.findUnique.mockResolvedValue({ id: 'cred-1', workspaceId: 'ws-1' })
    prisma.workspace.findUnique.mockResolvedValue(wsRef('org-1'))
    credentials.revoke.mockResolvedValue(1)
    const caller = orgRouter.createCaller(makeCtx())

    const result = await caller.credentials.revoke({ credentialId: 'cred-1' })

    expect(credentials.revoke).toHaveBeenCalledWith('cred-1', 'user-1')
    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'user-1',
      actorType: 'USER',
      action: 'credential.revoke',
      organizationId: 'org-1',
      workspaceId: 'ws-1',
      target: 'ApiCredential:cred-1',
    })
    expect(result).toEqual({ ok: true })
  })

  it('已吊销（service 抛 API_CREDENTIAL_NOT_REVOKABLE）→ CONFLICT，不审计', async () => {
    prisma.apiCredential.findUnique.mockResolvedValue({ id: 'cred-1', workspaceId: 'ws-1' })
    prisma.workspace.findUnique.mockResolvedValue(wsRef('org-1'))
    credentials.revoke.mockRejectedValue(new ApiCredentialNotRevokableError('cred-1'))
    const caller = orgRouter.createCaller(makeCtx())

    await expect(caller.credentials.revoke({ credentialId: 'cred-1' })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(credentials.revoke).toHaveBeenCalledWith('cred-1', 'user-1')
    expect(audit.record).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// M2 §3.0：org.workspaces.update 保存 N 时的配额硬检查（monitorSampleCountMax 生效点一）
// ---------------------------------------------------------------------------

describe('orgRouter.workspaces.update × monitorSampleCountMax（生效点一）', () => {
  function quotaBilling(declared: number | undefined) {
    return {
      guard: {
        checkMonitorSampleCountMax: vi.fn(async (_orgId: string, requested: number) => {
          if (declared === undefined) return
          if (requested > declared) {
            throw new QuotaExceededError({
              field: 'monitorSampleCountMax',
              limit: declared,
              current: requested,
              organizationId: 'org-1',
            })
          }
        }),
      },
      meter: {},
    } as any
  }

  function ctxWithBilling(declared: number | undefined) {
    const ctx = ctxWithOrgRole('ORG_OWNER')
    prisma.workspace.findUnique.mockResolvedValue(wsRef('org-1'))
    workspaceAdmin.update.mockResolvedValue(adminWorkspaceView())
    ctx.services.billing = quotaBilling(declared)
    return ctx
  }

  it('TRIAL org（声明 3）保存 monitorSampleCount=5 → 拒，且不落到 workspaceAdmin.update', async () => {
    const ctx = ctxWithBilling(3)
    const caller = orgRouter.createCaller(ctx)
    await expect(
      caller.workspaces.update({ workspaceId: 'ws-1', monitorSampleCount: 5 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('超出套餐上限') })
    expect(ctx.services.billing.guard.checkMonitorSampleCountMax).toHaveBeenCalledWith('org-1', 5)
    expect(workspaceAdmin.update).not.toHaveBeenCalled()
  })

  it('声明 3 保存 3 → 放行', async () => {
    const ctx = ctxWithBilling(3)
    const caller = orgRouter.createCaller(ctx)
    await caller.workspaces.update({ workspaceId: 'ws-1', monitorSampleCount: 3 })
    expect(workspaceAdmin.update).toHaveBeenCalled()
    expect(workspaceAdmin.update).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ monitorSampleCount: 3 }),
      expect.any(String),
    )
  })

  it('键缺失（未声明上限）→ 保存 10 放行', async () => {
    const ctx = ctxWithBilling(undefined)
    const caller = orgRouter.createCaller(ctx)
    await caller.workspaces.update({ workspaceId: 'ws-1', monitorSampleCount: 10 })
    expect(workspaceAdmin.update).toHaveBeenCalled()
  })

  it('不带 monitorSampleCount 的更新不触发配额检查', async () => {
    const ctx = ctxWithBilling(3)
    const caller = orgRouter.createCaller(ctx)
    await caller.workspaces.update({ workspaceId: 'ws-1', name: '新名字' })
    expect(ctx.services.billing.guard.checkMonitorSampleCountMax).not.toHaveBeenCalled()
    expect(workspaceAdmin.update).toHaveBeenCalled()
  })
})
