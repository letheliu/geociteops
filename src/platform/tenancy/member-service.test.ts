import { describe, expect, it, vi } from 'vitest'
import { createMemberService, synthesize } from './member-service.js'

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    username: 'owner',
    displayName: '企业主',
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
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  }
}

function makeMember(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: 'ws-1',
    userId: 'u1',
    access: 'OPERATE',
    isPrimary: false,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  }
}

function makePrisma(opts: {
  user?: Record<string, unknown> | null
  member?: Record<string, unknown> | null
  members?: Record<string, unknown>[]
  users?: Record<string, unknown>[]
} = {}) {
  return {
    user: {
      findUnique: vi.fn(async () => (opts.user === undefined ? null : opts.user)),
      findMany: vi.fn(async () => opts.users ?? []),
    },
    workspaceMember: {
      findUnique: vi.fn(async () => (opts.member === undefined ? null : opts.member)),
      findMany: vi.fn(async () => opts.members ?? []),
      upsert: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
  } as any
}

/** resolveAccess 的最小 workspace 形状（id + organizationId） */
const WS = { id: 'ws-1', organizationId: 'org-1' }

describe('synthesize（规格 §2.2：最终权限 = min(企业角色上限, WorkspaceMember.access)）', () => {
  // 4×4 全矩阵穷举：orgRole × memberAccess
  it.each([
    ['ORG_OWNER', 'MANAGE', 'MANAGE'],
    ['ORG_OWNER', 'OPERATE', 'MANAGE'],
    ['ORG_OWNER', 'VIEW', 'MANAGE'],
    ['ORG_OWNER', null, 'MANAGE'],
    ['ORG_MEMBER', 'MANAGE', 'MANAGE'],
    ['ORG_MEMBER', 'OPERATE', 'OPERATE'],
    ['ORG_MEMBER', 'VIEW', 'VIEW'],
    ['ORG_MEMBER', null, null],
    ['ORG_VIEWER', 'MANAGE', 'VIEW'],
    ['ORG_VIEWER', 'OPERATE', 'VIEW'],
    ['ORG_VIEWER', 'VIEW', 'VIEW'],
    ['ORG_VIEWER', null, null],
    [null, 'MANAGE', null],
    [null, 'OPERATE', null],
    [null, 'VIEW', null],
    [null, null, null],
  ])('synthesize(%s, %s) → %s', (orgRole, memberAccess, expected) => {
    expect(synthesize(orgRole as any, memberAccess as any)).toBe(expected)
  })

  it('ORG_VIEWER 即使被授予 OPERATE/MANAGE 也降为 VIEW（规格 §2.2 逐字）', () => {
    expect(synthesize('ORG_VIEWER', 'OPERATE')).toBe('VIEW')
    expect(synthesize('ORG_VIEWER', 'MANAGE')).toBe('VIEW')
  })

  it('ORG_OWNER 无需记录即 MANAGE；ORG_MEMBER 无记录则无权限', () => {
    expect(synthesize('ORG_OWNER', null)).toBe('MANAGE')
    expect(synthesize('ORG_MEMBER', null)).toBeNull()
  })

  it('无企业角色（null/undefined）一律 null', () => {
    expect(synthesize(null, 'MANAGE')).toBeNull()
    expect(synthesize(undefined, 'VIEW')).toBeNull()
  })
})

describe('memberService.resolveAccess', () => {
  it('ORG_OWNER 传入：直接 MANAGE，不查 WorkspaceMember（无需记录）', async () => {
    const prisma = makePrisma({ user: makeUser({ orgRole: 'ORG_OWNER' }) })
    const service = createMemberService(prisma)
    const access = await service.resolveAccess('u1', WS, 'ORG_OWNER')
    expect(access).toBe('MANAGE')
    expect(prisma.workspaceMember.findUnique).not.toHaveBeenCalled()
  })

  it('ORG_MEMBER 传入：返回 WorkspaceMember.access 原值（复合主键查询形状）', async () => {
    const prisma = makePrisma({
      user: makeUser({ orgRole: 'ORG_MEMBER' }),
      member: makeMember({ access: 'OPERATE' }),
    })
    const service = createMemberService(prisma)
    const access = await service.resolveAccess('u1', WS, 'ORG_MEMBER')
    expect(access).toBe('OPERATE')
    expect(prisma.workspaceMember.findUnique).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: 'ws-1', userId: 'u1' } },
    })
  })

  it('ORG_MEMBER 传入且无记录：null', async () => {
    const prisma = makePrisma({ user: makeUser({ orgRole: 'ORG_MEMBER' }), member: null })
    const service = createMemberService(prisma)
    const access = await service.resolveAccess('u1', WS, 'ORG_MEMBER')
    expect(access).toBeNull()
  })

  it('ORG_VIEWER 传入 + 记录 MANAGE：仍降为 VIEW（min 合成）', async () => {
    const prisma = makePrisma({
      user: makeUser({ orgRole: 'ORG_VIEWER' }),
      member: makeMember({ access: 'MANAGE' }),
    })
    const service = createMemberService(prisma)
    const access = await service.resolveAccess('u1', WS, 'ORG_VIEWER')
    expect(access).toBe('VIEW')
  })

  it('ORG_VIEWER 传入且无记录：null', async () => {
    const prisma = makePrisma({ user: makeUser({ orgRole: 'ORG_VIEWER' }), member: null })
    const service = createMemberService(prisma)
    const access = await service.resolveAccess('u1', WS, 'ORG_VIEWER')
    expect(access).toBeNull()
  })

  it('orgRole 缺省：查 user（select userType/organizationId/orgRole）并用库中角色合成', async () => {
    const prisma = makePrisma({
      user: makeUser({ orgRole: 'ORG_VIEWER' }),
      member: makeMember({ access: 'MANAGE' }),
    })
    const service = createMemberService(prisma)
    const access = await service.resolveAccess('u1', WS)
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: { userType: true, organizationId: true, orgRole: true },
    })
    expect(access).toBe('VIEW')
  })

  it('orgRole 缺省 + ORG_MEMBER + 记录 OPERATE：OPERATE', async () => {
    const prisma = makePrisma({
      user: makeUser({ orgRole: 'ORG_MEMBER' }),
      member: makeMember({ access: 'OPERATE' }),
    })
    const service = createMemberService(prisma)
    const access = await service.resolveAccess('u1', WS)
    expect(access).toBe('OPERATE')
  })

  it('跨企业拒（orgRole 传入路径）：workspace.organizationId ≠ user.organizationId → null，不查记录', async () => {
    const prisma = makePrisma({ user: makeUser({ orgRole: 'ORG_OWNER' }) })
    const service = createMemberService(prisma)
    const access = await service.resolveAccess('u1', { id: 'ws-1', organizationId: 'org-2' }, 'ORG_OWNER')
    expect(access).toBeNull()
    expect(prisma.workspaceMember.findUnique).not.toHaveBeenCalled()
  })

  it('跨企业拒（orgRole 缺省路径）：user 无 organizationId → null', async () => {
    const prisma = makePrisma({ user: makeUser({ organizationId: null, orgRole: 'ORG_MEMBER' }) })
    const service = createMemberService(prisma)
    const access = await service.resolveAccess('u1', WS)
    expect(access).toBeNull()
    expect(prisma.workspaceMember.findUnique).not.toHaveBeenCalled()
  })

  it('PLATFORM 用户：返回 null（平台语义分治由调用方做），不查记录', async () => {
    const prisma = makePrisma({
      user: makeUser({ userType: 'PLATFORM', organizationId: 'org-1', orgRole: null }),
    })
    const service = createMemberService(prisma)
    const access = await service.resolveAccess('u1', WS)
    expect(access).toBeNull()
    expect(prisma.workspaceMember.findUnique).not.toHaveBeenCalled()
  })

  it('用户不存在：null', async () => {
    const prisma = makePrisma({ user: null })
    const service = createMemberService(prisma)
    const access = await service.resolveAccess('u-missing', WS, 'ORG_MEMBER')
    expect(access).toBeNull()
  })

  it('CUSTOMER 但 orgRole 为空且未传入：null', async () => {
    const prisma = makePrisma({ user: makeUser({ orgRole: null }) })
    const service = createMemberService(prisma)
    const access = await service.resolveAccess('u1', WS)
    expect(access).toBeNull()
  })
})

describe('memberService.listMembers', () => {
  it('workspaceMember.findMany + 手动 join user（无 FK relation），返回 { user, access, isPrimary }', async () => {
    const prisma = makePrisma({
      members: [
        makeMember({ userId: 'u1', access: 'MANAGE', isPrimary: false }),
        makeMember({ userId: 'u2', access: 'VIEW', isPrimary: true }),
      ],
      users: [
        { id: 'u1', username: 'owner', displayName: '企业主' },
        { id: 'u2', username: 'viewer', displayName: '访客' },
      ],
    })
    const service = createMemberService(prisma)
    const items = await service.listMembers('ws-1')
    expect(prisma.workspaceMember.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1' },
      orderBy: { createdAt: 'asc' },
    })
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['u1', 'u2'] } },
      select: { id: true, username: true, displayName: true },
    })
    expect(items).toEqual([
      { user: { id: 'u1', username: 'owner', displayName: '企业主' }, access: 'MANAGE', isPrimary: false },
      { user: { id: 'u2', username: 'viewer', displayName: '访客' }, access: 'VIEW', isPrimary: true },
    ])
  })

  it('孤儿记录（引用的用户已物理删除）跳过', async () => {
    const prisma = makePrisma({
      members: [makeMember({ userId: 'u-gone' })],
      users: [],
    })
    const service = createMemberService(prisma)
    const items = await service.listMembers('ws-1')
    expect(items).toEqual([])
  })

  it('空成员列表：不查 user', async () => {
    const prisma = makePrisma({ members: [] })
    const service = createMemberService(prisma)
    const items = await service.listMembers('ws-1')
    expect(items).toEqual([])
    expect(prisma.user.findMany).not.toHaveBeenCalled()
  })
})

describe('memberService.listByUser', () => {
  it('where { userId }，投影 { workspaceId, access, isPrimary }', async () => {
    const prisma = makePrisma({
      members: [
        makeMember({ userId: 'u1', workspaceId: 'ws-1', access: 'OPERATE', isPrimary: true }),
        makeMember({ userId: 'u1', workspaceId: 'ws-2', access: 'VIEW', isPrimary: false }),
      ],
    })
    const service = createMemberService(prisma)
    const items = await service.listByUser('u1')
    expect(prisma.workspaceMember.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      orderBy: { createdAt: 'asc' },
    })
    expect(items).toEqual([
      { workspaceId: 'ws-1', access: 'OPERATE', isPrimary: true },
      { workspaceId: 'ws-2', access: 'VIEW', isPrimary: false },
    ])
  })
})

describe('memberService.hasAssignment', () => {
  it('复合主键直查：有 WorkspaceMember 记录 → true', async () => {
    const prisma = makePrisma({ member: makeMember() })
    const service = createMemberService(prisma)
    const hit = await service.hasAssignment('u1', 'ws-1')
    expect(prisma.workspaceMember.findUnique).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: 'ws-1', userId: 'u1' } },
    })
    expect(hit).toBe(true)
  })

  it('无记录 → false（OPERATOR 无分配：context 授权分治据此留空 workspace）', async () => {
    const prisma = makePrisma({ member: null })
    const service = createMemberService(prisma)
    const hit = await service.hasAssignment('u1', 'ws-1')
    expect(hit).toBe(false)
  })
})

describe('memberService.resolveForUser', () => {
  it('批量合成：查 user orgRole + listByUser + synthesize map（避免逐 ws N+1）', async () => {
    const prisma = makePrisma({
      user: makeUser({ orgRole: 'ORG_MEMBER' }),
      members: [
        makeMember({ userId: 'u1', workspaceId: 'ws-1', access: 'OPERATE' }),
        makeMember({ userId: 'u1', workspaceId: 'ws-2', access: 'MANAGE' }),
      ],
    })
    const service = createMemberService(prisma)
    const items = await service.resolveForUser('u1')
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: { userType: true, orgRole: true },
    })
    expect(prisma.workspaceMember.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      orderBy: { createdAt: 'asc' },
    })
    expect(items).toEqual([
      { workspaceId: 'ws-1', access: 'OPERATE' },
      { workspaceId: 'ws-2', access: 'MANAGE' },
    ])
  })

  it('ORG_VIEWER：批量降为 VIEW（min 合成）', async () => {
    const prisma = makePrisma({
      user: makeUser({ orgRole: 'ORG_VIEWER' }),
      members: [
        makeMember({ userId: 'u1', workspaceId: 'ws-1', access: 'MANAGE' }),
        makeMember({ userId: 'u1', workspaceId: 'ws-2', access: 'OPERATE' }),
      ],
    })
    const service = createMemberService(prisma)
    const items = await service.resolveForUser('u1')
    expect(items).toEqual([
      { workspaceId: 'ws-1', access: 'VIEW' },
      { workspaceId: 'ws-2', access: 'VIEW' },
    ])
  })

  it('ORG_OWNER：member 记录合成为 MANAGE（OWNER 全量授权不经记录，调用方走本企业全量路径）', async () => {
    const prisma = makePrisma({
      user: makeUser({ orgRole: 'ORG_OWNER' }),
      members: [makeMember({ userId: 'u1', workspaceId: 'ws-1', access: 'VIEW' })],
    })
    const service = createMemberService(prisma)
    const items = await service.resolveForUser('u1')
    expect(items).toEqual([{ workspaceId: 'ws-1', access: 'MANAGE' }])
  })

  it('PLATFORM 用户 / 用户不存在 / 无 orgRole：空数组且不查 member（客户语义专用）', async () => {
    const platform = makePrisma({ user: makeUser({ userType: 'PLATFORM', orgRole: null }) })
    expect(await createMemberService(platform).resolveForUser('u1')).toEqual([])
    expect(platform.workspaceMember.findMany).not.toHaveBeenCalled()

    const missing = makePrisma({ user: null })
    expect(await createMemberService(missing).resolveForUser('u1')).toEqual([])
    expect(missing.workspaceMember.findMany).not.toHaveBeenCalled()

    const noRole = makePrisma({ user: makeUser({ orgRole: null }) })
    expect(await createMemberService(noRole).resolveForUser('u1')).toEqual([])
    expect(noRole.workspaceMember.findMany).not.toHaveBeenCalled()
  })

  it('无 member 记录：空数组', async () => {
    const prisma = makePrisma({ user: makeUser({ orgRole: 'ORG_MEMBER' }), members: [] })
    const service = createMemberService(prisma)
    expect(await service.resolveForUser('u1')).toEqual([])
  })
})

describe('memberService.upsert', () => {
  it('复合主键 where + create 全量 + update 仅 access', async () => {
    const prisma = makePrisma()
    const service = createMemberService(prisma)
    await service.upsert('ws-1', 'u1', 'OPERATE')
    expect(prisma.workspaceMember.upsert).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: 'ws-1', userId: 'u1' } },
      create: { workspaceId: 'ws-1', userId: 'u1', access: 'OPERATE' },
      update: { access: 'OPERATE' },
    })
  })
})

describe('memberService.remove', () => {
  it('物理删除：delete 复合主键记录', async () => {
    const prisma = makePrisma()
    const service = createMemberService(prisma)
    await service.remove('ws-1', 'u1')
    expect(prisma.workspaceMember.delete).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: 'ws-1', userId: 'u1' } },
    })
  })
})

describe('memberService.listOrgMembers', () => {
  it('user 表 where organizationId，select 含 orgRole/status/lastLoginAt，返回 { user } 无 access 字段', async () => {
    const lastLoginAt = new Date('2026-10-10T08:00:00.000Z')
    const prisma = makePrisma({
      users: [
        {
          id: 'u1',
          username: 'owner',
          displayName: '企业主',
          orgRole: 'ORG_OWNER',
          status: 'ACTIVE',
          lastLoginAt,
        },
      ],
    })
    const service = createMemberService(prisma)
    const items = await service.listOrgMembers('org-1')
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      select: {
        id: true,
        username: true,
        displayName: true,
        orgRole: true,
        status: true,
        lastLoginAt: true,
      },
      orderBy: { createdAt: 'asc' },
    })
    expect(items).toEqual([
      {
        user: {
          id: 'u1',
          username: 'owner',
          displayName: '企业主',
          orgRole: 'ORG_OWNER',
          status: 'ACTIVE',
          lastLoginAt,
        },
      },
    ])
    expect('access' in items[0]).toBe(false)
  })
})
