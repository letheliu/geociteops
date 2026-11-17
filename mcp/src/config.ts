export interface McpConfig {
  apiUrl: string
  apiKey: string | null
  workspaceId: string | null
  preferLocal: boolean
}

const DEFAULT_API_URL = 'http://localhost:4000'

function blankToNull(value: string | undefined): string | null {
  const text = value?.trim()
  return text ? text : null
}

function preferLocal(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const apiUrl = blankToNull(env.GEOCITEOPS_API_URL) ?? DEFAULT_API_URL
  let parsed: URL
  try {
    parsed = new URL(apiUrl)
  } catch {
    throw new Error(`GEOCITEOPS_API_URL is not a URL: ${apiUrl}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('GEOCITEOPS_API_URL must be http or https')
  }
  return {
    apiUrl: parsed.toString().replace(/\/$/, ''),
    apiKey: blankToNull(env.GEOCITEOPS_API_KEY),
    workspaceId: blankToNull(env.GEOCITEOPS_WORKSPACE_ID),
    preferLocal: preferLocal(env.GEOCITEOPS_PREFER_LOCAL),
  }
}
