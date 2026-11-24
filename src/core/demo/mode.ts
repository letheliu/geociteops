/**
 * Public-demo switch. `DEMO_MODE=on` makes one instance safe to put on the
 * internet: read-only API, no paid outbound work, a tighter rate limit, and a
 * login hint that never includes the demo password.
 *
 * Accepted on-values (case-insensitive, surrounding space ignored):
 * `1`, `true`, `on`, `yes`. Anything else, including unset, is off.
 */

export const DEMO_FIXTURE = {
  brand: 'Acme Draw',
  site: 'https://acmedraw.example',
  domain: 'acmedraw.example',
  username: 'demo-viewer',
  competitors: [
    { name: 'Northwind Ink', domain: 'northwind.example' },
    { name: 'Lumen Sketch', domain: 'lumen.example' },
    { name: 'Harbor Paint', domain: 'harbor.example' },
  ],
} as const

const TRUTHY = new Set(['1', 'true', 'on', 'yes'])

export type DemoEnv = Record<string, string | undefined>

export function isDemoMode(env: DemoEnv = process.env): boolean {
  const raw = env.DEMO_MODE
  if (typeof raw !== 'string') return false
  return TRUTHY.has(raw.trim().toLowerCase())
}

/** Mutations a public visitor may still call. Password change is not one of them. */
const DEMO_MUTATION_ALLOWLIST = new Set(['auth.login', 'auth.logout'])

export function demoMutationAllowed(input: { demoMode: boolean; type: string; path: string }): boolean {
  if (!input.demoMode) return true
  if (input.type !== 'mutation') return true
  return DEMO_MUTATION_ALLOWLIST.has(input.path)
}

export interface DemoPublicStatus {
  enabled: boolean
  /** Sign-in name. Null when demo mode is off. Never a password. */
  username: string | null
  /**
   * Optional text the operator published with `DEMO_PUBLIC_PASSWORD_HINT`.
   * This function does not read `DEMO_ACCOUNT_PASSWORD`.
   */
  note: string | null
  readOnly: boolean
}

const MAX_NOTE_LENGTH = 200

export function demoPublicStatus(env: DemoEnv = process.env): DemoPublicStatus {
  if (!isDemoMode(env)) {
    return { enabled: false, username: null, note: null, readOnly: false }
  }
  const username = (env.DEMO_USERNAME ?? '').trim() || DEMO_FIXTURE.username
  const rawNote = (env.DEMO_PUBLIC_PASSWORD_HINT ?? '').replace(/[\r\n]+/g, ' ').trim()
  const note = rawNote ? rawNote.slice(0, MAX_NOTE_LENGTH) : null
  return { enabled: true, username, note, readOnly: true }
}

export function demoWorkspaceDomain(env: DemoEnv = process.env): string {
  const domain = (env.DEMO_WORKSPACE_DOMAIN ?? '').trim()
  return domain || DEMO_FIXTURE.domain
}

/** Global HTTP limit. The non-demo number matches the historical server default. */
export function httpRateLimit(demoMode: boolean): { max: number; timeWindow: '1 minute' } {
  return { max: demoMode ? 60 : 300, timeWindow: '1 minute' }
}

/** Login attempts per IP. The non-demo number matches `createLoginRateLimiter`'s default. */
export function loginAttemptLimit(demoMode: boolean): { limit: number; windowMs: number } {
  return demoMode ? { limit: 5, windowMs: 60_000 } : { limit: 10, windowMs: 60_000 }
}

/** Workers that call model APIs or fetch arbitrary sites. They stay off in demo mode. */
export const DEMO_SKIPPED_WORKERS = [
  'citation-scheduler',
  'diagnostic-workers',
  'agent-readiness',
  'geo-health',
] as const

export function outboundJobsEnabled(demoMode: boolean): boolean {
  return !demoMode
}

export function demoRejectsPaymentWebhook(demoMode: boolean): boolean {
  return demoMode
}

export function planDemoBoot(input: { demoMode: boolean; citationQueryCount: number }): { seed: boolean } {
  return { seed: input.demoMode && input.citationQueryCount === 0 }
}

export function demoResetCommand(): { command: string; args: string[] } {
  return { command: 'tsx', args: ['scripts/reset-demo.mjs'] }
}
