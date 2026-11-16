import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkLlmsFull, checkLlmsLinks, checkLlmsTxt, parseLlmsTxt } from './llms-txt.js'

const fixture = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../fixtures', name), 'utf8')

describe('parseLlmsTxt', () => {
  it('reads the H1, blockquote, and link sections from a valid file', () => {
    const parsed = parseLlmsTxt(fixture('llms-valid.txt'))
    expect(parsed.h1).toBe('Example')
    expect(parsed.summary).toContain('answer engines')
    expect(parsed.sections.map((s) => s.title)).toEqual(['Docs', 'Optional'])
    expect(parsed.links).toEqual([
      { label: 'Overview', url: 'https://example.com/docs', description: 'What the product does' },
      { label: 'Pricing', url: '/pricing', description: 'Plans and limits' },
      { label: 'About', url: 'https://example.com/about', description: 'Company background' },
    ])
  })
})

describe('checkLlmsTxt', () => {
  it('passes a spec-shaped file', () => {
    const { check, parsed } = checkLlmsTxt({ status: 200, body: fixture('llms-valid.txt'), contentType: 'text/plain' })
    expect(check.status).toBe('pass')
    expect(parsed?.links).toHaveLength(3)
  })

  it('fails when the H1 or the blockquote is missing', () => {
    expect(checkLlmsTxt({ status: 200, body: fixture('llms-no-h1.txt') }).check.status).toBe('fail')
    expect(checkLlmsTxt({ status: 200, body: fixture('llms-no-summary.txt') }).check.status).toBe('fail')
  })

  it('warns when the file is absent, including an HTML soft-404', () => {
    expect(checkLlmsTxt({ status: 404, body: '' }).check.status).toBe('warn')
    const html = checkLlmsTxt({ status: 200, body: '<!doctype html><html></html>', contentType: 'text/html' })
    expect(html.check.status).toBe('warn')
    expect(html.parsed).toBeNull()
  })

  it('warns on llms-full absence and passes a real body', () => {
    expect(checkLlmsFull({ status: 404, body: '' }).status).toBe('warn')
    expect(checkLlmsFull({ status: 200, body: '# Full\n\n' + 'paragraph '.repeat(20) }).status).toBe('pass')
  })

  it('scores link reachability from the sample and skips when there is no list', () => {
    const skipped = checkLlmsLinks(null, [])
    expect(skipped.applicable).toBe(false)

    const parsed = parseLlmsTxt(fixture('llms-valid.txt'))
    expect(checkLlmsLinks(parsed, [
      { url: 'https://example.com/docs', status: 200 },
      { url: 'https://example.com/pricing', status: 200 },
    ]).status).toBe('pass')
    expect(checkLlmsLinks(parsed, [
      { url: 'https://example.com/docs', status: 200 },
      { url: 'https://example.com/pricing', status: 404 },
    ]).status).toBe('warn')
    expect(checkLlmsLinks(parsed, [
      { url: 'https://example.com/docs', status: 500 },
    ]).status).toBe('fail')
  })
})
