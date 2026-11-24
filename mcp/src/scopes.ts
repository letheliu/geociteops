import { credentialAllows, parseCredentialScopes } from '../../src/platform/tenancy/credential-scopes.js'

export interface McpPrincipal {
  credentialId: string
  workspaceId: string
  scopes: string[]
  readOnly: boolean
}

export interface ToolSideEffects {
  scope: 'read' | 'run-checks'
  /** Persists workspace data. */
  writes: boolean
  /** Calls a paid model. */
  paidLlm: boolean
  /** Always fetches a site or calls an engine. */
  outbound: boolean
}

export const TOOL_SIDE_EFFECTS: Record<string, ToolSideEffects> = {
  run_geo_health_check: { scope: 'run-checks', writes: true, paidLlm: true, outbound: true },
  get_geo_health_report: { scope: 'read', writes: false, paidLlm: false, outbound: false },
  run_agent_readiness_audit: { scope: 'run-checks', writes: true, paidLlm: false, outbound: true },
  get_agent_readiness_report: { scope: 'read', writes: false, paidLlm: false, outbound: false },
  list_queries: { scope: 'read', writes: false, paidLlm: false, outbound: false },
  add_queries: { scope: 'run-checks', writes: true, paidLlm: false, outbound: false },
  run_citation_check: { scope: 'run-checks', writes: true, paidLlm: true, outbound: true },
  get_share_of_voice: { scope: 'read', writes: false, paidLlm: false, outbound: false },
  optimize_content: { scope: 'run-checks', writes: true, paidLlm: true, outbound: false },
  generate_schema: { scope: 'read', writes: false, paidLlm: false, outbound: false },
  generate_llms_txt: { scope: 'read', writes: false, paidLlm: false, outbound: false },
  extract_knowledge_graph: { scope: 'run-checks', writes: true, paidLlm: true, outbound: false },
}

function record(args: unknown): Record<string, unknown> | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  return args as Record<string, unknown>
}

function argsGoOutbound(name: string, args: unknown): boolean {
  const row = record(args)
  if (!row) return false
  if (name === 'generate_llms_txt' || name === 'optimize_content' || name === 'extract_knowledge_graph') {
    return typeof row.url === 'string' && row.url.trim().length > 0
  }
  return false
}

/**
 * HTTP calls pass a principal. stdio passes null and is limited only when the
 * process itself is in read-only demo mode.
 * Denial text never includes the token.
 */
export function toolDenial(
  name: string,
  input: { principal: McpPrincipal | null; readOnly: boolean },
  args?: unknown,
): string | null {
  const policy = TOOL_SIDE_EFFECTS[name]
  const readOnly = input.readOnly || input.principal?.readOnly === true
  const outbound = (policy?.outbound ?? false) || argsGoOutbound(name, args)
  const writes = policy?.writes ?? false
  const paid = policy?.paidLlm ?? false
  if (readOnly && (writes || paid || outbound || policy?.scope === 'run-checks')) {
    return 'DEMO_MODE is read-only. This tool writes workspace data, calls a paid model, or fetches a site, so it stays off.'
  }
  if (!input.principal) return null
  if (!policy) return 'This tool is not available to an API token.'
  const scopes = parseCredentialScopes(input.principal.scopes)
  if (!credentialAllows(scopes, policy.scope)) {
    return `This token cannot call ${name}. It needs the ${policy.scope} scope. Issue one in the console. The token is not included in this error.`
  }
  return null
}
