import { describe, it, expect, vi } from 'vitest'
import type { Workspace } from '@prisma/client'
import { appRouter } from '../src/router.js'

/**
 * 任务 16：SDK 通道（x-api-key）兼容回归。
 *
 * 与单元测试（各模块 router.test.ts 直接对子 router createCaller）不同，
 * 这里对**真实 appRouter**（完整命名空间 + 中间件链）createCaller：
 * actor = { kind: 'apiKey', credential }，workspace = 凭证绑定工作区，
 * 从而证明任务 9-15 的 Context 双通道 / 判定矩阵 / workspace.get 脱敏投影
 * 没有破坏 SDK 调用路径（createGeoClient 经 httpBatchLink 走的就是这条链）。
 */

const NOW = new Date('2026-10-14T08:00:00.000Z')

/** 信封密文样例：脱敏投影绝不能让其出现在响应里 */
const SAMPLE_ENVELOPE =
  '{"__v":1,"iv":"aXZpdjEyM2J2eWdz","tag":"dGFnMTIzNDU2Nzg=","ct":"c2VjcmV0LWNpcGhlcnRleHQ="}'

function makeWorkspace(overrides: Record<string, unknown> = {}): Workspace {
  return {
    id: 'ws-1',
    name: '客户工作区',
    defaultBrandName: 'Acme',
    domain: 'acme.com',
    llmsTxtUrl: 'https://acme.com/llms.txt',
    status: 'ACTIVE',
    organizationId: 'org-1',
    platformConfig: SAMPLE_ENVELOPE,
    publicationConfig: '{}',
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as unknown as Workspace
}

/** 各模块代表性 query 触达的最小 services mock（按被测端点实际调用面裁剪） */
function makeServices() {
  return {
    getWorkspaceSummary: vi.fn(async () => ({
      competitors: ['figma.com'],
      platforms: { deepseek: { configured: true, hint: 'b12c' } },
    })),
    prisma: {
      citationEvent: { findMany: vi.fn().mockResolvedValue([]) },
      contentPage: { findMany: vi.fn().mockResolvedValue([]) },
    },
    taskService: {
      list: vi.fn().mockResolvedValue([]),
      review: vi.fn().mockResolvedValue({ id: 't-1' }),
    },
    schema: { list: vi.fn().mockResolvedValue([]) },
    kg: { listEntities: vi.fn().mockResolvedValue([]) },
    diagnostic: {
      projectService: { list: vi.fn().mockResolvedValue([]) },
    },
  }
}

/** SDK 请求形态的 ctx：apiKey actor + 绑定 workspace + 带 csrf 头的 requestMeta */
function makeSdkCaller(services: ReturnType<typeof makeServices>, workspace: Workspace = makeWorkspace()) {
  return appRouter.createCaller({
    actor: { kind: 'apiKey', credential: { id: 'c1', workspaceId: workspace.id } },
    workspace,
    services,
    requestMeta: {
      ip: '203.0.113.10',
      requestId: 'req-sdk-1',
      method: 'GET',
      headers: { 'x-geo-csrf': '1' },
    },
  } as any)
}

describe('SDK 通道兼容（真实 appRouter.createCaller + apiKey actor）', () => {
  it('workspace.get 返回 8 字段脱敏投影，不含 platformConfig（ctx.workspace 即凭证绑定工作区）', async () => {
    const services = makeServices()
    const caller = makeSdkCaller(services)

    const result = await caller.workspace.get()

    expect(services.getWorkspaceSummary).toHaveBeenCalledWith('ws-1')
    expect(result).toEqual({
      id: 'ws-1',
      name: '客户工作区',
      domain: 'acme.com',
      llmsTxtUrl: 'https://acme.com/llms.txt',
      defaultBrandName: 'Acme',
      status: 'ACTIVE',
      platformSummary: { deepseek: { configured: true, hint: 'b12c' } },
      competitors: ['figma.com'],
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('platformConfig')
    expect(serialized).not.toContain(SAMPLE_ENVELOPE)
    expect(serialized).not.toContain('"ct"')
  })

  it('citation.getReport 以 ctx.workspace.id 过滤事件', async () => {
    const services = makeServices()
    const caller = makeSdkCaller(services)

    const { events } = await caller.citation.getReport({
      dateRange: { start: '2026-10-01', end: '2026-10-14' },
    })

    expect(events).toEqual([])
    expect(services.prisma.citationEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: 'ws-1' }),
      }),
    )
  })

  it('content.pages.list 以 ctx.workspace.id 过滤页面', async () => {
    const services = makeServices()
    const caller = makeSdkCaller(services)

    await caller.content.pages.list({})

    expect(services.prisma.contentPage.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1' },
    })
  })

  it('tasks.list 收到的 workspaceId 来自 ctx.workspace.id', async () => {
    const services = makeServices()
    const caller = makeSdkCaller(services)

    await caller.tasks.list(undefined)

    expect(services.taskService.list).toHaveBeenCalledWith('ws-1', undefined)
  })

  it('schema.list 收到的 workspaceId 来自 ctx.workspace.id', async () => {
    const services = makeServices()
    const caller = makeSdkCaller(services)

    await caller.schema.list(undefined)

    expect(services.schema.list).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      pageUrl: undefined,
      schemaType: undefined,
    })
  })

  it('kg.listEntities 收到的 workspaceId 来自 ctx.workspace.id', async () => {
    const services = makeServices()
    const caller = makeSdkCaller(services)

    await caller.kg.listEntities(undefined)

    expect(services.kg.listEntities).toHaveBeenCalledWith('ws-1', { type: undefined })
  })

  it('diagnostic.projects.list 收到的 workspaceId 来自 ctx.workspace.id', async () => {
    const services = makeServices()
    const caller = makeSdkCaller(services)

    await caller.diagnostic.projects.list(undefined)

    expect(services.diagnostic.projectService.list).toHaveBeenCalledWith('ws-1', undefined)
  })
})

describe('判定矩阵（API Key 通道与浏览器同矩阵）', () => {
  it('ACTIVE 工作区：mutation 放行（csrf 头在场，服务被真实触达）', async () => {
    const services = makeServices()
    const caller = makeSdkCaller(services, makeWorkspace({ status: 'ACTIVE' }))

    const result = await caller.tasks.review({ id: 't-1', approved: true })

    expect(result.id).toBe('t-1')
    expect(services.taskService.review).toHaveBeenCalledWith('t-1', true, undefined)
  })

  it('SUSPENDED 工作区：query 放行', async () => {
    const services = makeServices()
    const caller = makeSdkCaller(services, makeWorkspace({ status: 'SUSPENDED' }))

    const result = await caller.workspace.get()

    expect(result.status).toBe('SUSPENDED')
    expect(services.getWorkspaceSummary).toHaveBeenCalledWith('ws-1')
  })

  it('SUSPENDED 工作区：mutation 被 FORBIDDEN 拒绝，服务层未被触达', async () => {
    const services = makeServices()
    const caller = makeSdkCaller(services, makeWorkspace({ status: 'SUSPENDED' }))

    await expect(caller.tasks.review({ id: 't-1', approved: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('SUSPENDED'),
    })
    expect(services.taskService.review).not.toHaveBeenCalled()
  })
})
