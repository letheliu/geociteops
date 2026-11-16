import { describe, expect, it, vi } from 'vitest'
import { geoHealthRouter } from './router.js'

function caller(service: Record<string, unknown>) {
  return geoHealthRouter.createCaller({
    actor: { kind: 'apiKey', credential: { id: 'cred-1', workspaceId: 'ws-1' } },
    workspace: { id: 'ws-1', status: 'ACTIVE' },
    services: { geoHealth: service },
    requestMeta: { ip: '203.0.113.10', requestId: 'r1', method: 'POST', headers: { 'x-geo-csrf': '1' } },
  } as any)
}

describe('geoHealthRouter', () => {
  it('passes the workspace id into start, get, and list', async () => {
    const service = {
      start: vi.fn(async () => ({ id: 'c1' })),
      get: vi.fn(async () => ({ id: 'c1' })),
      list: vi.fn(async () => []),
    }
    const api = caller(service)
    await api.start({ brandName: 'Acme', siteUrl: 'https://acme.example' })
    await api.get({ id: 'c1' })
    await api.list({ limit: 5 })
    expect(service.start).toHaveBeenCalledWith('ws-1', expect.objectContaining({ brandName: 'Acme' }))
    expect(service.get).toHaveBeenCalledWith('ws-1', 'c1')
    expect(service.list).toHaveBeenCalledWith('ws-1', 5)
  })
})
