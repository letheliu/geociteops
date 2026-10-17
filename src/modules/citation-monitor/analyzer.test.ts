import { describe, it, expect } from 'vitest'
import { analyzeCitation, type Competitor } from './analyzer.js'
import type { PlatformResult } from './platform-adapters/types.js'

function makeResult(answer: string): PlatformResult {
  return { answer, sourceCitations: [], groundingSources: [], answerMentions: [] }
}

describe('CitationAnalyzer', () => {
  it('检测品牌被提及（大小写不敏感）', () => {
    const result = analyzeCitation({
      platformResult: makeResult('推荐 Zoomer AI 给设计师'),
      brand: 'zoomer AI',
      competitors: ['figma'],
    })
    expect(result.brandMentioned).toBe(true)
  })

  it('品牌未被提及时 brandMentioned=false', () => {
    const result = analyzeCitation({
      platformResult: makeResult('推荐 Figma'),
      brand: 'zoomer AI',
      competitors: ['figma'],
    })
    expect(result.brandMentioned).toBe(false)
  })

  it('计算品牌排名（在所有提及品牌中的顺序）', () => {
    const result = analyzeCitation({
      platformResult: makeResult('第一是 Figma，第二是 zoomer AI，第三是 Sketch'),
      brand: 'zoomer AI',
      competitors: ['figma', 'sketch'],
    })
    expect(result.rankInAnswer).toBe(2)
  })

  it('计算 SOV（品牌提及次数 / 所有品牌提及总和）', () => {
    const result = analyzeCitation({
      platformResult: makeResult('zoomer AI 和 zoomer AI 以及 Figma'),
      brand: 'zoomer AI',
      competitors: ['figma'],
    })
    expect(result.sovScore).toBeCloseTo(2 / 3, 2)
  })

  it('竞品列表标记每个竞品是否提及及其排名', () => {
    const result = analyzeCitation({
      platformResult: makeResult('zoomer AI 最好，Figma 次之'),
      brand: 'zoomer AI',
      competitors: ['figma', 'sketch'],
    })
    const figma = result.competitors.find((c) => c.brand === 'figma')
    const sketch = result.competitors.find((c) => c.brand === 'sketch')
    expect(figma?.mentioned).toBe(true)
    expect(figma?.rank).toBe(2)
    expect(sketch?.mentioned).toBe(false)
    expect(sketch?.rank).toBeNull()
  })

  it('识别品牌来源引用并计算 sourceRank', () => {
    const result = analyzeCitation({
      platformResult: {
        answer: 'Notion 和 zoomer AI 都可以考虑',
        sourceCitations: [
          { url: 'https://notion.so', position: 1, sourceType: 'api_citation' },
          { url: 'https://zoomer.top/features', position: 2, sourceType: 'api_citation' },
        ],
        groundingSources: [],
        answerMentions: [],
      },
      brand: 'zoomer AI',
      brandDomains: ['zoomer.top'],
      competitors: ['Notion'],
    })

    expect(result.brandMentioned).toBe(true)
    expect(result.brandSourceCited).toBe(true)
    expect(result.sourceRank).toBe(2)
    expect(result.sourceCitationRate).toBe(0.5)
  })

  it('品牌来源未被引用时 brandSourceCited=false', () => {
    const result = analyzeCitation({
      platformResult: {
        answer: 'zoomer AI 是一个工具',
        sourceCitations: [
          { url: 'https://notion.so', position: 1, sourceType: 'api_citation' },
        ],
        groundingSources: [],
        answerMentions: [],
      },
      brand: 'zoomer AI',
      brandDomains: ['zoomer.top'],
      competitors: ['Notion'],
    })

    expect(result.brandMentioned).toBe(true)
    expect(result.brandSourceCited).toBe(false)
    expect(result.sourceRank).toBeNull()
    expect(result.sourceCitationRate).toBe(0)
  })

  it('grounding sources 也参与 sourceRank 计算', () => {
    const result = analyzeCitation({
      platformResult: {
        answer: '推荐 zoomer AI',
        sourceCitations: [],
        groundingSources: [
          { url: 'https://zoomer.top', position: 1, sourceType: 'grounding' },
        ],
        answerMentions: [],
      },
      brand: 'zoomer AI',
      brandDomains: ['zoomer.top'],
      competitors: [],
    })

    expect(result.brandSourceCited).toBe(true)
    expect(result.sourceRank).toBe(1)
  })

  it('竞品对象格式：name 匹配', () => {
    const result = analyzeCitation({
      platformResult: makeResult('推荐 Figma 给设计师'),
      brand: 'zoomer AI',
      competitors: [{ name: 'Figma' }],
    })
    const figma = result.competitors.find((c) => c.brand === 'Figma')
    expect(figma?.mentioned).toBe(true)
    expect(figma?.matchType).toBe('exact')
  })

  it('竞品别名匹配：aliases 命中', () => {
    const result = analyzeCitation({
      platformResult: makeResult('我推荐 Open AI 给大家'),
      brand: 'zoomer AI',
      competitors: [{ name: 'OpenAI', aliases: ['Open AI', 'ChatGPT'] }],
    })
    const openai = result.competitors.find((c) => c.brand === 'OpenAI')
    expect(openai?.mentioned).toBe(true)
    expect(openai?.matchedVia).toBe('Open AI')
  })

  it('fuzzy 模糊匹配：typo 容错', () => {
    const result = analyzeCitation({
      platformResult: makeResult('OpeanAI 是最好的'),
      brand: 'zoomer AI',
      competitors: [{ name: 'OpenAI' }],
    })
    const openai = result.competitors.find((c) => c.brand === 'OpenAI')
    expect(openai?.mentioned).toBe(true)
    expect(openai?.matchType).toBe('fuzzy')
  })

  it('fuzzy 阈值过严时不误匹配', () => {
    const result = analyzeCitation({
      platformResult: makeResult('今天天气不错'),
      brand: 'zoomer AI',
      competitors: [{ name: 'OpenAI' }],
    })
    const openai = result.competitors.find((c) => c.brand === 'OpenAI')
    expect(openai?.mentioned).toBe(false)
  })

  it('competitor domain 匹配引用来源', () => {
    const result = analyzeCitation({
      platformResult: {
        answer: '推荐一些工具',
        sourceCitations: [
          { url: 'https://openai.com/gpt-4', position: 1, sourceType: 'api_citation' },
        ],
        groundingSources: [],
        answerMentions: [],
      },
      brand: 'zoomer AI',
      brandDomains: ['zoomer.top'],
      competitors: [{ name: 'OpenAI', domain: 'openai.com' }],
    })
    const openai = result.competitors.find((c) => c.brand === 'OpenAI')
    expect(openai?.mentioned).toBe(true)
    expect(openai?.matchType).toBe('domain')
  })

  it('主品牌也支持对象格式与别名', () => {
    const result = analyzeCitation({
      platformResult: makeResult('Zoomer AI Tool 很好用'),
      brand: { name: 'Zoomer', aliases: ['Zoomer AI'] },
      competitors: [],
    })
    expect(result.brandMentioned).toBe(true)
  })
})
