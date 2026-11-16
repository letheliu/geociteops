import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AuditFetcher, AuditFetchInit } from './runner.js'
import { runAgentReadinessAudit } from './runner.js'
import type { FetchOutcome } from './safe-fetch.js'
import { SsrfError } from './ssrf.js'

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const read = (name: string) => readFileSync(join(root, name), 'utf8')
const html = read('homepage-good.html')
const robots = read('robots-mixed.txt')
const llms = read('llms-valid.txt')
const sitemap = read('sitemap-urlset.xml')

function outcome(url: string, partial: Partial<FetchOutcome>): FetchOutcome {
  return {
    url,
    status: 200,
    headers: {},
    body: '',
    truncated: false,
    redirectChain: [],
    durationMs: 30,
    ...partial,
  }
}

function healthySite(mutate?: (url: URL, init: AuditFetchInit | undefined, result: FetchOutcome) => FetchOutcome): AuditFetcher {
  return {
    async get(url, init) {
      const u = new URL(url)
      let result: FetchOutcome
      if (u.pathname === '/robots.txt') {
        result = outcome(url, { headers: { 'content-type': 'text/plain' }, body: robots })
      } else if (u.pathname === '/llms.txt') {
        result = outcome(url, { headers: { 'content-type': 'text/plain' }, body: llms })
      } else if (u.pathname === '/llms-full.txt') {
        result = outcome(url, { headers: { 'content-type': 'text/markdown' }, body: `# Full\n\n${'sentence '.repeat(30)}` })
      } else if (u.pathname === '/sitemap.xml') {
        result = outcome(url, { headers: { 'content-type': 'application/xml' }, body: sitemap })
      } else if (u.pathname.endsWith('.md')) {
        result = outcome(url, { headers: { 'content-type': 'text/markdown' }, body: '# Example\n\nHello from markdown.' })
      } else if (u.pathname === '/') {
        result = outcome(url, { headers: { 'content-type': 'text/html' }, body: html })
      } else {
        result = outcome(url, { headers: { 'content-type': 'text/html' }, body: 'linked page' })
      }
      return mutate ? mutate(u, init, result) : result
    },
  }
}

describe('runAgentReadinessAudit', () => {
  it('scores a ready site and keeps the versioned report shape', async () => {
    const report = await runAgentReadinessAudit('https://example.com/', {
      fetch: healthySite(),
      now: () => new Date('2026-11-16T03:00:00.000Z'),
    })
    expect(report.version).toBe(1)
    expect(report.url).toBe('https://example.com/')
    expect(report.score).toBeGreaterThanOrEqual(90)
    expect(report.grade).toBe('A')
    expect(report.checks.map((c) => c.id)).toEqual(expect.arrayContaining([
      'access.http',
      'access.bot-ua',
      'robots.reachable',
      'robots.answer-bots',
      'robots.search-bots',
      'llms.txt',
      'llms-full.txt',
      'llms.links',
      'sitemap',
      'page.jsonld',
      'page.ssr-text',
      'markdown',
    ]))
    const impacts = report.fixes.map((f) => f.impact)
    expect([...impacts].sort((a, b) => b - a)).toEqual(impacts)
    expect(report.fixes.find((f) => f.checkId === 'robots.answer-bots')).toBeUndefined()
    const sitemap = report.checks.find((c) => c.id === 'sitemap')
    expect(sitemap?.evidence).toMatchObject({ source: 'robots', urlCount: 3 })
    const links = report.checks.find((c) => c.id === 'llms.links')
    expect(links?.status).toBe('pass')
    expect(links?.evidence.sampled).toBe(3)
  })

  it('fails the bot user-agent check when GPTBot is blocked by a WAF', async () => {
    const report = await runAgentReadinessAudit('https://example.com', {
      fetch: healthySite((url, init, result) => {
        const ua = init?.headers?.['user-agent'] ?? ''
        if (ua.includes('GPTBot')) return { ...result, status: 403, body: 'blocked' }
        return result
      }),
    })
    expect(report.checks.find((c) => c.id === 'access.bot-ua')?.status).toBe('fail')
    expect(report.fixes[0]?.checkId).toBe('access.bot-ua')
  })

  it('refuses a target that resolves to a private address', async () => {
    const fetch: AuditFetcher = {
      async get(url) {
        return outcome(url, { status: 0, error: 'ssrf', errorMessage: '目标解析到内网或本机地址，已拒绝' })
      },
    }
    await expect(runAgentReadinessAudit('https://example.com/', { fetch })).rejects.toBeInstanceOf(SsrfError)
  })
})
