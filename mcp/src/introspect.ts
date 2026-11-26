import type { McpPrincipal } from './scopes.js'
import { AuthBackendError } from './http.js'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * Ask the GeoCiteOps API whether a Bearer token is a live workspace credential.
 * Failures become null (rejected) or AuthBackendError (API unreachable).
 * The token is sent only as a header and is never placed in an error message.
 */
export async function introspectWorkspaceToken(apiUrl: string, token: string): Promise<McpPrincipal | null> {
  let response: Response
  try {
    response = await fetch(`${apiUrl}/mcp/token`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new AuthBackendError()
  }
  if (response.status === 401 || response.status === 403) return null
  if (!response.ok) throw new AuthBackendError()
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new AuthBackendError()
  }
  const row = asRecord(body)
  const credentialId = row && typeof row.credentialId === 'string' ? row.credentialId : ''
  const workspaceId = row && typeof row.workspaceId === 'string' ? row.workspaceId : ''
  const scopes = row && Array.isArray(row.scopes) ? row.scopes.filter((item): item is string => typeof item === 'string') : null
  if (!credentialId || !workspaceId || !scopes) throw new AuthBackendError()
  return {
    credentialId,
    workspaceId,
    scopes,
    readOnly: row?.readOnly === true,
  }
}
