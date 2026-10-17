import { describe, it, expect } from 'vitest'
import { createCitabilityEngine } from './citability.js'

describe('CitabilityEngine', () => {
  const engine = createCitabilityEngine()

  const optimalText = Array(150).fill('word').join(' ')

  it('最优长度段落（134-167词）获得满分 lengthScore', () => {
    const result = engine.score({ text: optimalText, positionRatio: 0.5 })
    expect(result.lengthScore).toBe(40)
  })

  it('过短段落（<50词）lengthScore 为 0', () => {
    const result = engine.score({ text: 'short text', positionRatio: 0.5 })
    expect(result.lengthScore).toBe(0)
  })

  it('过长段落（>300词）lengthScore 为 0', () => {
    const longText = Array(350).fill('word').join(' ')
    const result = engine.score({ text: longText, positionRatio: 0.5 })
    expect(result.lengthScore).toBe(0)
  })

  it('可接受范围内（50-133词）按比例得分', () => {
    const text = Array(90).fill('word').join(' ')
    const result = engine.score({ text, positionRatio: 0.5 })
    expect(result.lengthScore).toBeGreaterThan(0)
    expect(result.lengthScore).toBeLessThan(40)
  })

  it('前30%位置获得 frontLoadBonus', () => {
    const result = engine.score({ text: optimalText, positionRatio: 0.2 })
    expect(result.frontLoadBonus).toBe(true)
  })

  it('后70%位置无 frontLoadBonus', () => {
    const result = engine.score({ text: optimalText, positionRatio: 0.5 })
    expect(result.frontLoadBonus).toBe(false)
  })

  it('中文定义句模式检测', () => {
    const result = engine.score({ text: 'GEO是一种优化AI引用的技术', positionRatio: 0.5 })
    expect(result.hasDefinitionPattern).toBe(true)
  })

  it('英文定义句模式检测', () => {
    const result = engine.score({ text: 'GEO is a technique for AI citation', positionRatio: 0.5 })
    expect(result.hasDefinitionPattern).toBe(true)
  })

  it('非定义句不匹配', () => {
    const result = engine.score({ text: 'This is just a regular sentence about something', positionRatio: 0.5 })
    expect(result.hasDefinitionPattern).toBe(false)
  })

  it('hasAttribution 加分', () => {
    const withAttr = engine.score({ text: optimalText, positionRatio: 0.5, hasAttribution: true })
    const withoutAttr = engine.score({ text: optimalText, positionRatio: 0.5, hasAttribution: false })
    expect(withAttr.total - withoutAttr.total).toBe(20)
  })

  it('hasUniqueData 加分', () => {
    const withData = engine.score({ text: optimalText, positionRatio: 0.5, hasUniqueData: true })
    const withoutData = engine.score({ text: optimalText, positionRatio: 0.5, hasUniqueData: false })
    expect(withData.total - withoutData.total).toBe(20)
  })

  it('满分段落', () => {
    const result = engine.score({
      text: 'GEO是一种优化AI引用的技术 ' + optimalText,
      positionRatio: 0.1,
      hasAttribution: true,
      hasUniqueData: true,
    })
    expect(result.total).toBe(100)
    expect(result.lengthScore).toBe(40)
    expect(result.hasDefinitionPattern).toBe(true)
    expect(result.hasAttribution).toBe(true)
    expect(result.hasUniqueData).toBe(true)
  })

  it('scorePassages 计算平均分', () => {
    const { scores, average } = engine.scorePassages([
      { text: optimalText, positionRatio: 0.1, hasAttribution: true, hasUniqueData: true },
      { text: 'short', positionRatio: 0.9 },
    ])
    expect(scores).toHaveLength(2)
    expect(average).toBe(Math.round((scores[0].total + scores[1].total) / 2))
  })

  it('scorePassages 空数组返回 0', () => {
    const { scores, average } = engine.scorePassages([])
    expect(scores).toHaveLength(0)
    expect(average).toBe(0)
  })
})
