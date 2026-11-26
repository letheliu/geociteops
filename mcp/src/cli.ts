import { createRequire } from 'node:module'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { pathToFileURL } from 'node:url'
import { createGeoApi } from './api.js'
import { HELP, parseArgs } from './args.js'
import { loadConfig } from './config.js'
import { startHttpServer } from './http.js'
import { introspectWorkspaceToken } from './introspect.js'
import { createGeoMcpServer, type GeoMcpOptions } from './server.js'
import { isDemoMode } from '../../src/core/demo/mode.js'

const require = createRequire(import.meta.url)
const version = String(require('../package.json').version)

export function mcpOptions(env: NodeJS.ProcessEnv = process.env): GeoMcpOptions {
  const config = loadConfig(env)
  return {
    version,
    preferLocal: config.preferLocal,
    readOnly: isDemoMode(env),
    api: config.apiKey
      ? createGeoApi({
        serviceUrl: config.apiUrl,
        apiKey: config.apiKey,
        workspaceId: config.workspaceId ?? undefined,
      })
      : null,
  }
}

function rateLimitFrom(env: NodeJS.ProcessEnv): { limit: number; windowMs: number } {
  const parsed = Number(env.GEOCITEOPS_MCP_RATE_LIMIT)
  const limit = Number.isInteger(parsed) && parsed > 0 ? parsed : (isDemoMode(env) ? 30 : 60)
  return { limit, windowMs: 60_000 }
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(HELP)
    return
  }
  const options = mcpOptions()
  if (args.http) {
    const config = loadConfig()
    const server = await startHttpServer({
      port: args.port,
      host: args.host,
      rateLimit: rateLimitFrom(process.env),
      authenticate: (token) => introspectWorkspaceToken(config.apiUrl, token),
      createServer: (principal, token) => createGeoMcpServer({
        version: options.version,
        preferLocal: options.preferLocal,
        readOnly: options.readOnly || principal.readOnly,
        principal,
        api: createGeoApi({
          serviceUrl: config.apiUrl,
          apiKey: token,
          workspaceId: principal.workspaceId,
        }),
        secret: token,
      }),
    })
    console.error(`geociteops-mcp http://${args.host}:${server.port}/mcp (bearer)`)
    return
  }
  console.error(`geociteops-mcp stdio (${options.api ? 'remote' : 'local'})`)
  const transport = new StdioServerTransport()
  await createGeoMcpServer(options).connect(transport)
}

function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(entry).href
}

if (isDirectRun()) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
