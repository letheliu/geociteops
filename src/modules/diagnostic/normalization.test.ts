import { describe, expect, it } from 'vitest'
import { normalizeDomain, normalizeQueryText, validateBrandCompetitors } from './normalization.js'

describe('diagnostic normalization', () => {
  it('normalizes domain and query text', () => {
    expect(normalizeDomain('https://WWW.Example.com/docs/')).toBe('example.com')
    expect(normalizeQueryText('  AI   工具哪个好？ ')).toBe('ai 工具哪个好?')
  })

  it('rejects brand alias that conflicts with competitor name', () => {
    expect(() => validateBrandCompetitors('Zoomer', ['Zoomer AI'], [{ name: 'zoomer ai' }]))
      .toThrow('BRAND_COMPETITOR_CONFLICT')
  })

  it('normalizes domain removes www and path', () => {
    expect(normalizeDomain('http://www.example.co.uk/page?q=1')).toBe('example.co.uk')
    expect(normalizeDomain('https://sub.domain.com/')).toBe('sub.domain.com')
  })

  it('normalizes query text trims and collapses whitespace', () => {
    expect(normalizeQueryText('  Hello   World  ')).toBe('hello world')
  })

  it('normalizes query text converts fullwidth latin letters', () => {
    expect(normalizeQueryText('ＡＢＣ')).toBe('abc')
  })

  it('rejects empty domain', () => {
    expect(() => normalizeDomain('')).toThrow()
    expect(() => normalizeDomain('  ')).toThrow()
  })

  it('rejects domain with no valid hostname', () => {
    expect(() => normalizeDomain('/just/a/path')).toThrow()
  })

  it('accepts same brand name in competitor conflict check', () => {
    expect(() => validateBrandCompetitors('Zoomer', ['Zoomer'], []))
      .not.toThrow()
  })
})
