import { describe, it, expect } from 'vitest'
import { normalizePlatformResult } from './types.js'

describe('normalizePlatformResult', () => {
  it('兼容旧 citations 字段并转为 sourceCitations', () => {
    const result = normalizePlatformResult({
      answer: '参考 https://example.com',
      citations: [{ url: 'https://example.com', position: 1 }],
      mentionedBrands: [],
    } as any)

    expect(result.sourceCitations[0]).toMatchObject({
      url: 'https://example.com',
      position: 1,
      sourceType: 'answer_url',
    })
  })

  it('保留新格式 sourceCitations', () => {
    const result = normalizePlatformResult({
      answer: '测试答案',
      sourceCitations: [
        { url: 'https://example.com', position: 1, sourceType: 'api_citation' },
      ],
      groundingSources: [],
      answerMentions: [],
    })

    expect(result.sourceCitations[0]).toMatchObject({
      url: 'https://example.com',
      position: 1,
      sourceType: 'api_citation',
    })
  })

  it('处理空输入', () => {
    const result = normalizePlatformResult({} as any)

    expect(result.answer).toBe('')
    expect(result.sourceCitations).toEqual([])
    expect(result.groundingSources).toEqual([])
    expect(result.answerMentions).toEqual([])
  })
})
