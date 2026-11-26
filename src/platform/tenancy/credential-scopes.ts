/** Workspace API token scopes. `*` is the legacy full-access scope. */

export const CREDENTIAL_SCOPE_READ = 'read'
export const CREDENTIAL_SCOPE_RUN = 'run-checks'
export const CREDENTIAL_SCOPE_ALL = '*'

const ISSUABLE = new Set([CREDENTIAL_SCOPE_READ, CREDENTIAL_SCOPE_RUN, CREDENTIAL_SCOPE_ALL])

export class ApiCredentialScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'API_CREDENTIAL_SCOPE'
  }
}

export function parseCredentialScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * Scopes stored at issue time.
 * Omitted scopes stay `*` so existing workspace bootstrap keys keep full SDK access.
 * An explicit list is deduped. `*` alone wins if it is mixed with narrower scopes.
 */
export function normalizeIssuedScopes(scopes: readonly string[] | undefined): string[] {
  if (!scopes || scopes.length === 0) return [CREDENTIAL_SCOPE_ALL]
  const unique: string[] = []
  for (const scope of scopes) {
    if (!ISSUABLE.has(scope)) {
      throw new ApiCredentialScopeError('不支持的凭证范围')
    }
    if (!unique.includes(scope)) unique.push(scope)
  }
  if (unique.includes(CREDENTIAL_SCOPE_ALL)) return [CREDENTIAL_SCOPE_ALL]
  return unique
}

/** `run-checks` includes `read` so a check token can poll the job it started. */
export function credentialAllows(scopes: readonly string[], needed: 'read' | 'run-checks'): boolean {
  if (scopes.includes(CREDENTIAL_SCOPE_ALL)) return true
  if (needed === 'read') {
    return scopes.includes(CREDENTIAL_SCOPE_READ) || scopes.includes(CREDENTIAL_SCOPE_RUN)
  }
  return scopes.includes(CREDENTIAL_SCOPE_RUN)
}
