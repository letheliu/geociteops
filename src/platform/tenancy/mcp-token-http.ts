import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { ApiCredentialHit } from './api-credentials.js'
import { parseCredentialScopes } from './credential-scopes.js'
import { createSlidingWindowLimiter, type SlidingWindowLimiter } from '../../core/lib/sliding-window-limiter.js'

export interface McpTokenDecision {
  status: number
  body: Record<string, unknown>
  wwwAuthenticate?: string
}

const INVALID = {
  status: 401,
  body: { error: 'invalid_token' },
  wwwAuthenticate: 'Bearer error="invalid_token"',
} as const

/**
 * Decide an MCP Bearer introspection.
 * The presented secret is only used as a rate-limit hash and a lookup key.
 * It is never copied into the status, body, or WWW-Authenticate value.
 */
export async function decideMcpToken(input: {
  presented: string | null
  limiter: SlidingWindowLimiter
  findByKey: (key: string) => Promise<ApiCredentialHit | null>
  demoMode: boolean
}): Promise<McpTokenDecision> {
  if (!input.presented) return INVALID
  const bucket = createHash('sha256').update(input.presented).digest('hex')
  if (!input.limiter.check(bucket)) {
    return {
      status: 429,
      body: { error: 'rate_limited' },
      wwwAuthenticate: 'Bearer error="rate_limited"',
    }
  }
  const hit = await input.findByKey(input.presented)
  if (!hit) return INVALID
  return {
    status: 200,
    body: {
      credentialId: hit.credential.id,
      workspaceId: hit.workspace.id,
      scopes: parseCredentialScopes(hit.credential.scopes),
      readOnly: input.demoMode,
    },
  }
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  if (!match) return null
  const token = match[1]
  if (token.length < 8 || token.length > 500) return null
  return token
}

export function registerMcpTokenRoute(
  app: FastifyInstance,
  deps: {
    findByKey: (key: string) => Promise<ApiCredentialHit | null>
    demoMode: boolean
    limit?: number
    windowMs?: number
    now?: () => number
  },
): void {
  const limiter = createSlidingWindowLimiter({
    limit: deps.limit ?? (deps.demoMode ? 30 : 120),
    windowMs: deps.windowMs ?? 60_000,
    now: deps.now,
    label: 'mcp-token',
  })
  app.get('/mcp/token', async (req, reply) => {
    const decision = await decideMcpToken({
      presented: bearerToken(req.headers.authorization),
      limiter,
      findByKey: deps.findByKey,
      demoMode: deps.demoMode,
    })
    reply.header('cache-control', 'no-store')
    if (decision.wwwAuthenticate) reply.header('www-authenticate', decision.wwwAuthenticate)
    return reply.code(decision.status).send(decision.body)
  })
}
