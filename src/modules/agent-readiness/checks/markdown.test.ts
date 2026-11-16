import { describe, expect, it } from 'vitest'
import { checkMarkdown, looksLikeMarkdown, markdownSiblingUrl } from './markdown.js'

describe('markdown availability', () => {
  it('builds the sibling .md URL', () => {
    expect(markdownSiblingUrl('https://example.com/docs/intro')).toBe('https://example.com/docs/intro.md')
    expect(markdownSiblingUrl('https://example.com/docs/')).toBe('https://example.com/docs/index.md')
    expect(markdownSiblingUrl('https://example.com/readme.md')).toBeNull()
  })

  it('recognizes markdown and rejects HTML', () => {
    expect(looksLikeMarkdown('# Title\n\nHello', 'text/markdown')).toBe(true)
    expect(looksLikeMarkdown('# Title', 'text/plain')).toBe(true)
    expect(looksLikeMarkdown('<!doctype html><html></html>', 'text/html')).toBe(false)
    expect(looksLikeMarkdown('<html><body>hi</body></html>', 'text/plain')).toBe(false)
  })

  it('passes when either probe returns markdown and warns otherwise', () => {
    const viaMd = checkMarkdown(
      { url: 'https://example.com/', status: 200, contentType: 'text/html', body: '<html></html>' },
      { url: 'https://example.com/index.md', status: 200, contentType: 'text/markdown', body: '# Example\n' },
    )
    expect(viaMd.status).toBe('pass')

    const missing = checkMarkdown(
      { url: 'https://example.com/', status: 200, contentType: 'text/html', body: '<html></html>' },
      { url: 'https://example.com/index.md', status: 404, contentType: 'text/html', body: 'missing' },
    )
    expect(missing.status).toBe('warn')
    expect(missing.applicable).toBe(true)
  })
})
