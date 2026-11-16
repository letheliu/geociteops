import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkRobots, parseRobotsTxt, robotsDecision } from './robots.js'

const fixture = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../fixtures', name), 'utf8')

describe('parseRobotsTxt / robotsDecision', () => {
  const mixed = parseRobotsTxt(fixture('robots-mixed.txt'))

  it('collects sitemap directives and groups', () => {
    expect(mixed.sitemaps).toEqual(['https://example.com/sitemap.xml'])
    expect(mixed.groups.length).toBeGreaterThan(3)
  })

  it('lets the longest match win and prefers Allow on a tie', () => {
    expect(robotsDecision(mixed, 'PerplexityBot', '/private').allowed).toBe(false)
    expect(robotsDecision(mixed, 'PerplexityBot', '/private/public').allowed).toBe(true)
    expect(robotsDecision(mixed, 'PerplexityBot', '/').allowed).toBe(true)

    const tie = parseRobotsTxt('User-agent: *\nDisallow: /docs\nAllow: /docs\n')
    expect(robotsDecision(tie, 'GPTBot', '/docs').allowed).toBe(true)
    expect(robotsDecision(tie, 'GPTBot', '/docs').matchedRule).toBe('Allow: /docs')
  })

  it('supports * and $ wildcards', () => {
    const parsed = parseRobotsTxt('User-agent: *\nDisallow: /*.pdf$\nDisallow: /file$\n')
    expect(robotsDecision(parsed, 'Bingbot', '/docs/a.pdf').allowed).toBe(false)
    expect(robotsDecision(parsed, 'Bingbot', '/docs/a.html').allowed).toBe(true)
    expect(robotsDecision(parsed, 'Bingbot', '/file').allowed).toBe(false)
    expect(robotsDecision(parsed, 'Bingbot', '/file/more').allowed).toBe(true)
  })

  it('does not treat an empty Disallow as blocking', () => {
    const parsed = parseRobotsTxt('User-agent: *\nDisallow:\n')
    expect(robotsDecision(parsed, 'Googlebot', '/').allowed).toBe(true)
  })

  it('keeps Googlebot allowed when only Google-Extended is blocked', () => {
    expect(robotsDecision(mixed, 'Googlebot', '/').allowed).toBe(true)
    expect(robotsDecision(mixed, 'Google-Extended', '/').allowed).toBe(false)
    expect(robotsDecision(mixed, 'GPTBot', '/').allowed).toBe(false)
    expect(robotsDecision(mixed, 'OAI-SearchBot', '/').allowed).toBe(true)
    expect(robotsDecision(mixed, 'Baiduspider', '/').allowed).toBe(true)
    expect(robotsDecision(mixed, 'YisouSpider', '/').allowed).toBe(true)
    expect(robotsDecision(mixed, 'Sogou web spider', '/docs').allowed).toBe(true)
    expect(robotsDecision(mixed, '360Spider', '/').allowed).toBe(true)
  })
})

describe('checkRobots', () => {
  it('passes answer bots when only training crawlers are blocked', () => {
    const result = checkRobots({ status: 200, body: fixture('robots-mixed.txt'), path: '/' })
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]))
    expect(byId['robots.reachable'].status).toBe('pass')
    expect(byId['robots.answer-bots'].status).toBe('pass')
    expect(byId['robots.search-bots'].status).toBe('pass')
    const gpt = result.bots.find((b) => b.token === 'GPTBot')
    const search = result.bots.find((b) => b.token === 'OAI-SearchBot')
    expect(gpt?.allowed).toBe(false)
    expect(search?.allowed).toBe(true)
    expect(byId['robots.answer-bots'].evidence.trainingOptOut).toEqual(expect.arrayContaining(['GPTBot', 'CCBot', 'Google-Extended']))
  })

  it('fails when most answer crawlers are disallowed', () => {
    const result = checkRobots({ status: 200, body: fixture('robots-block-answers.txt'), path: '/' })
    const answer = result.checks.find((c) => c.id === 'robots.answer-bots')
    expect(answer?.status).toBe('fail')
    expect(answer?.explanation.zh).toContain('PerplexityBot')
  })

  it('warns when robots.txt is missing and treats that as default-allow', () => {
    const result = checkRobots({ status: 404, body: '', path: '/' })
    expect(result.checks.find((c) => c.id === 'robots.reachable')?.status).toBe('warn')
    expect(result.bots.every((b) => b.allowed === true)).toBe(true)
    expect(result.checks.find((c) => c.id === 'robots.answer-bots')?.status).toBe('pass')
  })

  it('fails closed when robots.txt is a 500 or an HTML document', () => {
    expect(checkRobots({ status: 503, body: '', path: '/' }).checks[0].status).toBe('fail')
    const html = checkRobots({ status: 200, body: '<!doctype html><html></html>', contentType: 'text/html', path: '/' })
    expect(html.checks.find((c) => c.id === 'robots.reachable')?.status).toBe('fail')
    expect(html.checks.find((c) => c.id === 'robots.search-bots')?.applicable).toBe(false)
  })
})
