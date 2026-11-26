import { createHash } from 'node:crypto'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { createSlidingWindowLimiter } from '../../core/lib/sliding-window-limiter.js'
import { decideMcpToken, registerMcpTokenRoute } from './mcp-token-http.js'

const SECRET = 'geo_introspect_secret_value'

function hit(scopes: string[]) {
  return {
    credential: { id: 'cred-1', scopes } as never,
    workspace: { id: 'ws-1' } as never,
  }
}

describe('decideMcpToken', () => {
  it('缺少令牌 → 401，不调用查找', async () => {
    const findByKey = vi.fn()
    const decision = await decideMcpToken({
      presented: null,
      limiter: createSlidingWindowLimiter({ limit: 5, windowMs: 60_000 }),
      findByKey,
      demoMode: false,
    })
    expect(decision.status).toBe(401)
    expect(decision.body).toEqual({ error: 'invalid_token' })
    expect(findByKey).not.toHaveBeenCalled()
  })

  it('无效或已吊销（查找返回 null）→ 401，响应不含令牌', async () => {
    const decision = await decideMcpToken({
      presented: SECRET,
      limiter: createSlidingWindowLimiter({ limit: 5, windowMs: 60_000 }),
      findByKey: async () => null,
      demoMode: false,
    })
    expect(decision.status).toBe(401)
    expect(JSON.stringify(decision)).not.toContain(SECRET)
    expect(decision.wwwAuthenticate).not.toContain(SECRET)
  })

  it('有效令牌返回范围和只读标记，不回显令牌或哈希', async () => {
    const decision = await decideMcpToken({
      presented: SECRET,
      limiter: createSlidingWindowLimiter({ limit: 5, windowMs: 60_000 }),
      findByKey: async () => hit(['read']),
      demoMode: true,
    })
    expect(decision.status).toBe(200)
    expect(decision.body).toEqual({
      credentialId: 'cred-1',
      workspaceId: 'ws-1',
      scopes: ['read'],
      readOnly: true,
    })
    const encoded = JSON.stringify(decision)
    expect(encoded).not.toContain(SECRET)
    expect(encoded).not.toContain(createHash('sha256').update(SECRET).digest('hex'))
  })

  it('按令牌限流，超限后不再查找', async () => {
    const findByKey = vi.fn(async () => hit(['*']))
    const limiter = createSlidingWindowLimiter({ limit: 1, windowMs: 60_000 })
    const first = await decideMcpToken({ presented: SECRET, limiter, findByKey, demoMode: false })
    const second = await decideMcpToken({ presented: SECRET, limiter, findByKey, demoMode: false })
    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
    expect(findByKey).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(second)).not.toContain(SECRET)
  })
})

describe('GET /mcp/token', () => {
  it('吊销后的查找结果是 401，响应体和 WWW-Authenticate 都不含令牌', async () => {
    const app = Fastify({ logger: false })
    registerMcpTokenRoute(app, {
      demoMode: false,
      limit: 10,
      findByKey: async () => null,
    })
    const response = await app.inject({
      method: 'GET',
      url: '/mcp/token',
      headers: { authorization: `Bearer ${SECRET}` },
    })
    expect(response.statusCode).toBe(401)
    expect(response.body).not.toContain(SECRET)
    expect(response.headers['www-authenticate']).not.toContain(SECRET)
    expect(response.json()).toEqual({ error: 'invalid_token' })
    await app.close()
  })
})
