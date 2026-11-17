import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export interface HttpServer {
  port: number
  close: () => Promise<void>
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

/**
 * Stateless Streamable HTTP. Each request gets its own server instance.
 * The default bind is 127.0.0.1, and the Host header must match it.
 */
export function startHttpServer(options: {
  port: number
  host: string
  createServer: () => McpServer
}): Promise<HttpServer> {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!hostAllowed(req.headers.host, options.host)) {
      res.statusCode = 403
      res.end('Forbidden host')
      return
    }
    const path = req.url?.split('?')[0]
    if (path !== '/mcp') {
      res.statusCode = 404
      res.end('Not found')
      return
    }
    const server = options.createServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readJson(req)
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'MCP request failed' }))
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
