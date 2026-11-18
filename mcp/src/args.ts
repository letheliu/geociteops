export interface CliArgs {
  http: boolean
  port: number
  host: string
  help: boolean
}

export function parseArgs(argv: string[]): CliArgs {
  let http = false
  let port = 3333
  let host = '127.0.0.1'
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--http') http = true
    else if (arg === '--help' || arg === '-h') help = true
    else if (arg === '--port') {
      const raw = argv[++i]
      const parsed = Number(raw)
      if (!raw || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error('--port must be an integer from 1 to 65535')
      }
      port = parsed
    } else if (arg === '--host') {
      const value = argv[++i]
      if (!value) throw new Error('--host requires a value')
      host = value
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return { http, port, host, help }
}

export const HELP = `geociteops-mcp

stdio (default):
  npx @geociteops/mcp

Streamable HTTP on localhost:
  npx @geociteops/mcp --http --port 3333 --host 127.0.0.1

Environment:
  GEOCITEOPS_API_URL       API base URL (default http://localhost:4000)
  GEOCITEOPS_API_KEY       Workspace API key. Omit it to use local tools only.
  GEOCITEOPS_WORKSPACE_ID  Optional x-workspace-id. API keys already select a workspace.
  GEOCITEOPS_PREFER_LOCAL  1/true to force in-process readiness, llms.txt, and JSON-LD.
`
