import { describe, expect, it, vi } from 'vitest'
import { AgentReadinessError } from './errors.js'
import { agentReadinessRouter } from './router.js'

function caller(service: Record<string, unknown>) {
  return agentReadinessRouter.createCaller({
    workspace: { id: 'ws-1', status: 'ACTIVE' },
    actor: { kind: 'apiKey', credential: { id: 'cred-1', workspaceId: 'ws-1' } },
    requestMeta: { ip: '203.0.113.10', requestId: 'req-1', headers: { 'x-geo-csrf': '1' } },
    services: { agentReadiness: service },
  } as any)
}

describe('agentReadinessRouter', () => {
  it('starts, reads, and lists inside the workspace', async () => {
    const service = {
      start: vi.fn(async () => ({ id: 'a1', status: 'QUEUED' })),
      get: vi.fn(async () => ({ id: 'a1', report: null })),
      list: vi.fn(async () => []),
    }
    const api = caller(service)
    await api.start({ url: 'https://example.com/' })
    await api.get({ id: 'a1' })
    await api.list({ limit: 10 })
    expect(service.start).toHaveBeenCalledWith('ws-1', 'https://example.com/')
    expect(service.get).toHaveBeenCalledWith('ws-1', 'a1')
    expect(service.list).toHaveBeenCalledWith('ws-1', 10)
  })

  it('maps SSRF and missing rows onto tRPC errors', async () => {
    const service = {
      start: vi.fn(async () => { throw new AgentReadinessError('SSRF_BLOCKED', '目标地址被拒绝') }),
      get: vi.fn(async () => { throw new AgentReadinessError('NOT_FOUND', '审计记录不存在') }),
      list: vi.fn(),
    }
    const api = caller(service)
    await expect(api.start({ url: 'http://127.0.0.1/' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(api.get({ id: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
