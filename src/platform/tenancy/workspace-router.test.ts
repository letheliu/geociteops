import { describe, expect, it, vi, beforeEach } from 'vitest'
import { adminWorkspaceRouter } from './workspace-router.js'
import {
  WorkspaceNotFoundError,
  WorkspaceTransitionError,
  OperatorNotEligibleError,
  OperatorAssignmentNotFoundError,
  createWorkspaceAdminService,
} from './workspace-admin.js'
import { createMemberService } from './member-service.js'

function makeService() {
  return {
    list: vi.fn(async () => ({
      items: [{ id: 'ws-1', name: '客户工作区', organization: { id: 'org-1', name: 'Acme' } }],
      total: 1,
    })),
    get: vi.fn(async () => ({
      workspace: { id: 'ws-1', name: '客户工作区', organization: { id: 'org-1', name: 'Acme' } },
      platformSummary: {
        competitors: ['figma.com'],
        platforms: { deepseek: { configured: true, hint: 'b12c' } },
      },
    })),
    create: vi.fn(async () => ({ workspace: { id: 'ws-new' }, apiKey: 'geo_plain_once' })),
    update: vi.fn(async () => ({ id: 'ws-1', name: '新名' })),
    setPlatformCredentials: vi.fn(async () => ({ id: 'ws-1' })),
    setCompetitors: vi.fn(async () => ({ id: 'ws-1' })),
    suspend: vi.fn(async () => ({ id: 'ws-1', status: 'SUSPENDED' })),
    resume: vi.fn(async () => ({ id: 'ws-1', status: 'ACTIVE' })),
    archive: vi.fn(async () => ({ id: 'ws-1', status: 'ARCHIVED' })),
    transfer: vi.fn(async () => ({ id: 'ws-1' })),
    enter: vi.fn(async () => ({ ok: true as const })),
    assignOperator: vi.fn(async () => ({ ok: true as const })),
    unassignOperator: vi.fn(async () => ({ ok: true as const })),
    listOperators: vi.fn(async () => [
      { user: { id: 'user-op', username: 'op1', displayName: '顾问一号' }, isPrimary: true },
    ]),
  }
}

let svc: ReturnType<typeof makeService>

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    actor: {
      kind: 'user',
      user: {
        id: 'user-1',
        userType: 'PLATFORM',
        platformRole: 'SUPER_ADMIN',
        mustChangePassword: false,
      },
      session: { id: 'sess-1' },
    },
    requestMeta: {
      ip: '1.2.3.4',
      requestId: 'req-1',
      method: 'GET',
      headers: { 'x-geo-csrf': 'test' },
    },
    services: { workspaceAdmin: svc },
    ...overrides,
  } as any
}

function ctxWithRole(platformRole: string | null) {
  return makeCtx({
    actor: {
      kind: 'user',
      user: { id: 'user-1', userType: 'PLATFORM', platformRole, mustChangePassword: false },
      session: { id: 'sess-1' },
    },
  })
}

beforeEach(() => {
  svc = makeService()
})

describe('adminWorkspaceRouter：权限矩阵（platformProcedure）', () => {
  it('无 platformRole（客户用户）→ FORBIDDEN，不触达 service', async () => {
    const caller = adminWorkspaceRouter.createCaller(ctxWithRole(null))
    await expect(caller.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(svc.list).not.toHaveBeenCalled()
  })

  it('SUPPORT（P0 无后台入口）→ 全端点 FORBIDDEN', async () => {
    const caller = adminWorkspaceRouter.createCaller(ctxWithRole('SUPPORT'))
    const calls = [
      () => caller.list(),
      () => caller.get({ workspaceId: 'ws-1' }),
      () =>
        caller.create({ name: 'w', defaultBrandName: 'b', organizationId: 'org-1' }),
      () => caller.update({ workspaceId: 'ws-1', name: 'n' }),
      () => caller.suspend({ workspaceId: 'ws-1' }),
      () => caller.resume({ workspaceId: 'ws-1' }),
      () => caller.archive({ workspaceId: 'ws-1' }),
      () => caller.transfer({ workspaceId: 'ws-1', targetOrganizationId: 'org-2' }),
      () =>
        caller.setPlatformCredentials({
          workspaceId: 'ws-1',
          platform: 'qwen',
          values: { QWEN_API_KEY: 'sk' },
        }),
      () => caller.setCompetitors({ workspaceId: 'ws-1', competitors: ['a.com'] }),
      () => caller.enter({ workspaceId: 'ws-1' }),
      () => caller.assignOperator({ workspaceId: 'ws-1', userId: 'user-op' }),
      () => caller.unassignOperator({ workspaceId: 'ws-1', userId: 'user-op' }),
      () => caller.listOperators({ workspaceId: 'ws-1' }),
    ]
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    for (const fn of Object.values(svc)) {
      expect(fn).not.toHaveBeenCalled()
    }
  })

  it('OPERATOR：workspace.manage（list/create/suspend）过、credential.write（setPlatformCredentials）过、workspace.enter（enter）过', async () => {
    const caller = adminWorkspaceRouter.createCaller(ctxWithRole('OPERATOR'))
    await expect(caller.list()).resolves.toMatchObject({ total: 1 })
    await expect(
      caller.create({ name: 'w', defaultBrandName: 'b', organizationId: 'org-1' }),
    ).resolves.toMatchObject({ apiKey: 'geo_plain_once' })
    await expect(caller.suspend({ workspaceId: 'ws-1' })).resolves.toMatchObject({
      status: 'SUSPENDED',
    })
    await expect(
      caller.setPlatformCredentials({
        workspaceId: 'ws-1',
        platform: 'qwen',
        values: { QWEN_API_KEY: 'sk' },
      }),
    ).resolves.toBeTruthy()
    await expect(caller.enter({ workspaceId: 'ws-1' })).resolves.toEqual({ ok: true })
  })
})

describe('adminWorkspaceRouter.list', () => {
  it('透传过滤与分页；无入参走空对象', async () => {
    const caller = adminWorkspaceRouter.createCaller(makeCtx())
    await caller.list({ q: 'acme', status: 'SUSPENDED', organizationId: 'org-9', page: 2, pageSize: 10 })
    expect(svc.list).toHaveBeenCalledWith({
      q: 'acme',
      status: 'SUSPENDED',
      organizationId: 'org-9',
      page: 2,
      pageSize: 10,
    })
    await caller.list()
    expect(svc.list).toHaveBeenLastCalledWith({})
  })

  it('status 非法值 → zod 拒绝', async () => {
    const caller = adminWorkspaceRouter.createCaller(makeCtx())
    await expect(caller.list({ status: 'BANNED' as any })).rejects.toThrow()
    expect(svc.list).not.toHaveBeenCalled()
  })

  it('pageSize 超 100 → zod 拒绝', async () => {
    const caller = adminWorkspaceRouter.createCaller(makeCtx())
    await expect(caller.list({ pageSize: 101 })).rejects.toThrow()
    expect(svc.list).not.toHaveBeenCalled()
  })
})

describe('adminWorkspaceRouter.create', () => {
  it('透传字段并携带 actorId=ctx.actor.user.id，返回一次性 apiKey', async () => {
    const caller = adminWorkspaceRouter.createCaller(makeCtx())
    const result = await caller.create({
      name: '新工作区',
      defaultBrandName: '品牌',
      domain: 'acme.com',
      organizationId: 'org-1',
    })
    expect(svc.create).toHaveBeenCalledWith(
      {
        name: '新工作区',
        defaultBrandName: '品牌',
        domain: 'acme.com',
        organizationId: 'org-1',
        newOrganizationName: undefined,
        llmsTxtUrl: undefined,
      },
      'user-1',
    )
    expect(result.apiKey).toBe('geo_plain_once')
  })

  it('组织来源两个都传 → zod refine 拒绝，不触达 service', async () => {
    const caller = adminWorkspaceRouter.createCaller(makeCtx())
    await expect(
      caller.create({
        name: 'w',
        defaultBrandName: 'b',
        organizationId: 'org-1',
        newOrganizationName: 'x',
      }),
    ).rejects.toThrow(/二选一/)
    expect(svc.create).not.toHaveBeenCalled()
  })

  it('组织来源两个都不传 → zod refine 拒绝', async () => {
    const caller = adminWorkspaceRouter.createCaller(makeCtx())
    await expect(caller.create({ name: 'w', defaultBrandName: 'b' })).rejects.toThrow(/二选一/)
    expect(svc.create).not.toHaveBeenCalled()
  })

  it('name 超过 100 字符 → zod 拒绝', async () => {
    const caller = adminWorkspaceRouter.createCaller(makeCtx())
    await expect(
      caller.create({ name: 'x'.repeat(101), defaultBrandName: 'b', organizationId: 'org-1' }),
    ).rejects.toThrow()
    expect(svc.create).not.toHaveBeenCalled()
  })
})

describe('adminWorkspaceRouter：状态机/转移/更新端点', () => {
  it('suspend 透传 workspaceId/reason/actorId', async () => {
    const caller = adminWorkspaceRouter.createCaller(makeCtx())
    await caller.suspend({ workspaceId: 'ws-1', reason: '欠费停用' })
    expect(svc.suspend).toHaveBeenCalledWith('ws-1', '欠费停用', 'user-1')
  })

  it('suspend reason 超 200 字符 → zod 拒绝', async () => {
    const caller = adminWorkspaceRouter.createCaller(makeCtx())
    await expect(
      caller.suspend({ workspaceId: 'ws-1', reason: 'x'.repeat(201) }),
    ).rejects.toThrow()
    expect(svc.suspend).not.toHaveBeenCalled()
  })

  it('resume/archive/transfer/update 透传', async () => {
    const caller = adminWorkspaceRouter.createCaller(makeCtx())
    await caller.resume({ workspaceId: 'ws-1' })
    expect(svc.resume).toHaveBeenCalledWith('ws-1', 'user-1')
    await caller.archive({ workspaceId: 'ws-1' })
    expect(svc.archive).toHaveBeenCalledWith('ws-1', 'user-1')
    await caller.transfer({ workspaceId: 'ws-1', targetOrganizationId: 'org-2' })
    expect(svc.transfer).toHaveBeenCalledWith('ws-1', 'org-2', 'user-1')
    await caller.update({ workspaceId: 'ws-1', name: '新名' })
    expect(svc.update).toHaveBeenCalledWith('ws-1', { name: '新名' }, 'user-1')
  })

  it('service 抛 WORKSPACE_INVALID_TRANSITION → 映射为 TRPCError CONFLICT', async () => {
    const caller = adminWorkspaceRouter.createCaller(makeCtx())
    svc.suspend.mockRejectedValue(
      new WorkspaceTransitionError('工作区 ws-1 当前状态为 ARCHIVED，不允许迁移到 SUSPENDED'),
    )
    await expect(caller.suspend({ workspaceId: 'ws-1' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('ARCHIVED'),
    })
  })

  it('service 抛 WORKSPACE_NOT_FOUND → 映射为 TRPCError NOT_FOUND', async () => {
    const caller = adminWorkspaceRouter.createCaller(makeCtx())
    svc.get.mockRejectedValue(new WorkspaceNotFoundError('ws-x'))
    await expect(caller.get({ workspaceId: 'ws-x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('adminWorkspaceRouter：凭证端点（credential.write）', () => {
  it('setPlatformCredentials 透传 platform/values/actorId', async () => {
    const caller = adminWorkspaceRouter.createCaller(makeCtx())
    await caller.setPlatformCredentials({
      workspaceId: 'ws-1',
      platform: 'qwen',
      values: { QWEN_API_KEY: 'sk-qwen' },
    })
    expect(svc.setPlatformCredentials).toHaveBeenCalledWith(
      'ws-1',
      'qwen',
      { QWEN_API_KEY: 'sk-qwen' },
      'user-1',
    )
  })

  it('setCompetitors 透传 competitors/actorId', async () => {
    const caller = adminWorkspaceRouter.createCaller(makeCtx())
    await caller.setCompetitors({ workspaceId: 'ws-1', competitors: ['a.com', 'b.com'] })
    expect(svc.setCompetitors).toHaveBeenCalledWith('ws-1', ['a.com', 'b.com'], 'user-1')
  })
})

describe('adminWorkspaceRouter.enter', () => {
  it('把 ctx.actor.user.id 传给 service.enter', async () => {
    const caller = adminWorkspaceRouter.createCaller(ctxWithRole('OPERATOR'))
    await caller.enter({ workspaceId: 'ws-1' })
    expect(svc.enter).toHaveBeenCalledWith('ws-1', { userId: 'user-1' })
  })
})

describe('adminWorkspaceRouter.get', () => {
  it('响应含 platformSummary 与 organization', async () => {
    const caller = adminWorkspaceRouter.createCaller(makeCtx())
    const result = await caller.get({ workspaceId: 'ws-1' })
    expect(svc.get).toHaveBeenCalledWith('ws-1')
    expect(result.workspace.organization).toEqual({ id: 'org-1', name: 'Acme' })
    expect(result.platformSummary).toEqual({
      competitors: ['figma.com'],
      platforms: { deepseek: { configured: true, hint: 'b12c' } },
    })
  })
})

describe('adminWorkspaceRouter：顾问分配收紧至 SUPER_ADMIN（assignment.manage，终审修复）', () => {
  it('OPERATOR assignOperator → FORBIDDEN（防自我分配进任意工作区），service 未触达', async () => {
    const caller = adminWorkspaceRouter.createCaller(ctxWithRole('OPERATOR'))
    await expect(
      caller.assignOperator({ workspaceId: 'ws-1', userId: 'user-1' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('assignment.manage'),
    })
    expect(svc.assignOperator).not.toHaveBeenCalled()
  })

  it('OPERATOR unassignOperator → FORBIDDEN，service 未触达', async () => {
    const caller = adminWorkspaceRouter.createCaller(ctxWithRole('OPERATOR'))
    await expect(
      caller.unassignOperator({ workspaceId: 'ws-1', userId: 'user-op' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(svc.unassignOperator).not.toHaveBeenCalled()
  })

  it('OPERATOR listOperators 维持 workspace.manage → 放行（收紧仅限写操作）', async () => {
    const caller = adminWorkspaceRouter.createCaller(ctxWithRole('OPERATOR'))
    await expect(caller.listOperators({ workspaceId: 'ws-1' })).resolves.toHaveLength(1)
    expect(svc.listOperators).toHaveBeenCalledWith('ws-1')
  })

  it('SUPER_ADMIN（经 "*" 通配 assignment.manage）assign/unassign → 放行', async () => {
    const caller = adminWorkspaceRouter.createCaller(ctxWithRole('SUPER_ADMIN'))
    await expect(
      caller.assignOperator({ workspaceId: 'ws-1', userId: 'user-op', isPrimary: true }),
    ).resolves.toEqual({ ok: true })
    await expect(
      caller.unassignOperator({ workspaceId: 'ws-1', userId: 'user-op' }),
    ).resolves.toEqual({ ok: true })
    expect(svc.assignOperator).toHaveBeenCalledWith('ws-1', 'user-op', { isPrimary: true }, 'user-1')
    expect(svc.unassignOperator).toHaveBeenCalledWith('ws-1', 'user-op', 'user-1')
  })
})

describe('adminWorkspaceRouter：顾问分配端点（任务 6，assign/unassign=assignment.manage）', () => {
  it('assignOperator 透传 workspaceId/userId/isPrimary 与 actorId', async () => {
    const caller = adminWorkspaceRouter.createCaller(makeCtx())
    const result = await caller.assignOperator({
      workspaceId: 'ws-1',
      userId: 'user-op',
      isPrimary: true,
    })
    expect(svc.assignOperator).toHaveBeenCalledWith('ws-1', 'user-op', { isPrimary: true }, 'user-1')
    expect(result).toEqual({ ok: true })
  })

  it('assignOperator 不传 isPrimary：opts 为 { isPrimary: undefined }（service 视为未提供）', async () => {
    const caller = adminWorkspaceRouter.createCaller(makeCtx())
    await caller.assignOperator({ workspaceId: 'ws-1', userId: 'user-op' })
    expect(svc.assignOperator).toHaveBeenCalledWith(
      'ws-1',
      'user-op',
      { isPrimary: undefined },
      'user-1',
    )
  })

  it('unassignOperator 透传 workspaceId/userId 与 actorId', async () => {
    const caller = adminWorkspaceRouter.createCaller(makeCtx())
    await caller.unassignOperator({ workspaceId: 'ws-1', userId: 'user-op' })
    expect(svc.unassignOperator).toHaveBeenCalledWith('ws-1', 'user-op', 'user-1')
  })

  it('listOperators 透传 workspaceId，返回含 isPrimary 的分配视图', async () => {
    const caller = adminWorkspaceRouter.createCaller(makeCtx())
    const items = await caller.listOperators({ workspaceId: 'ws-1' })
    expect(svc.listOperators).toHaveBeenCalledWith('ws-1')
    expect(items).toEqual([
      { user: { id: 'user-op', username: 'op1', displayName: '顾问一号' }, isPrimary: true },
    ])
  })

  it('isPrimary 非布尔 / userId 空串 → zod 拒绝，不触达 service', async () => {
    const caller = adminWorkspaceRouter.createCaller(makeCtx())
    await expect(
      caller.assignOperator({ workspaceId: 'ws-1', userId: 'u', isPrimary: 'yes' as any }),
    ).rejects.toThrow()
    await expect(caller.assignOperator({ workspaceId: 'ws-1', userId: '' })).rejects.toThrow()
    expect(svc.assignOperator).not.toHaveBeenCalled()
  })

  it('service 抛 OPERATOR_NOT_ELIGIBLE → 映射为 TRPCError BAD_REQUEST', async () => {
    const caller = adminWorkspaceRouter.createCaller(makeCtx())
    svc.assignOperator.mockRejectedValue(
      new OperatorNotEligibleError('用户 cust 不是平台顾问（需 PLATFORM 用户且角色为 OPERATOR）'),
    )
    await expect(
      caller.assignOperator({ workspaceId: 'ws-1', userId: 'cust' }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('OPERATOR'),
    })
  })

  it('service 抛 WORKSPACE_NOT_FOUND → assignOperator 映射 NOT_FOUND', async () => {
    const caller = adminWorkspaceRouter.createCaller(makeCtx())
    svc.unassignOperator.mockRejectedValue(new WorkspaceNotFoundError('ws-x'))
    await expect(
      caller.unassignOperator({ workspaceId: 'ws-x', userId: 'user-op' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('service 抛 OPERATOR_ASSIGNMENT_NOT_FOUND（重删）→ 映射 TRPCError NOT_FOUND，不再 500', async () => {
    const caller = adminWorkspaceRouter.createCaller(makeCtx())
    svc.unassignOperator.mockRejectedValue(
      new OperatorAssignmentNotFoundError('ws-1', 'user-op'),
    )
    await expect(
      caller.unassignOperator({ workspaceId: 'ws-1', userId: 'user-op' }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('user-op'),
    })
  })
})

describe('adminWorkspaceRouter：顾问分配衔接任务 2 的 hasAssignment 收紧（mock 层闭环）', () => {
  it('OPERATOR 经 assignOperator 分配后产生 WorkspaceMember 记录 → members.hasAssignment 为真', async () => {
    const operatorUser = {
      id: 'user-op',
      username: 'op1',
      displayName: '顾问一号',
      userType: 'PLATFORM',
      platformRole: 'OPERATOR',
    }
    const prisma = {
      workspace: { findUnique: vi.fn(async () => ({ id: 'ws-1', organizationId: 'org-1' })) },
      user: {
        findUnique: vi.fn(async () => operatorUser),
        findMany: vi.fn(async () => []),
      },
      workspaceMember: {
        findUnique: vi.fn(async () => ({
          workspaceId: 'ws-1',
          userId: 'user-op',
          access: 'OPERATE',
          isPrimary: false,
        })),
        findMany: vi.fn(async () => []),
        upsert: vi.fn(async () => ({})),
        delete: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
    } as any
    const members = createMemberService(prisma)
    const audit = {
      record: vi.fn(async () => {}),
      list: vi.fn(async () => ({ items: [], total: 0 })),
    } as any
    const workspaceAdmin = createWorkspaceAdminService({
      prisma,
      credentials: {} as any,
      audit,
      envelopeKey: 'k'.repeat(64),
      getSummary: vi.fn(async () => ({ competitors: [], platforms: {} })),
      members,
    })
    const caller = adminWorkspaceRouter.createCaller(
      makeCtx({ services: { workspaceAdmin } }) as any,
    )

    // 分配前：无 WorkspaceMember 记录 → hasAssignment false（任务 2 收紧后 OPERATOR 被拒）
    prisma.workspaceMember.findUnique.mockResolvedValue(null)
    expect(await members.hasAssignment('user-op', 'ws-1')).toBe(false)

    // 经 admin.workspace.assignOperator 分配：落 access=OPERATE 的成员记录
    await expect(
      caller.assignOperator({ workspaceId: 'ws-1', userId: 'user-op' }),
    ).resolves.toEqual({ ok: true })
    expect(prisma.workspaceMember.upsert).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: 'ws-1', userId: 'user-op' } },
      create: { workspaceId: 'ws-1', userId: 'user-op', access: 'OPERATE' },
      update: { access: 'OPERATE' },
    })

    // 分配后：记录存在 → hasAssignment true（context 授权分治据此放行）
    prisma.workspaceMember.findUnique.mockResolvedValue({
      workspaceId: 'ws-1',
      userId: 'user-op',
      access: 'OPERATE',
      isPrimary: false,
    })
    expect(await members.hasAssignment('user-op', 'ws-1')).toBe(true)
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workspace.assign_operator', workspaceId: 'ws-1' }),
    )
  })
})
