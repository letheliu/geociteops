import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkSitemap, parseSitemapXml } from './sitemap.js'

const fixture = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../fixtures', name), 'utf8')

describe('parseSitemapXml', () => {
  it('counts urlset locs, including CDATA', () => {
    const parsed = parseSitemapXml(fixture('sitemap-urlset.xml'))
    expect(parsed.kind).toBe('urlset')
    expect(parsed.locs).toEqual([
      'https://example.com/',
      'https://example.com/docs',
      'https://example.com/pricing',
    ])
  })

  it('recognizes a sitemap index', () => {
    const parsed = parseSitemapXml(fixture('sitemap-index.xml'))
    expect(parsed.kind).toBe('index')
    expect(parsed.locs).toHaveLength(2)
  })

  it('rejects HTML and empty documents', () => {
    expect(parseSitemapXml('<!doctype html><html></html>').kind).toBe('invalid')
    expect(parseSitemapXml('').kind).toBe('invalid')
  })
})

describe('checkSitemap', () => {
  it('fails when nothing was discovered', () => {
    const check = checkSitemap({ source: null, url: null, status: 404, body: '' })
    expect(check.status).toBe('fail')
    expect(check.fix.en).toContain('Sitemap:')
  })

  it('passes a urlset and records the count', () => {
    const check = checkSitemap({
      source: 'robots',
      url: 'https://example.com/sitemap.xml',
      status: 200,
      body: fixture('sitemap-urlset.xml'),
      contentType: 'application/xml',
    })
    expect(check.status).toBe('pass')
    expect(check.evidence.urlCount).toBe(3)
  })

  it('warns on an empty urlset and fails on HTML', () => {
    expect(checkSitemap({
      source: 'sitemap.xml',
      url: 'https://example.com/sitemap.xml',
      status: 200,
      body: '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>',
    }).status).toBe('warn')
    expect(checkSitemap({
      source: 'sitemap.xml',
      url: 'https://example.com/sitemap.xml',
      status: 200,
      body: '<html></html>',
      contentType: 'text/html',
    }).status).toBe('fail')
  })
})
