import { describe, it, expect } from 'vitest'
import { createEeatEngine } from './eeat.js'
import type { EeatInput } from './types.js'

describe('EeatEngine', () => {
  const engine = createEeatEngine()

  const fullInput: EeatInput = {
    hasOriginalResearch: true,
    hasCaseStudies: true,
    hasAuthorByline: true,
    hasAuthorCredentials: true,
    hasExternalCitations: true,
    hasBrandMentions: true,
    hasContactInfo: true,
    hasHttps: true,
    hasDateStamps: true,
    hasCorrectionsPolicy: true,
  }

  const emptyInput: EeatInput = {
    hasOriginalResearch: false,
    hasCaseStudies: false,
    hasAuthorByline: false,
    hasAuthorCredentials: false,
    hasExternalCitations: false,
    hasBrandMentions: false,
    hasContactInfo: false,
    hasHttps: false,
    hasDateStamps: false,
    hasCorrectionsPolicy: false,
  }

  it('满分输入返回 100 分', () => {
    const result = engine.score(fullInput)
    expect(result.total).toBe(100)
    expect(result.experience).toBe(25)
    expect(result.expertise).toBe(25)
    expect(result.authoritativeness).toBe(25)
    expect(result.trustworthiness).toBe(25)
  })

  it('空输入返回 0 分', () => {
    const result = engine.score(emptyInput)
    expect(result.total).toBe(0)
    expect(result.experience).toBe(0)
    expect(result.expertise).toBe(0)
    expect(result.authoritativeness).toBe(0)
    expect(result.trustworthiness).toBe(0)
  })

  it('Experience 维度：原创研究 15 分 + 案例 10 分', () => {
    const result = engine.score({ ...emptyInput, hasOriginalResearch: true })
    expect(result.experience).toBe(15)

    const withCase = engine.score({ ...emptyInput, hasOriginalResearch: true, hasCaseStudies: true })
    expect(withCase.experience).toBe(25)
  })

  it('Expertise 维度：署名 10 分 + 资质 15 分', () => {
    const result = engine.score({ ...emptyInput, hasAuthorByline: true })
    expect(result.expertise).toBe(10)

    const withCreds = engine.score({ ...emptyInput, hasAuthorByline: true, hasAuthorCredentials: true })
    expect(withCreds.expertise).toBe(25)
  })

  it('Authoritativeness 维度：外部引用 15 分 + 品牌提及 10 分', () => {
    const result = engine.score({ ...emptyInput, hasExternalCitations: true })
    expect(result.authoritativeness).toBe(15)

    const withBrand = engine.score({ ...emptyInput, hasExternalCitations: true, hasBrandMentions: true })
    expect(withBrand.authoritativeness).toBe(25)
  })

  it('Trustworthiness 维度：联系信息 8 + HTTPS 5 + 日期 7 + 更正 5 = 25', () => {
    const result = engine.score({
      ...emptyInput,
      hasContactInfo: true,
      hasHttps: true,
      hasDateStamps: true,
      hasCorrectionsPolicy: true,
    })
    expect(result.trustworthiness).toBe(25)
  })

  it('Trustworthiness 维度：部分信号', () => {
    const result = engine.score({ ...emptyInput, hasHttps: true, hasDateStamps: true })
    expect(result.trustworthiness).toBe(12)
  })

  it('Who/How/Why 启发式：全满足返回 true', () => {
    const result = engine.score(fullInput)
    expect(result.whoHowWhyPassed).toBe(true)
  })

  it('Who/How/Why 启发式：缺少 Who 返回 false', () => {
    const result = engine.score({ ...fullInput, hasAuthorByline: false })
    expect(result.whoHowWhyPassed).toBe(false)
  })

  it('Who/How/Why 启发式：缺少 How 返回 false', () => {
    const result = engine.score({ ...fullInput, hasOriginalResearch: false, hasCaseStudies: false })
    expect(result.whoHowWhyPassed).toBe(false)
  })

  it('Who/How/Why 启发式：缺少 Why 返回 false', () => {
    const result = engine.score({ ...fullInput, hasDateStamps: false, hasCorrectionsPolicy: false })
    expect(result.whoHowWhyPassed).toBe(false)
  })
})
