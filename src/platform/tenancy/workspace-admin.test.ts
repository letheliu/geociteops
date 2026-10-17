import { describe, expect, it, vi } from 'vitest'
import {
  createWorkspaceAdminService,
  WorkspaceNotFoundError,
  WorkspaceTransitionError,
  OperatorNotEligibleError,
  OperatorAssignmentNotFoundError,
} from './workspace-admin.js'
import { decryptConfig, encryptConfig } from '../../core/crypto/envelope.js'
import {
  createEntitlementGuard,
  PlatformNotAllowedError,
  QuotaExceededError,
} from '../billing/entitlement-guard.js'
import { createUsageMeter } from '../billing/usage-meter.js'

/** 测试用 64 位 hex 假主密钥 */
const KEY = 'a'.repeat(64)

function makeWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ws-1',
    name: '客户工作区',
    domain: null,
    llmsTxtUrl: null,
    defaultBrandName: '品牌',
    platformConfig: encryptConfig('{}', KEY),
    publicationConfig: {},
    status: 'ACTIVE',
    organizationId: 'org-1',
    archivedAt: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  }
}

/** 顾问分配测试用的平台顾问用户（PLATFORM + OPERATOR） */
const OPERATOR_USER = {
  id: 'user-op',
  username: 'op1',
  displayName: '顾问一号',
  userType: 'PLATFORM',
  platformRole: 'OPERATOR',
}

function makeDeps(
  opts: {
    workspace?: unknown
    /** user.findUnique 按 id 查的返回（默认平台顾问；null = 用户不存在） */
    user?: Record<string, unknown> | null
    /** user.findUnique 按 username 查的返回（默认 null = 用户名未命中） */
    userByUsername?: Record<string, unknown> | null
    /** members.listMembers 的返回（默认含一名顾问 + 一名客户成员） */
    memberList?: Record<string, unknown>[]
    /** user.findMany（listOperators 的 PLATFORM 过滤）的返回 */
    platformUsers?: Record<string, unknown>[]
    /** 任务 9：OE 读行（softCheck/checkPlatforms 路径）与锁行（hardCheck 路径） */
    oeRow?: Record<string, unknown> | null
    lockedRows?: Record<string, unknown>[]
    /** 任务 9：非归档 workspace 计数（maxWorkspaces 硬限用） */
    workspaceCount?: number
    /** 任务 9：注入真实计费检查点（guard 与 service 共享同一 prisma mock） */
    withBilling?: {
      enforcement: () => boolean
      /** softCheck 的当月用量聚合返回（meter 的独立 prisma） */
      monthlyUsage?: number
    }
  } = {},
) {
  const base =
    opts.workspace === undefined ? makeWorkspace() : (opts.workspace as Record<string, unknown> | null)
  // findUnique 模拟 include organization 的返回形状（get 详情用）
  const workspace =
    base === null ? null : { organization: { id: 'org-1', name: 'Acme' }, ...base }
  const prisma = {
    workspace: {
      findUnique: vi.fn(async () => workspace),
      findMany: vi.fn(async () => [{ ...makeWorkspace(), organization: { id: 'org-1', name: 'Acme' } }]),
      count: vi.fn(async () => opts.workspaceCount ?? 1),
      create: vi.fn(async ({ data }: any) => ({ ...makeWorkspace(), ...data })),
      update: vi.fn(async ({ data }: any) => ({ ...makeWorkspace(), ...data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    organization: {
      create: vi.fn(async ({ data }: any) => ({ id: 'org-new', name: data.name })),
    },
    organizationEntitlement: {
      findUnique: vi.fn(async () => (opts.oeRow === undefined ? null : opts.oeRow)),
      upsert: vi.fn(async () => ({})),
    },
    $queryRaw: vi.fn(async () => opts.lockedRows ?? [
      { organizationId: 'org-1', limits: { maxWorkspaces: 10, allowedPlatforms: [] } },
    ]),
    user: {
      // assignOperator 的双路径解析：where.id 命中回 opts.user（undefined 才回默认顾问，null=不存在），where.username 回 opts.userByUsername
      findUnique: vi.fn(async ({ where }: any) =>
        where.username !== undefined
          ? (opts.userByUsername ?? null)
          : (opts.user !== undefined ? opts.user : OPERATOR_USER),
      ),
      findMany: vi.fn(
        async () =>
          opts.platformUsers ?? [{ id: 'user-op', username: 'op1', displayName: '顾问一号' }],
      ),
    },
    workspaceMember: {
      update: vi.fn(async ({ data }: any) => ({ ...data })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    // 数组形式（批量操作）与交互式（函数形式，任务 9 配额槽）双兼容
    $transaction: vi.fn(async (arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : Promise.all(arg as unknown[]),
    ),
  } as any
  const credentials = {
    findByKey: vi.fn(),
    issue: vi.fn(async () => ({ credential: { id: 'cred-1' }, plaintext: 'geo_plain_once' })),
    list: vi.fn(async () => []),
  } as any
  const audit = {
    record: vi.fn(async () => {}),
    list: vi.fn(async () => ({ items: [], total: 0 })),
  } as any
  // 任务 9：注入真实计费检查点（guard 与 service 共享同一 prisma mock）
  let billing: Parameters<typeof makeDeps>[0]['billing']
  if (opts.withBilling) {
    const built = makeBilling(prisma, opts.withBilling.enforcement, opts.withBilling.monthlyUsage)
    billing = built.billing
  }
  const getSummary = vi.fn(async () => ({
    competitors: ['figma.com'],
    platforms: { deepseek: { configured: true, hint: 'b12c' } },
  }))
  const members = {
    listMembers: vi.fn(async () =>
      opts.memberList ?? [
        {
          user: { id: 'user-op', username: 'op1', displayName: '顾问一号' },
          access: 'OPERATE',
          isPrimary: true,
        },
        {
          user: { id: 'u-cust', username: 'cust', displayName: '客户成员' },
          access: 'VIEW',
          isPrimary: false,
        },
      ],
    ),
    upsert: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  } as any
  const service = createWorkspaceAdminService({
    prisma,
    credentials,
    audit,
    envelopeKey: KEY,
    getSummary,
    members,
    billing,
  })
  return { prisma, credentials, audit, getSummary, members, service, billing }
}

// ---------------------------------------------------------------------------
// 任务 9：计费检查点（makeBilling 装配真实 guard + meter + mock prisma/audit）
// ---------------------------------------------------------------------------

/** 计费检查点装配：enforcement 可控的真实 guard/meter（meter 落 mock prisma） */
function makeBilling(
  prisma: any,
  enforcement: () => boolean,
  monthlyUsage = 0,
) {
  const meterPrisma = {
    usageRecord: {
      createMany: vi.fn(async () => ({ count: 0 })),
      aggregate: vi.fn(async () => ({ _sum: { quantity: monthlyUsage } })),
    },
  }
  const audit = { record: vi.fn(async () => {}), list: vi.fn(async () => ({ items: [], total: 0 })) }
  const meter = createUsageMeter({ prisma: meterPrisma as any })
  const guard = createEntitlementGuard({ prisma, meter, audit: audit as any, enforcement })
  return { billing: { guard, meter }, guardAudit: audit, meterPrisma }
}

/** 解密 update/create 落库的 platformConfig，断言回环明文 */
function decryptStored(raw: unknown): Record<string, any> {
  expect(typeof raw).toBe('string')
  return JSON.parse(decryptConfig(raw as string, KEY))
}

describe('workspaceAdminService.list', () => {
  it('三过滤齐传：q 对 name/domain contains（OR）+ status + organizationId，含分页与 organization 投影', async () => {
    const { prisma, service } = makeDeps()
    const result = await service.list({
      q: 'acme',
      status: 'SUSPENDED',
      organizationId: 'org-9',
      page: 3,
      pageSize: 10,
    })
    const expectedWhere = {
      OR: [{ name: { contains: 'acme' } }, { domain: { contains: 'acme' } }],
      status: 'SUSPENDED',
      organizationId: 'org-9',
    }
    expect(prisma.workspace.findMany).toHaveBeenCalledWith({
      where: expectedWhere,
      include: { organization: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      skip: 20,
      take: 10,
    })
    expect(prisma.workspace.count).toHaveBeenCalledWith({ where: expectedWhere })
    expect(result.total).toBe(1)
    expect(result.items[0].organization).toEqual({ id: 'org-1', name: 'Acme' })
  })

  it('空过滤：where 为空对象，默认 page=1/pageSize=20', async () => {
    const { prisma, service } = makeDeps()
    await service.list({})
    expect(prisma.workspace.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {}, skip: 0, take: 20 }),
    )
  })

  it('仅 q：只带 OR 条件，不带 status/organizationId', async () => {
    const { prisma, service } = makeDeps()
    await service.list({ q: '客户' })
    const arg = prisma.workspace.findMany.mock.calls[0][0]
    expect(arg.where).toEqual({
      OR: [{ name: { contains: '客户' } }, { domain: { contains: '客户' } }],
    })
  })
})

describe('workspaceAdminService.create', () => {
  it('指定 organizationId：直接建 ws（ACTIVE、platformConfig 生而加密为 "{}"）、issue 初始 Key、audit workspace.create', async () => {
    const { prisma, credentials, audit, service } = makeDeps()
    const result = await service.create(
      {
        name: '新工作区',
        defaultBrandName: '品牌',
        domain: 'acme.com',
        organizationId: 'org-1',
      },
      'user-op',
    )

    expect(prisma.organization.create).not.toHaveBeenCalled()
    const createArg = prisma.workspace.create.mock.calls[0][0]
    expect(createArg.data).toMatchObject({
      name: '新工作区',
      defaultBrandName: '品牌',
      domain: 'acme.com',
      organizationId: 'org-1',
      status: 'ACTIVE',
    })
    // 明文 '{}' 从不落库：落库的是可解密回 '{}' 的信封
    expect(decryptStored(createArg.data.platformConfig)).toEqual({})
    expect(credentials.issue).toHaveBeenCalledWith('ws-1', '初始 Key', 'user-op')
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workspace.create',
        workspaceId: 'ws-1',
        actorId: 'user-op',
        actorType: 'USER',
      }),
    )
    expect(result.apiKey).toBe('geo_plain_once')
    expect(result.workspace.id).toBe('ws-1')
  })

  it('newOrganizationName：先建 Organization 再建 ws', async () => {
    const { prisma, service } = makeDeps()
    const result = await service.create(
      { name: '新工作区', defaultBrandName: '品牌', newOrganizationName: '新组织' },
      'user-op',
    )
    expect(prisma.organization.create).toHaveBeenCalledWith({ data: { name: '新组织' } })
    expect(prisma.workspace.create.mock.calls[0][0].data.organizationId).toBe('org-new')
    expect(result.workspace.organizationId).toBe('org-new')
  })

  it('组织来源两个都传 → 抛错且不落库', async () => {
    const { prisma, service } = makeDeps()
    await expect(
      service.create(
        { name: 'w', defaultBrandName: 'b', organizationId: 'org-1', newOrganizationName: 'x' } as any,
        'user-op',
      ),
    ).rejects.toThrow(/二选一/)
    expect(prisma.organization.create).not.toHaveBeenCalled()
    expect(prisma.workspace.create).not.toHaveBeenCalled()
  })

  it('组织来源两个都不传 → 抛错且不落库', async () => {
    const { prisma, service } = makeDeps()
    await expect(
      service.create({ name: 'w', defaultBrandName: 'b' } as any, 'user-op'),
    ).rejects.toThrow(/二选一/)
    expect(prisma.organization.create).not.toHaveBeenCalled()
    expect(prisma.workspace.create).not.toHaveBeenCalled()
  })
})

describe('workspaceAdminService.update', () => {
  it('仅写提供的字段，audit diff 记变更字段名数组', async () => {
    const { prisma, audit, service } = makeDeps()
    await service.update('ws-1', { name: '新名', domain: 'acme.com' }, 'user-op')
    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 'ws-1' },
      data: { name: '新名', domain: 'acme.com' },
    })
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workspace.update',
        workspaceId: 'ws-1',
        actorId: 'user-op',
        diff: ['name', 'domain'],
      }),
    )
  })

  it('workspace 不存在 → WORKSPACE_NOT_FOUND', async () => {
    const { service } = makeDeps({ workspace: null })
    await expect(service.update('ws-x', { name: '新名' })).rejects.toMatchObject({
      name: 'WORKSPACE_NOT_FOUND',
    })
  })
})

describe('workspaceAdminService.setPlatformCredentials', () => {
  it('旧信封解密 → 合并保留其他平台与 competitors → 重新加密落库；audit target=platform', async () => {
    const oldPlain = {
      deepseek: { DEEPSEEK_API_KEY: 'sk-old' },
      competitors: ['old.com'],
    }
    const { prisma, audit, service } = makeDeps({
      workspace: makeWorkspace({ platformConfig: encryptConfig(JSON.stringify(oldPlain), KEY) }),
    })
    await service.setPlatformCredentials(
      'ws-1',
      'qwen',
      { QWEN_API_KEY: 'sk-new' },
      'user-op',
    )
    const updateArg = prisma.workspace.update.mock.calls[0][0]
    expect(decryptStored(updateArg.data.platformConfig)).toEqual({
      ...oldPlain,
      qwen: { QWEN_API_KEY: 'sk-new' },
    })
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workspace.set_credentials',
        workspaceId: 'ws-1',
        target: 'qwen',
        actorId: 'user-op',
      }),
    )
  })

  it('旧明文对象（未加密存量）同样被读出合并，且落库为信封', async () => {
    const legacy = { deepseek: { DEEPSEEK_API_KEY: 'sk-legacy' } }
    const { prisma, service } = makeDeps({
      workspace: makeWorkspace({ platformConfig: legacy as any }),
    })
    await service.setPlatformCredentials('ws-1', 'doubao', { DOUBAO_API_KEY: 'sk-db' })
    const updateArg = prisma.workspace.update.mock.calls[0][0]
    expect(decryptStored(updateArg.data.platformConfig)).toEqual({
      deepseek: { DEEPSEEK_API_KEY: 'sk-legacy' },
      doubao: { DOUBAO_API_KEY: 'sk-db' },
    })
  })
})

describe('workspaceAdminService.setCompetitors', () => {
  it('只改 competitors 键，保留平台凭证；audit workspace.set_competitors', async () => {
    const oldPlain = {
      deepseek: { DEEPSEEK_API_KEY: 'sk-old' },
      competitors: ['old.com'],
    }
    const { prisma, audit, service } = makeDeps({
      workspace: makeWorkspace({ platformConfig: encryptConfig(JSON.stringify(oldPlain), KEY) }),
    })
    await service.setCompetitors('ws-1', ['b.com', 'c.com'], 'user-op')
    const updateArg = prisma.workspace.update.mock.calls[0][0]
    expect(decryptStored(updateArg.data.platformConfig)).toEqual({
      deepseek: { DEEPSEEK_API_KEY: 'sk-old' },
      competitors: ['b.com', 'c.com'],
    })
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workspace.set_competitors',
        workspaceId: 'ws-1',
        actorId: 'user-op',
      }),
    )
  })
})

describe('workspaceAdminService 状态机（乐观并发）', () => {
  it('suspend：ACTIVE→SUSPENDED，updateMany where 限定 from 状态；reason 进 audit diff；手动暂停 suspendReason=null', async () => {
    const { prisma, audit, service } = makeDeps()
    await service.suspend('ws-1', '欠费停用', 'user-op')
    expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
      where: { id: 'ws-1', status: { in: ['ACTIVE'] } },
      data: { status: 'SUSPENDED', suspendReason: null },
    })
    const auditArg = audit.record.mock.calls[0][0]
    expect(auditArg.action).toBe('workspace.suspend')
    expect(auditArg.diff.reason).toBe('欠费停用')
  })

  it('suspend 无 reason：audit diff 不含 reason 键', async () => {
    const { prisma, audit, service } = makeDeps()
    await service.suspend('ws-1', undefined, 'user-op')
    expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
      where: { id: 'ws-1', status: { in: ['ACTIVE'] } },
      data: { status: 'SUSPENDED', suspendReason: null },
    })
    const auditArg = audit.record.mock.calls[0][0]
    expect(auditArg.action).toBe('workspace.suspend')
    expect(auditArg.diff).not.toHaveProperty('reason')
  })

  it('suspend opts.suspendReason（任务 8 签名扩展）：机器可读恢复锚落库', async () => {
    const { prisma, service } = makeDeps()
    await service.suspend('ws-1', '订阅到期暂停', 'user-op', { suspendReason: '订阅到期' })
    expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
      where: { id: 'ws-1', status: { in: ['ACTIVE'] } },
      data: { status: 'SUSPENDED', suspendReason: '订阅到期' },
    })
  })

  it('suspend 命中 0 行（实际已 SUSPENDED）：抛 WORKSPACE_INVALID_TRANSITION 且含当前 status，不写 audit', async () => {
    const { prisma, audit, service } = makeDeps({
      workspace: makeWorkspace({ status: 'SUSPENDED' }),
    })
    prisma.workspace.updateMany.mockResolvedValue({ count: 0 })
    await expect(service.suspend('ws-1', 'again')).rejects.toMatchObject({
      name: 'WORKSPACE_INVALID_TRANSITION',
      message: expect.stringContaining('SUSPENDED'),
    })
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('resume：SUSPENDED→ACTIVE，updateMany where 限定 SUSPENDED；显式清 suspendReason（遗留 B4）', async () => {
    const { prisma, audit, service } = makeDeps({
      workspace: makeWorkspace({ status: 'SUSPENDED', suspendReason: '订阅到期' }),
    })
    await service.resume('ws-1', 'user-op')
    expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
      where: { id: 'ws-1', status: { in: ['SUSPENDED'] } },
      data: { status: 'ACTIVE', suspendReason: null },
    })
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workspace.resume', workspaceId: 'ws-1' }),
    )
  })

  it('遗留 B4：resume 后 suspendReason 为 null——"订阅到期"脏锚不残留 ACTIVE 行', async () => {
    // 复刻落库行为：updateMany 按 data 实写到 store（默认 mock 不落盘）
    const store = [{ status: 'SUSPENDED', suspendReason: '订阅到期' }]
    const deps = makeDeps({
      workspace: makeWorkspace({ status: 'SUSPENDED', suspendReason: '订阅到期' }),
    })
    deps.prisma.workspace.updateMany.mockImplementation(async ({ data }: any) => {
      Object.assign(store[0], data)
      return { count: 1 }
    })

    await deps.service.resume('ws-1', 'user-op')

    expect(store[0]).toEqual({ status: 'ACTIVE', suspendReason: null })
  })

  it('resume 对 ARCHIVED：抛 WORKSPACE_INVALID_TRANSITION 且 message 含 ARCHIVED', async () => {
    const { prisma, service } = makeDeps({
      workspace: makeWorkspace({ status: 'ARCHIVED', archivedAt: new Date() }),
    })
    prisma.workspace.updateMany.mockResolvedValue({ count: 0 })
    await expect(service.resume('ws-1')).rejects.toMatchObject({
      name: 'WORKSPACE_INVALID_TRANSITION',
      message: expect.stringContaining('ARCHIVED'),
    })
  })

  it('archive：ACTIVE/SUSPENDED 均可 → ARCHIVED 并写 archivedAt', async () => {
    const { prisma, audit, service } = makeDeps()
    await service.archive('ws-1', 'user-op')
    const arg = prisma.workspace.updateMany.mock.calls[0][0]
    expect(arg.where).toEqual({ id: 'ws-1', status: { in: ['ACTIVE', 'SUSPENDED'] } })
    expect(arg.data.status).toBe('ARCHIVED')
    expect(arg.data.archivedAt).toBeInstanceOf(Date)
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workspace.archive', workspaceId: 'ws-1' }),
    )
  })

  it('archive 命中 0 行且 workspace 不存在：抛 WORKSPACE_NOT_FOUND', async () => {
    const { prisma, service } = makeDeps({ workspace: null })
    prisma.workspace.updateMany.mockResolvedValue({ count: 0 })
    await expect(service.archive('ws-x')).rejects.toBeInstanceOf(WorkspaceNotFoundError)
  })

  it('错误类：name 固定为 WORKSPACE_INVALID_TRANSITION', () => {
    const err = new WorkspaceTransitionError('x')
    expect(err.name).toBe('WORKSPACE_INVALID_TRANSITION')
    expect(err instanceof WorkspaceTransitionError).toBe(true)
  })
})

describe('workspaceAdminService.transfer', () => {
  it('更新 organizationId，audit diff 含 from/to orgId', async () => {
    const { prisma, audit, service } = makeDeps()
    await service.transfer('ws-1', 'org-2', 'user-op')
    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 'ws-1' },
      data: { organizationId: 'org-2' },
    })
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workspace.transfer',
        workspaceId: 'ws-1',
        diff: { from: 'org-1', to: 'org-2' },
      }),
    )
  })

  it('workspace 不存在 → WORKSPACE_NOT_FOUND', async () => {
    const { service } = makeDeps({ workspace: null })
    await expect(service.transfer('ws-x', 'org-2')).rejects.toBeInstanceOf(WorkspaceNotFoundError)
  })
})

describe('workspaceAdminService.enter', () => {
  it('仅写 audit workspace.enter（actorId=userId）', async () => {
    const { prisma, audit, service } = makeDeps()
    await service.enter('ws-1', { userId: 'user-9' })
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workspace.enter',
        actorId: 'user-9',
        workspaceId: 'ws-1',
        actorType: 'USER',
      }),
    )
    expect(prisma.workspace.update).not.toHaveBeenCalled()
    expect(prisma.workspace.updateMany).not.toHaveBeenCalled()
  })
})

describe('workspaceAdminService 脱敏投影（终审：admin 响应不得含 platformConfig 原文或密文）', () => {
  it('list/get/create/update/凭证/竞品/状态机/transfer 返回统一投影：序列化不含 platformConfig/ct/publicationConfig', async () => {
    const { service } = makeDeps()
    const payloads = [
      await service.list({}),
      await service.get('ws-1'),
      await service.create({ name: 'w', defaultBrandName: 'b', organizationId: 'org-1' }, 'user-op'),
      await service.update('ws-1', { name: 'n' }, 'user-op'),
      await service.setPlatformCredentials('ws-1', 'qwen', { QWEN_API_KEY: 'sk' }, 'user-op'),
      await service.setCompetitors('ws-1', ['a.com'], 'user-op'),
      await service.suspend('ws-1', 'r', 'user-op'),
      await service.resume('ws-1', 'user-op'),
      await service.archive('ws-1', 'user-op'),
      await service.transfer('ws-1', 'org-2', 'user-op'),
    ]
    for (const payload of payloads) {
      const json = JSON.stringify(payload)
      expect(json).not.toContain('platformConfig')
      expect(json).not.toContain('publicationConfig')
      expect(json).not.toContain('ct') // 信封密文字段名 { __v, iv, tag, ct }
    }
  })

  it('投影保留 web 前端消费的字段（name/status/domain/createdAt/organization/platformSummary）', async () => {
    const { service } = makeDeps()
    const listResult = await service.list({})
    expect(listResult.items[0]).toMatchObject({
      id: 'ws-1',
      name: '客户工作区',
      status: 'ACTIVE',
      domain: null,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      organization: { id: 'org-1', name: 'Acme' },
    })
    const getResult = await service.get('ws-1')
    expect(getResult.workspace.organization).toEqual({ id: 'org-1', name: 'Acme' })
    expect(getResult.workspace.defaultBrandName).toBe('品牌')
    expect(getResult.platformSummary.platforms.deepseek).toEqual({ configured: true, hint: 'b12c' })
  })

  it('create/update 返回的投影 organization 为 null（未取关系），显式字段仍齐全', async () => {
    const { service } = makeDeps()
    const created = await service.create(
      { name: 'w', defaultBrandName: 'b', organizationId: 'org-1' },
      'user-op',
    )
    expect(created.workspace).toMatchObject({
      id: 'ws-1',
      organizationId: 'org-1',
      organization: null,
    })
    const updated = await service.update('ws-1', { name: 'n' }, 'user-op')
    expect(updated).toMatchObject({ id: 'ws-1', name: 'n', organization: null })
  })
})

describe('workspaceAdminService.get', () => {
  it('详情含 organization 投影与 platformSummary（注入的 getSummary）', async () => {
    const { prisma, getSummary, service } = makeDeps()
    const result = await service.get('ws-1')
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: 'ws-1' },
      include: { organization: { select: { id: true, name: true } } },
    })
    expect(getSummary).toHaveBeenCalledWith('ws-1')
    expect(result.workspace.organization).toEqual({ id: 'org-1', name: 'Acme' })
    expect(result.platformSummary).toEqual({
      competitors: ['figma.com'],
      platforms: { deepseek: { configured: true, hint: 'b12c' } },
    })
  })

  it('workspace 不存在 → WORKSPACE_NOT_FOUND', async () => {
    const { getSummary, service } = makeDeps({ workspace: null })
    await expect(service.get('ws-x')).rejects.toBeInstanceOf(WorkspaceNotFoundError)
    expect(getSummary).not.toHaveBeenCalled()
  })
})

describe('workspaceAdminService.assignOperator（任务 6：顾问分配）', () => {
  it('PLATFORM+OPERATOR 用户：members.upsert access=OPERATE + audit workspace.assign_operator（target=User:userId，diff 含 isPrimary）', async () => {
    const { members, audit, service } = makeDeps()
    const result = await service.assignOperator('ws-1', 'user-op', undefined, 'user-admin')
    expect(members.upsert).toHaveBeenCalledWith('ws-1', 'user-op', 'OPERATE')
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workspace.assign_operator',
        workspaceId: 'ws-1',
        actorId: 'user-admin',
        actorType: 'USER',
        target: 'User:user-op',
        diff: { userId: 'user-op', isPrimary: false },
      }),
    )
    expect(result).toEqual({ ok: true })
  })

  it('userId 传用户名：id 未命中按 username 解析，members.upsert 用解析出的 user.id', async () => {
    const { prisma, members, service } = makeDeps({
      user: null,
      userByUsername: OPERATOR_USER,
    })
    await service.assignOperator('ws-1', 'op1')
    expect(prisma.user.findUnique).toHaveBeenNthCalledWith(1, {
      where: { id: 'op1' },
      select: { id: true, userType: true, platformRole: true },
    })
    expect(prisma.user.findUnique).toHaveBeenNthCalledWith(2, {
      where: { username: 'op1' },
      select: { id: true, userType: true, platformRole: true },
    })
    expect(members.upsert).toHaveBeenCalledWith('ws-1', 'user-op', 'OPERATE')
  })

  it('user 不存在 → OPERATOR_NOT_ELIGIBLE，不 upsert 不写 audit', async () => {
    const { members, audit, service } = makeDeps({ user: null, userByUsername: null })
    await expect(service.assignOperator('ws-1', 'user-x')).rejects.toMatchObject({
      name: 'OPERATOR_NOT_ELIGIBLE',
    })
    expect(members.upsert).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('CUSTOMER 用户（userType 非 PLATFORM）拒：OPERATOR_NOT_ELIGIBLE', async () => {
    const { members, service } = makeDeps({
      user: { ...OPERATOR_USER, userType: 'CUSTOMER', platformRole: null },
    })
    await expect(service.assignOperator('ws-1', 'user-cust')).rejects.toMatchObject({
      name: 'OPERATOR_NOT_ELIGIBLE',
    })
    expect(members.upsert).not.toHaveBeenCalled()
  })

  it('PLATFORM 但 platformRole 非 OPERATOR（如 SUPPORT）拒：OPERATOR_NOT_ELIGIBLE', async () => {
    const { members, service } = makeDeps({
      user: { ...OPERATOR_USER, platformRole: 'SUPPORT' },
    })
    await expect(service.assignOperator('ws-1', 'user-sp')).rejects.toBeInstanceOf(
      OperatorNotEligibleError,
    )
    expect(members.upsert).not.toHaveBeenCalled()
  })

  it('isPrimary=true：$transaction 内先清同 ws 旧 primary（updateMany userId not 目标）后设新（update）——顺序钉住', async () => {
    const { prisma, members, audit, service } = makeDeps()
    await service.assignOperator('ws-1', 'user-op', { isPrimary: true }, 'user-admin')
    // 先 members.upsert 保证记录存在，再清旧、再设新
    expect(prisma.workspaceMember.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1', isPrimary: true, userId: { not: 'user-op' } },
      data: { isPrimary: false },
    })
    expect(prisma.workspaceMember.update).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: 'ws-1', userId: 'user-op' } },
      data: { isPrimary: true },
    })
    // 清旧在设新之前（invocationCallOrder 全局单调递增）
    expect(prisma.workspaceMember.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.workspaceMember.update.mock.invocationCallOrder[0],
    )
    // 清旧 + 设新包在同一 $transaction（原子性：不出现双 primary 或双空窗）
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(2)
    expect(members.upsert).toHaveBeenCalledWith('ws-1', 'user-op', 'OPERATE')
    const auditArg = audit.record.mock.calls[0][0]
    expect(auditArg.action).toBe('workspace.assign_operator')
    expect(auditArg.diff).toMatchObject({ isPrimary: true })
  })

  it('isPrimary 不传：不动 isPrimary（update/updateMany/$transaction 均未调），members.upsert 仍执行', async () => {
    const { prisma, members, service } = makeDeps()
    await service.assignOperator('ws-1', 'user-op')
    expect(members.upsert).toHaveBeenCalledWith('ws-1', 'user-op', 'OPERATE')
    expect(prisma.workspaceMember.update).not.toHaveBeenCalled()
    expect(prisma.workspaceMember.updateMany).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('isPrimary=false 显式传：同样不动 isPrimary（仅 true 触发清位/设位）', async () => {
    const { prisma, service } = makeDeps()
    await service.assignOperator('ws-1', 'user-op', { isPrimary: false })
    expect(prisma.workspaceMember.update).not.toHaveBeenCalled()
    expect(prisma.workspaceMember.updateMany).not.toHaveBeenCalled()
  })

  it('workspace 不存在 → WORKSPACE_NOT_FOUND，不触 members/audit', async () => {
    const { members, audit, service } = makeDeps({ workspace: null })
    await expect(service.assignOperator('ws-x', 'user-op')).rejects.toBeInstanceOf(
      WorkspaceNotFoundError,
    )
    expect(members.upsert).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })
})

describe('workspaceAdminService.unassignOperator', () => {
  it('members.remove + audit workspace.unassign_operator（target=User:userId）', async () => {
    const { members, audit, service } = makeDeps()
    const result = await service.unassignOperator('ws-1', 'user-op', 'user-admin')
    expect(members.remove).toHaveBeenCalledWith('ws-1', 'user-op')
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workspace.unassign_operator',
        workspaceId: 'ws-1',
        actorId: 'user-admin',
        actorType: 'USER',
        target: 'User:user-op',
      }),
    )
    expect(result).toEqual({ ok: true })
  })

  it('workspace 不存在 → WORKSPACE_NOT_FOUND，不触 members', async () => {
    const { members, service } = makeDeps({ workspace: null })
    await expect(service.unassignOperator('ws-x', 'user-op')).rejects.toBeInstanceOf(
      WorkspaceNotFoundError,
    )
    expect(members.remove).not.toHaveBeenCalled()
  })

  it('userId 传用户名：id 未命中按 username 解析，members.remove 与 audit 均用解析出的 user.id（与 assign 双通道对称）', async () => {
    const { prisma, members, audit, service } = makeDeps({
      user: null,
      userByUsername: OPERATOR_USER,
    })
    await service.unassignOperator('ws-1', 'op1')
    expect(prisma.user.findUnique).toHaveBeenNthCalledWith(1, {
      where: { id: 'op1' },
      select: { id: true, userType: true },
    })
    expect(prisma.user.findUnique).toHaveBeenNthCalledWith(2, {
      where: { username: 'op1' },
      select: { id: true, userType: true },
    })
    expect(members.remove).toHaveBeenCalledWith('ws-1', 'user-op')
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workspace.unassign_operator',
        target: 'User:user-op',
        diff: { userId: 'user-op' },
      }),
    )
  })

  it('目标用户不存在（id/username 均未命中）→ OPERATOR_NOT_ELIGIBLE，不触 members.remove', async () => {
    const { members, audit, service } = makeDeps({ user: null, userByUsername: null })
    await expect(service.unassignOperator('ws-1', 'nobody')).rejects.toMatchObject({
      name: 'OPERATOR_NOT_ELIGIBLE',
    })
    expect(members.remove).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('目标为 CUSTOMER 用户 → OPERATOR_NOT_ELIGIBLE（PLATFORM 校验防误删客户成员记录）', async () => {
    const { members, service } = makeDeps({
      user: { ...OPERATOR_USER, userType: 'CUSTOMER', platformRole: null },
    })
    await expect(service.unassignOperator('ws-1', 'user-cust')).rejects.toMatchObject({
      name: 'OPERATOR_NOT_ELIGIBLE',
    })
    expect(members.remove).not.toHaveBeenCalled()
  })

  it('记录不存在（members.remove 抛 P2025）→ OPERATOR_ASSIGNMENT_NOT_FOUND，不写 audit（重删不再 500）', async () => {
    const { members, audit, service } = makeDeps()
    members.remove.mockRejectedValueOnce(
      Object.assign(new Error('An operation failed because it does not satisfy...'), {
        code: 'P2025',
      }),
    )
    await expect(service.unassignOperator('ws-1', 'user-op')).rejects.toMatchObject({
      name: 'OPERATOR_ASSIGNMENT_NOT_FOUND',
      message: expect.stringContaining('user-op'),
    })
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('members.remove 抛非 P2025 错误 → 原样上抛（不被误吞为 NOT_FOUND）', async () => {
    const { members, service } = makeDeps()
    members.remove.mockRejectedValueOnce(new Error('db down'))
    await expect(service.unassignOperator('ws-1', 'user-op')).rejects.toThrow('db down')
  })
})

describe('workspaceAdminService.listOperators', () => {
  it('只返回 PLATFORM 用户成员（客户成员滤掉），形状 { user, isPrimary }', async () => {
    const { prisma, members, service } = makeDeps()
    const items = await service.listOperators('ws-1')
    expect(members.listMembers).toHaveBeenCalledWith('ws-1')
    // PLATFORM 过滤在 service 层：user.findMany 带 userType 条件
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['user-op', 'u-cust'] }, userType: 'PLATFORM' },
      select: { id: true, username: true, displayName: true },
    })
    expect(items).toEqual([
      { user: { id: 'user-op', username: 'op1', displayName: '顾问一号' }, isPrimary: true },
    ])
  })

  it('无任何成员：listMembers 返回空则不查 user，返回空数组', async () => {
    const { prisma, service } = makeDeps({ memberList: [] })
    const items = await service.listOperators('ws-1')
    expect(items).toEqual([])
    expect(prisma.user.findMany).not.toHaveBeenCalled()
  })

  it('workspace 不存在 → WORKSPACE_NOT_FOUND，不触 members', async () => {
    const { members, service } = makeDeps({ workspace: null })
    await expect(service.listOperators('ws-x')).rejects.toBeInstanceOf(WorkspaceNotFoundError)
    expect(members.listMembers).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 任务 9：计费检查点——create 的 maxWorkspaces 硬限 / setPlatformCredentials
// 的 allowedPlatforms 校验（enforcement on 超限拒绝、off 全放行）
// ---------------------------------------------------------------------------

describe('workspaceAdminService 计费检查点（任务 9）', () => {
  const CREATE_INPUT = { name: '新工作区', defaultBrandName: '品牌', organizationId: 'org-1' }

  it('enforcement on 且 count >= maxWorkspaces → 硬拒 QuotaExceededError，不建 workspace 不发 Key', async () => {
    const { prisma, credentials, service } = makeDeps({
      lockedRows: [{ organizationId: 'org-1', limits: { maxWorkspaces: 2, allowedPlatforms: [] } }],
      workspaceCount: 2,
      withBilling: { enforcement: () => true },
    })

    await expect(service.create(CREATE_INPUT, 'user-op')).rejects.toBeInstanceOf(QuotaExceededError)
    expect(prisma.workspace.create).not.toHaveBeenCalled()
    expect(prisma.organization.create).not.toHaveBeenCalled()
    expect(credentials.issue).not.toHaveBeenCalled()
  })

  it('enforcement on 未超限 → 配额槽事务检查通过后正常创建（锁窗口内创建 + commit）', async () => {
    const { prisma, service, credentials } = makeDeps({
      lockedRows: [{ organizationId: 'org-1', limits: { maxWorkspaces: 10, allowedPlatforms: [] } }],
      workspaceCount: 2,
      withBilling: { enforcement: () => true },
    })

    const result = await service.create(CREATE_INPUT, 'user-op')
    // 配额槽事务已开（检查在事务内），workspace 正常创建 + 初始 Key
    expect(prisma.$transaction).toHaveBeenCalled()
    expect(prisma.workspace.create).toHaveBeenCalled()
    expect(credentials.issue).toHaveBeenCalled()
    expect(result.workspace.id).toBe('ws-1')
  })

  it('enforcement off → 全放行：不开配额事务，创建链路照旧', async () => {
    const { prisma, service } = makeDeps({
      lockedRows: [{ organizationId: 'org-1', limits: { maxWorkspaces: 0, allowedPlatforms: [] } }],
      workspaceCount: 99,
      withBilling: { enforcement: () => false },
    })

    const result = await service.create(CREATE_INPUT, 'user-op')
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(prisma.workspace.create).toHaveBeenCalled()
    expect(result.workspace.id).toBe('ws-1')
  })

  it('未注入 billing（存量装配/测试）→ 零检查零事务，行为与任务 9 前一致', async () => {
    const { prisma, service } = makeDeps()
    await service.create(CREATE_INPUT, 'user-op')
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(prisma.workspace.create).toHaveBeenCalled()
  })

  it('setPlatformCredentials：enforcement on 且平台不在 allowedPlatforms → 硬拒且不写配置', async () => {
    const { prisma, service } = makeDeps({
      oeRow: { organizationId: 'org-1', limits: { maxWorkspaces: 10, allowedPlatforms: ['deepseek'] } },
      withBilling: { enforcement: () => true },
    })

    await expect(
      service.setPlatformCredentials('ws-1', 'gemini', { key: 'k' }, 'user-op'),
    ).rejects.toBeInstanceOf(PlatformNotAllowedError)
    expect(prisma.workspace.update).not.toHaveBeenCalled()
  })

  it('setPlatformCredentials：平台在集合内（或空集合宽限）→ 照常写入', async () => {
    const { prisma, service } = makeDeps({
      oeRow: { organizationId: 'org-1', limits: { maxWorkspaces: 10, allowedPlatforms: ['deepseek'] } },
      withBilling: { enforcement: () => true },
    })

    await service.setPlatformCredentials('ws-1', 'deepseek', { key: 'k' }, 'user-op')
    expect(prisma.workspace.update).toHaveBeenCalled()
  })
})
