import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpPrincipal } from './scopes.js'
import { redactSecret } from './redact.js'
import { createSlidingWindowLimiter } from '../../src/core/lib/sliding-window-limiter.js'

export interface HttpServer {
  port: number
  close: () => Promise<void>
}

export class AuthBackendError extends Error {
  constructor() {
    super('Auth service is unavailable')
    this.name = 'AUTH_BACKEND'
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function hostAllowed(header: string | undefined, bindHost: string): boolean {
  if (bindHost === '0.0.0.0' || bindHost === '::') return true
  const host = (header ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return host === bindHost || host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

export function bearerFromHeader(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header
  if (!raw) return null
  const match = /^Bearer\s+(\S+)$/i.exec(raw.trim())
  if (!match) return null
  const token = match[1]
  if (token.length < 8 || token.length > 500) return null
  return token
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>, www?: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  if (www) res.setHeader('www-authenticate', www)
  res.end(JSON.stringify(body))
}

/**
 * Stateless Streamable HTTP. Each request gets its own server instance.
 * Every request must carry Authorization: Bearer. The token is a workspace
 * API credential. stdio does not use this server.
 */
export function startHttpServer(options: {
  port: number
  host: string
  authenticate: (token: string) => Promise<McpPrincipal | null>
  /** token is the raw bearer. Use it as the API key. Do not log it. */
  createServer: (principal: McpPrincipal, token: string) => McpServer
  rateLimit?: { limit: number; windowMs: number; now?: () => number }
}): Promise<HttpServer> {
  const limiter = createSlidingWindowLimiter({
    limit: options.rateLimit?.limit ?? 60,
    windowMs: options.rateLimit?.windowMs ?? 60_000,
    now: options.rateLimit?.now,
    label: 'mcp-http',
  })

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let presented: string | null = null
    try {
      if (!hostAllowed(req.headers.host, options.host)) {
        sendJson(res, 403, { error: 'forbidden_host' })
        return
      }
      const path = req.url?.split('?')[0]
      if (path !== '/mcp') {
        sendJson(res, 404, { error: 'not_found' })
        return
      }
      presented = bearerFromHeader(req.headers.authorization)
      if (!presented) {
        sendJson(res, 401, { error: 'invalid_token' }, 'Bearer error="invalid_token"')
        return
      }
      const bucket = createHash('sha256').update(presented).digest('hex')
      if (!limiter.check(bucket)) {
        sendJson(res, 429, { error: 'rate_limited' }, 'Bearer error="rate_limited"')
        return
      }
      const principal = await options.authenticate(presented)
      if (!principal) {
        sendJson(res, 401, { error: 'invalid_token' }, 'Bearer error="invalid_token"')
        return
      }
      const server = options.createServer(principal, presented)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readJson(req)
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (err) {
      if (err instanceof AuthBackendError) {
        if (!res.headersSent) sendJson(res, 503, { error: 'auth_unavailable' })
        return
      }
      if (!res.headersSent) {
        const message = redactSecret(err instanceof Error ? err.message : 'MCP request failed', presented)
        sendJson(res, 500, { error: message || 'MCP request failed' })
      }
    }
  })

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(options.port, options.host, () => {
      const address = httpServer.address()
      const port = typeof address === 'object' && address ? address.port : options.port
      resolve({
        port,
        close: () => new Promise((done, fail) => {
          httpServer.close((err) => (err ? fail(err) : done()))
        }),
      })
    })
  })
}
