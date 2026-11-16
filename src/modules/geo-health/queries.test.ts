import { describe, expect, it } from 'vitest'
import {
  buildQueryPrompt,
  completeQuerySet,
  parseGeneratedQueries,
  queriesFromUser,
  resolveLanguage,
  templateQueries,
} from './queries.js'

describe('geo health query generation', () => {
  it('asks for brand, category, and comparison questions in the chosen language', () => {
    const prompt = buildQueryPrompt({
      brandName: 'Acme',
      siteUrl: 'https://acme.example/',
      industry: '协作文档',
      competitors: ['Notion'],
      language: 'zh',
    })
    expect(prompt.system).toContain('"brand"|"category"|"comparison"')
    expect(prompt.system).toContain('3 brand')
    expect(prompt.system).toContain('3 category')
    expect(prompt.system).toContain('2 comparison')
    expect(prompt.system).toContain('Simplified Chinese')
    expect(prompt.user).toContain('language: zh')
    expect(prompt.user).toContain('Notion')
  })

  it('parses fenced JSON and drops invalid, empty, and duplicate questions', () => {
    const raw = [
      'Here is the list:',
      '```json',
      JSON.stringify({
        queries: [
          { text: 'Acme 是什么', kind: 'brand', language: 'zh' },
          { text: '最好的协作文档', kind: 'category', language: 'zh' },
          { text: 'nope', kind: 'keyword', language: 'zh' },
          { text: '   ', kind: 'brand', language: 'zh' },
          { text: 'Acme 是什么', kind: 'brand', language: 'zh' },
          { text: 'Acme vs Notion', kind: 'comparison', language: 'en' },
        ],
      }),
      '```',
      'thanks',
    ].join('\n')
    expect(parseGeneratedQueries(raw)).toEqual([
      { text: 'Acme 是什么', kind: 'brand', language: 'zh' },
      { text: '最好的协作文档', kind: 'category', language: 'zh' },
      { text: 'Acme vs Notion', kind: 'comparison', language: 'en' },
    ])
  })

  it('reads a JSON object wrapped in prose and ignores garbage', () => {
    expect(parseGeneratedQueries('Sure {"queries":[{"text":"best docs","kind":"category","language":"en"}]} end')).toEqual([
      { text: 'best docs', kind: 'category', language: 'en' },
    ])
    expect(parseGeneratedQueries('not json')).toEqual([])
    expect(parseGeneratedQueries('{"queries":')).toEqual([])
  })

  it('caps the parsed list', () => {
    const queries = Array.from({ length: 12 }, (_, index) => ({
      text: `question ${index}`,
      kind: 'brand',
      language: 'en',
    }))
    expect(parseGeneratedQueries(JSON.stringify({ queries }))).toHaveLength(8)
  })

  it('fills a short model list from templates and leaves a full list alone', () => {
    const templates = templateQueries({ brandName: 'Acme', industry: 'docs', competitors: ['Notion'], language: 'en' })
    expect(templates).toHaveLength(8)
    expect(templates.map((item) => item.kind)).toEqual([
      'brand', 'brand', 'brand', 'category', 'category', 'category', 'comparison', 'comparison',
    ])
    const short = completeQuerySet([
      { text: 'What is Acme?', kind: 'brand', language: 'en' },
      { text: 'best docs', kind: 'category', language: 'en' },
    ], templates, 'en')
    expect(short.length).toBeGreaterThanOrEqual(5)
    expect(short.length).toBeLessThanOrEqual(8)
    expect(short.filter((item) => item.source === 'llm')).toHaveLength(2)
    expect(short.some((item) => item.source === 'template')).toBe(true)

    const full = Array.from({ length: 8 }, (_, index) => ({
      text: `q ${index}`,
      kind: 'brand' as const,
      language: 'en' as const,
    }))
    const kept = completeQuerySet(full, templates, 'en')
    expect(kept).toHaveLength(8)
    expect(kept.every((item) => item.source === 'llm')).toBe(true)
  })

  it('uses only the questions the user typed', () => {
    const queries = queriesFromUser(['  Acme 是什么 ', 'Acme 是什么', 'best docs'], 'zh')
    expect(queries).toEqual([
      { text: 'Acme 是什么', kind: 'custom', language: 'zh', source: 'user' },
      { text: 'best docs', kind: 'custom', language: 'zh', source: 'user' },
    ])
  })

  it('resolves auto language from the brand or the site', () => {
    expect(resolveLanguage({ language: 'en', brandName: '极客', industry: null, siteUrl: 'https://a.cn' })).toBe('en')
    expect(resolveLanguage({ language: 'auto', brandName: '极客文档', industry: null, siteUrl: 'https://a.com' })).toBe('zh')
    expect(resolveLanguage({ language: 'auto', brandName: 'Acme', industry: null, siteUrl: 'https://acme.com.cn/docs' })).toBe('zh')
    expect(resolveLanguage({ language: 'auto', brandName: 'Acme', industry: 'docs', siteUrl: 'https://acme.example/' })).toBe('en')
  })
})
