import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import type { GeoApi } from './api-types.js'
import { startHttpServer } from './http.js'
import { createGeoMcpServer } from './server.js'
import type { McpPrincipal } from './scopes.js'

const SECRET = 'geo_http_secret_value'

function principal(scopes: string[], readOnly = false): McpPrincipal {
  return { credentialId: 'cred-1', workspaceId: 'ws-1', scopes, readOnly }
}

function initializeBody() {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'auth-test', version: '0' },
    },
  })
}

async function post(port: number, headers: Record<string, string>, body = initializeBody()) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body,
  })
}

describe('MCP HTTP auth', () => {
  it('缺少令牌时 401，且不调用校验', async () => {
    const authenticate = vi.fn()
    const http = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      authenticate,
      createServer: () => createGeoMcpServer({ api: null, preferLocal: false, version: '0' }),
    })
    try {
      const response = await post(http.port, {})
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'invalid_token' })
      expect(authenticate).not.toHaveBeenCalled()
    } finally {
      await http.close()
    }
  })

  it('无效令牌 401，响应不含令牌', async () => {
    const http = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      authenticate: async () => null,
      createServer: () => createGeoMcpServer({ api: null, preferLocal: false, version: '0' }),
    })
    try {
      const response = await post(http.port, { authorization: `Bearer ${SECRET}` })
      const text = await response.text()
      expect(response.status).toBe(401)
      expect(text).toContain('invalid_token')
      expect(text).not.toContain(SECRET)
      expect(response.headers.get('www-authenticate')).not.toContain(SECRET)
    } finally {
      await http.close()
    }
  })

  it('已吊销令牌与无效令牌同样 401，且不创建 MCP 会话', async () => {
    const create = vi.fn()
    const http = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      authenticate: async (token) => (token === SECRET ? null : principal(['*'])),
      createServer: () => {
        create()
        return createGeoMcpServer({ api: null, preferLocal: false, version: '0' })
      },
    })
    try {
      const response = await post(http.port, { authorization: `Bearer ${SECRET}` })
      expect(response.status).toBe(401)
      expect(await response.text()).not.toContain(SECRET)
      expect(create).not.toHaveBeenCalled()
    } finally {
      await http.close()
    }
  })

  it('错误信息里的令牌会被抹掉', async () => {
    const http = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      authenticate: async () => principal(['read']),
      createServer: () => {
        throw new Error(`backend echoed ${SECRET}`)
      },
    })
    try {
      const response = await post(http.port, { authorization: `Bearer ${SECRET}` })
      const text = await response.text()
      expect(response.status).toBe(500)
      expect(text).not.toContain(SECRET)
      expect(text).toContain('[redacted]')
    } finally {
      await http.close()
    }
  })

  it('同一令牌超过限额后 429，且不再校验', async () => {
    let now = 1_000
    const authenticate = vi.fn(async () => principal(['read']))
    const http = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      authenticate,
      rateLimit: { limit: 2, windowMs: 60_000, now: () => now },
      createServer: () => createGeoMcpServer({ api: null, preferLocal: false, version: '0' }),
    })
    try {
      expect((await post(http.port, { authorization: `Bearer ${SECRET}` })).status).toBe(200)
      expect((await post(http.port, { authorization: `Bearer ${SECRET}` })).status).toBe(200)
      const blocked = await post(http.port, { authorization: `Bearer ${SECRET}` })
      expect(blocked.status).toBe(429)
      expect(await blocked.text()).not.toContain(SECRET)
      expect(authenticate).toHaveBeenCalledTimes(2)
    } finally {
      await http.close()
    }
  })
})

describe('MCP tool scopes', () => {
  async function call(scopes: string[], readOnly: boolean) {
    const mutate = vi.fn()
    const server = createGeoMcpServer({
      api: { geoHealth: { start: { mutate } } } as unknown as GeoApi,
      preferLocal: false,
      version: '0',
      principal: principal(scopes, readOnly),
      secret: SECRET,
    })
    const client = new Client({ name: 'scope-test', version: '0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const result = await client.callTool({
        name: 'run_geo_health_check',
        arguments: { brandName: 'Acme Draw', siteUrl: 'https://acmedraw.example' },
      })
      return { result, mutate }
    } finally {
      await client.close()
      await server.close()
    }
  }

  it('read 令牌不能启动体检，且不调用 API', async () => {
    const { result, mutate } = await call(['read'], false)
    expect(result.isError).toBe(true)
    const text = JSON.stringify(result)
    expect(text).toContain('run-checks')
    expect(text).not.toContain(SECRET)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('DEMO_MODE 下即使有 run-checks 也拒绝写操作', async () => {
    const { result, mutate } = await call(['run-checks'], true)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('read-only')
    expect(mutate).not.toHaveBeenCalled()
  })

  it('run-checks 令牌可以读取报告工具的范围', async () => {
    const server = createGeoMcpServer({
      api: null,
      preferLocal: true,
      version: '0',
      principal: principal(['read']),
    })
    const client = new Client({ name: 'scope-test', version: '0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const result = await client.callTool({
        name: 'generate_llms_txt',
        arguments: {
          brandName: 'Acme Draw',
          tagline: 'Drawing tools',
          sections: [{ title: 'Docs', items: [{ label: 'Guide', url: 'https://acmedraw.example/guide', description: 'Start' }] }],
        },
      })
      expect(result.isError).toBeUndefined()
      expect(JSON.stringify(result)).toContain('Acme Draw')
    } finally {
      await client.close()
      await server.close()
    }
  })
})
