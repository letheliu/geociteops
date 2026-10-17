import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Workspace } from '@prisma/client'
import { workspaceRouter } from './router.js'

const NOW = new Date('2026-10-14T08:00:00.000Z')

/** 信封密文样例（任务 12 前 get 整实体回传，密文随之泄漏——脱敏后绝不能再现） */
const SAMPLE_ENVELOPE =
  '{"__v":1,"iv":"aXZpdjEyM2J2eWdz","tag":"dGFnMTIzNDU2Nzg=","ct":"c2VjcmV0LWNpcGhlcnRleHQ="}'

/** 旧明文形态样例（未加密的 platformConfig 对象，含样例凭证值） */
const SAMPLE_PLAIN_CONFIG = {
  deepseek: { DEEPSEEK_API_KEY: 'sk-leak-1234567890abcdef' },
  competitors: ['rival.com'],
}

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
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as unknown as Workspace
}

let getWorkspaceSummary: ReturnType<typeof vi.fn>

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    actor: { kind: 'apiKey', credential: { id: 'cred-1' } },
    workspace: makeWorkspace(),
    services: { getWorkspaceSummary },
    requestMeta: { ip: '1.2.3.4', requestId: 'req-1', method: 'GET', headers: {} },
    ...overrides,
  } as any
}

beforeEach(() => {
  getWorkspaceSummary = vi.fn(async () => ({
    competitors: ['figma.com', 'miro.com'],
    platforms: {
      deepseek: { configured: true, hint: 'b12c' },
      qwen: { configured: false, hint: '' },
    },
  }))
})

describe('workspaceRouter.get（protectedProcedure，脱敏投影）', () => {
  it('只返回 8 个脱敏字段：基础信息来自 ctx.workspace，platformSummary/competitors 来自注入的 getWorkspaceSummary', async () => {
    const caller = workspaceRouter.createCaller(makeCtx())

    const result = await caller.get()

    expect(getWorkspaceSummary).toHaveBeenCalledWith('ws-1')
    expect(result).toEqual({
      id: 'ws-1',
      name: '客户工作区',
      domain: 'acme.com',
      llmsTxtUrl: 'https://acme.com/llms.txt',
      defaultBrandName: 'Acme',
      status: 'ACTIVE',
      platformSummary: {
        deepseek: { configured: true, hint: 'b12c' },
        qwen: { configured: false, hint: '' },
      },
      competitors: ['figma.com', 'miro.com'],
    })
  })

  it('序列化全文不含 platformConfig 键、不含信封字段（ct/iv/tag）、不含密文样例值', async () => {
    const caller = workspaceRouter.createCaller(makeCtx())

    const serialized = JSON.stringify(await caller.get())

    expect(serialized).not.toContain('platformConfig')
    expect(serialized).not.toContain('"ct"')
    expect(serialized).not.toContain('"iv"')
    expect(serialized).not.toContain('"tag"')
    expect(serialized).not.toContain(SAMPLE_ENVELOPE)
    expect(serialized).not.toContain('c2VjcmV0')
  })

  it('旧明文形态（platformConfig 为含 sk- 凭证的对象）同样不泄漏', async () => {
    const ctx = makeCtx({ workspace: makeWorkspace({ platformConfig: SAMPLE_PLAIN_CONFIG }) })
    const caller = workspaceRouter.createCaller(ctx)

    const serialized = JSON.stringify(await caller.get())

    expect(serialized).not.toContain('platformConfig')
    expect(serialized).not.toContain('sk-leak')
    expect(serialized).not.toContain('DEEPSEEK_API_KEY')
    expect(serialized).not.toContain('rival.com')
  })

  it('resolver 抛错 → 原样上抛（不吞错）', async () => {
    getWorkspaceSummary.mockRejectedValue(new Error('resolver down'))
    const caller = workspaceRouter.createCaller(makeCtx())

    await expect(caller.get()).rejects.toThrow('resolver down')
  })
})

describe('公开路由已下线（register / setPlatformConfig）', () => {
  it('router 运行时定义键只剩 get', () => {
    const procedures = (workspaceRouter as unknown as { _def: { procedures: Record<string, unknown> } })
      ._def.procedures
    expect(Object.keys(procedures)).toEqual(['get'])
  })

  it('router 源文件不再包含 register / setPlatformConfig 过程定义', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./router.ts', import.meta.url)),
      'utf-8',
    )
    expect(/\bregister\s*:/.test(source)).toBe(false)
    expect(/\bsetPlatformConfig\s*:/.test(source)).toBe(false)
  })
})
