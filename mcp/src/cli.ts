import { createRequire } from 'node:module'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { pathToFileURL } from 'node:url'
import { createGeoApi } from './api.js'
import { HELP, parseArgs } from './args.js'
import { loadConfig } from './config.js'
import { startHttpServer } from './http.js'
import { createGeoMcpServer, type GeoMcpOptions } from './server.js'

const require = createRequire(import.meta.url)
const version = String(require('../package.json').version)

export function mcpOptions(env: NodeJS.ProcessEnv = process.env): GeoMcpOptions {
  const config = loadConfig(env)
  return {
    version,
    preferLocal: config.preferLocal,
    api: config.apiKey
      ? createGeoApi({
        serviceUrl: config.apiUrl,
        apiKey: config.apiKey,
        workspaceId: config.workspaceId ?? undefined,
      })
      : null,
  }
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(HELP)
    return
  }
  const options = mcpOptions()
  if (args.http) {
    const server = await startHttpServer({
      port: args.port,
      host: args.host,
      createServer: () => createGeoMcpServer(options),
    })
    console.error(`geociteops-mcp http://${args.host}:${server.port}/mcp (${options.api ? 'remote' : 'local'})`)
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
