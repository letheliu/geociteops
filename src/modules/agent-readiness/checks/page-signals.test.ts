import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkPageSignals, extractJsonLd, visibleText } from './page-signals.js'

const fixture = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../fixtures', name), 'utf8')

function page(html: string, extra: Partial<Parameters<typeof checkPageSignals>[0]> = {}) {
  return checkPageSignals({
    available: true,
    url: 'https://example.com/',
    finalUrl: 'https://example.com/',
    status: 200,
    headers: {},
    html,
    ...extra,
  })
}

describe('page signals', () => {
  it('passes a server-rendered page with registry-known JSON-LD', () => {
    const html = fixture('homepage-good.html')
    expect(visibleText(html).length).toBeGreaterThanOrEqual(400)
    const blocks = extractJsonLd(html)
    expect(blocks[0].types).toEqual(expect.arrayContaining(['Organization', 'WebSite', 'FAQPage']))
    const checks = Object.fromEntries(page(html).map((c) => [c.id, c]))
    expect(checks['page.jsonld'].status).toBe('pass')
    expect(checks['page.jsonld'].evidence.supported).toEqual(expect.arrayContaining(['Organization', 'FAQPage']))
    expect(checks['page.meta-description'].status).toBe('pass')
    expect(checks['page.canonical'].status).toBe('pass')
    expect(checks['page.lang'].status).toBe('pass')
    expect(checks['page.open-graph'].status).toBe('pass')
    expect(checks['page.ssr-text'].status).toBe('pass')
    expect(checks['page.robots-directives'].status).toBe('pass')
  })

  it('fails a JavaScript shell and a noindex page', () => {
    const spa = Object.fromEntries(page(fixture('homepage-spa.html')).map((c) => [c.id, c]))
    expect(spa['page.ssr-text'].status).toBe('fail')
    expect(spa['page.ssr-text'].evidence.spaShell).toBe(true)
    expect(spa['page.jsonld'].status).toBe('warn')

    const hidden = Object.fromEntries(page(fixture('homepage-noindex.html'), {
      finalUrl: 'https://example.com/secret',
      headers: { 'x-robots-tag': 'nosnippet' },
    }).map((c) => [c.id, c]))
    expect(hidden['page.robots-directives'].status).toBe('fail')
    expect(hidden['page.ssr-text'].status).toBe('pass')
  })

  it('warns on deprecated-only JSON-LD and fails invalid JSON', () => {
    const deprecated = page('<script type="application/ld+json">{"@type":"HowTo","name":"x"}</script><p>' + 'word '.repeat(80) + '</p>')
    expect(deprecated.find((c) => c.id === 'page.jsonld')?.status).toBe('warn')

    const broken = page('<script type="application/ld+json">{not json}</script>')
    expect(broken.find((c) => c.id === 'page.jsonld')?.status).toBe('fail')
  })

  it('does not score page checks when the document was not fetched', () => {
    const checks = checkPageSignals({
      available: false,
      url: 'https://example.com/',
      finalUrl: 'https://example.com/',
      status: 0,
      headers: {},
      html: '',
      error: 'timeout',
    })
    expect(checks.every((c) => c.applicable === false)).toBe(true)
  })
})
