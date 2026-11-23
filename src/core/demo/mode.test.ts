import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEMO_OUTBOUND_BLOCKED, createDemoBlockedLlm } from './blocked-llm.js'
import {
  DEMO_FIXTURE,
  DEMO_SKIPPED_WORKERS,
  demoMutationAllowed,
  demoPublicStatus,
  demoRejectsPaymentWebhook,
  demoResetCommand,
  demoWorkspaceDomain,
  httpRateLimit,
  isDemoMode,
  loginAttemptLimit,
  outboundJobsEnabled,
  planDemoBoot,
} from './mode.js'
import { ensureDemoSeed } from './seed.js'

describe('isDemoMode', () => {
  it('accepts the documented on-values and ignores the rest', () => {
    for (const value of ['on', 'ON', ' true ', '1', 'yes', 'YES']) {
      expect(isDemoMode({ DEMO_MODE: value })).toBe(true)
    }
    for (const value of [undefined, '', 'off', 'false', '0', 'no', 'enabled', 'demo']) {
      expect(isDemoMode({ DEMO_MODE: value })).toBe(false)
    }
  })
})

describe('demoMutationAllowed', () => {
  it('lets every call through when demo mode is off', () => {
    expect(demoMutationAllowed({ demoMode: false, type: 'mutation', path: 'citation.run' })).toBe(true)
  })

  it('allows queries and only login or logout mutations', () => {
    expect(demoMutationAllowed({ demoMode: true, type: 'query', path: 'citation.trend' })).toBe(true)
    expect(demoMutationAllowed({ demoMode: true, type: 'mutation', path: 'auth.login' })).toBe(true)
    expect(demoMutationAllowed({ demoMode: true, type: 'mutation', path: 'auth.logout' })).toBe(true)
    expect(demoMutationAllowed({ demoMode: true, type: 'mutation', path: 'auth.changePassword' })).toBe(false)
    expect(demoMutationAllowed({ demoMode: true, type: 'mutation', path: 'auth.register' })).toBe(false)
    expect(demoMutationAllowed({ demoMode: true, type: 'mutation', path: 'geoHealth.start' })).toBe(false)
  })
})

describe('demoPublicStatus', () => {
  it('does not copy DEMO_ACCOUNT_PASSWORD into the login hint', () => {
    const secret = 'not-the-published-hint-9f3a'
    const status = demoPublicStatus({
      DEMO_MODE: 'on',
      DEMO_ACCOUNT_PASSWORD: secret,
      DEMO_USERNAME: 'demo-viewer',
    })
    expect(status).toEqual({
      enabled: true,
      username: 'demo-viewer',
      note: null,
      readOnly: true,
    })
    expect(JSON.stringify(status)).not.toContain(secret)
  })

  it('publishes only DEMO_PUBLIC_PASSWORD_HINT, trimmed and length-capped', () => {
    const status = demoPublicStatus({
      DEMO_MODE: 'on',
      DEMO_ACCOUNT_PASSWORD: 'stored-secret',
      DEMO_PUBLIC_PASSWORD_HINT: `  ask the host  \n`,
    })
    expect(status.note).toBe('ask the host')
    expect(status.username).toBe(DEMO_FIXTURE.username)
    const long = demoPublicStatus({
      DEMO_MODE: 'on',
      DEMO_PUBLIC_PASSWORD_HINT: 'x'.repeat(500),
    })
    expect(long.note).toHaveLength(200)
  })

  it('is empty when demo mode is off', () => {
    expect(
      demoPublicStatus({
        DEMO_MODE: 'off',
        DEMO_ACCOUNT_PASSWORD: 'stored-secret',
        DEMO_PUBLIC_PASSWORD_HINT: 'visible',
      }),
    ).toEqual({ enabled: false, username: null, note: null, readOnly: false })
  })
})

describe('demo limits and outbound switches', () => {
  it('tightens HTTP and login limits only in demo mode', () => {
    expect(httpRateLimit(false)).toEqual({ max: 300, timeWindow: '1 minute' })
    expect(httpRateLimit(true).max).toBe(60)
    expect(loginAttemptLimit(false).limit).toBe(10)
    expect(loginAttemptLimit(true)).toEqual({ limit: 5, windowMs: 60_000 })
  })

  it('skips paid workers and payment webhooks', () => {
    expect(outboundJobsEnabled(true)).toBe(false)
    expect(outboundJobsEnabled(false)).toBe(true)
    expect(demoRejectsPaymentWebhook(true)).toBe(true)
    expect(DEMO_SKIPPED_WORKERS).toEqual([
      'citation-scheduler',
      'diagnostic-workers',
      'agent-readiness',
      'geo-health',
    ])
  })

  it('blocks chat, embed, and embedBatch without calling a network client', async () => {
    const llm = createDemoBlockedLlm()
    await expect(llm.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(DEMO_OUTBOUND_BLOCKED)
    await expect(llm.embed('hi')).rejects.toThrow(DEMO_OUTBOUND_BLOCKED)
    await expect(llm.embedBatch(['hi'])).rejects.toThrow(DEMO_OUTBOUND_BLOCKED)
  })
})

describe('demo seed plan', () => {
  it('seeds only the first empty demo boot', () => {
    expect(planDemoBoot({ demoMode: false, citationQueryCount: 0 })).toEqual({ seed: false })
    expect(planDemoBoot({ demoMode: true, citationQueryCount: 0 })).toEqual({ seed: true })
    expect(planDemoBoot({ demoMode: true, citationQueryCount: 4 })).toEqual({ seed: false })
  })

  it('uses the fictional Acme Draw domain unless overridden', () => {
    expect(demoWorkspaceDomain({})).toBe('acmedraw.example')
    expect(demoWorkspaceDomain({ DEMO_WORKSPACE_DOMAIN: ' other.example ' })).toBe('other.example')
  })

  it('resets through the existing script', () => {
    expect(demoResetCommand()).toEqual({ command: 'tsx', args: ['scripts/reset-demo.mjs'] })
  })

  it('the seed script still plants Acme Draw and the .example competitors', () => {
    const seed = readFileSync(new URL('../../../scripts/seed-demo.mjs', import.meta.url), 'utf8')
    const reset = readFileSync(new URL('../../../scripts/reset-demo.mjs', import.meta.url), 'utf8')
    expect(seed).toContain('https://acmedraw.example')
    expect(reset).toContain('acmedraw.example')
    for (const competitor of DEMO_FIXTURE.competitors) {
      expect(seed).toContain(competitor.name)
      expect(seed).toContain(competitor.domain)
    }
  })
})

describe('ensureDemoSeed', () => {
  it('does not spawn when demo mode is off', async () => {
    let spawned = false
    const result = await ensureDemoSeed(
      async () => 0,
      { DEMO_MODE: 'off' },
      () => {
        spawned = true
        return { status: 0 }
      },
    )
    expect(result).toBe('disabled')
    expect(spawned).toBe(false)
  })

  it('spawns the reset script when the demo workspace has no queries', async () => {
    const calls: Array<{ command: string; args: readonly string[]; domain: string }> = []
    const result = await ensureDemoSeed(
      async (domain) => {
        calls.push({ command: '', args: [], domain })
        return 0
      },
      { DEMO_MODE: 'on', DEMO_ACCOUNT_PASSWORD: 'from-the-host' },
      (command, args) => {
        calls.push({ command, args, domain: '' })
        return { status: 0 }
      },
      '/app',
    )
    expect(result).toBe('seeded')
    expect(calls[0]?.domain).toBe('acmedraw.example')
    expect(calls[1]).toMatchObject({ command: 'tsx', args: ['scripts/reset-demo.mjs'] })
  })

  it('does not wipe a workspace that already has queries', async () => {
    let spawned = false
    const result = await ensureDemoSeed(
      async () => 3,
      { DEMO_MODE: '1' },
      () => {
        spawned = true
        return { status: 0 }
      },
    )
    expect(result).toBe('skipped')
    expect(spawned).toBe(false)
  })

  it('throws when the reset script fails', async () => {
    await expect(
      ensureDemoSeed(
        async () => 0,
        { DEMO_MODE: 'on' },
        () => ({ status: 1 }),
      ),
    ).rejects.toThrow(/exited 1/)
  })
})
