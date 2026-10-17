import { describe, it, expect } from 'vitest'
import { createScoringEngine } from './scoring.js'
import type { Atom } from './types.js'

describe('ScoringEngine', () => {
  const scoring = createScoringEngine()

  const fullAtom: Atom = {
    text: 'zoomer AI 在 2024 年获得了 50 万用户',
    subject: 'zoomer AI',
    predicate: '获得了',
    object: '50 万用户',
    anchors: ['2024年', '50万', 'zoomer AI'],
    definition: 'zoomer AI 是一款 AI 设计工具',
  }

  it('满分 atom（4 维度全命中 → 100 分）', () => {
    const [scored] = scoring.scoreAtoms([fullAtom])
    expect(scored.score.total).toBe(100)
    expect(scored.score.hasNumericAnchor).toBe(true)
    expect(scored.score.hasEntityAnchor).toBe(true)
    expect(scored.score.isSelfContained).toBe(true)
    expect(scored.score.hasDefinition).toBe(true)
  })

  it('零分 atom（全空 → 0 分）', () => {
    const emptyAtom: Atom = {
      text: '内容很好',
      subject: '',
      predicate: '',
      object: '',
      anchors: [],
    }
    const [scored] = scoring.scoreAtoms([emptyAtom])
    expect(scored.score.total).toBe(0)
    expect(scored.score.hasNumericAnchor).toBe(false)
    expect(scored.score.hasEntityAnchor).toBe(false)
    expect(scored.score.isSelfContained).toBe(false)
    expect(scored.score.hasDefinition).toBe(false)
  })

  it('仅数字锚点（35 分，不达标）', () => {
    const atom: Atom = {
      text: '有 100 个',
      subject: '',
      predicate: '',
      object: '',
      anchors: ['100'],
    }
    const [scored] = scoring.scoreAtoms([atom])
    expect(scored.score.total).toBe(35)
    expect(scored.score.hasNumericAnchor).toBe(true)
    expect(scored.score.hasEntityAnchor).toBe(false)
  })

  it('数字 + 实体锚点 + 自解释（85 分，达标）', () => {
    const atom: Atom = {
      text: 'zoomer AI 在 2024 年获得了用户',
      subject: 'zoomer AI',
      predicate: '获得了',
      object: '用户',
      anchors: ['2024年', 'zoomer AI'],
    }
    const [scored] = scoring.scoreAtoms([atom])
    expect(scored.score.total).toBe(85)
  })

  it('最接近阈值边界：75 分达标', () => {
    const atom: Atom = {
      text: 'zoomer AI 是工具，2024 年发布',
      subject: 'zoomer AI',
      predicate: '发布',
      object: '工具',
      anchors: ['2024'],
      definition: 'zoomer AI 是一款工具',
    }
    // 数字 35 + 自解释 25 + 定义 15 = 75，无实体锚点
    const [scored] = scoring.scoreAtoms([atom])
    expect(scored.score.total).toBe(75)
    expect(scored.score.hasEntityAnchor).toBe(false)
  })

  it('最接近阈值边界：60 分不达标', () => {
    const atom: Atom = {
      text: 'zoomer AI 有 100 用户',
      subject: 'zoomer AI',
      predicate: '有',
      object: '用户',
      anchors: ['100'],
    }
    // 数字 35 + 自解释 25 = 60
    const [scored] = scoring.scoreAtoms([atom])
    expect(scored.score.total).toBe(60)
  })

  it('scorePage 计算所有 atom 的平均分', () => {
    const atoms: Atom[] = [
      { ...fullAtom, anchors: ['2024', 'zoomer AI'], definition: 'def' },
      { text: 'x', subject: '', predicate: '', object: '', anchors: [] },
    ]
    const scored = scoring.scoreAtoms(atoms)
    const pageScore = scoring.scorePage(scored)
    // 第一个 100 分，第二个 0 分，平均 50
    expect(pageScore).toBe(50)
  })

  it('空数组评分返回 0', () => {
    expect(scoring.scorePage(scoring.scoreAtoms([]))).toBe(0)
  })

  it('scorePageComposite 按权重计算综合分', () => {
    const composite = scoring.scorePageComposite(100, 100, 100)
    expect(composite).toBe(100)
  })

  it('scorePageComposite 权重分配正确', () => {
    const composite = scoring.scorePageComposite(80, 60, 70)
    const expected = Math.round(80 * 0.4 + 60 * 0.25 + 70 * 0.35)
    expect(composite).toBe(expected)
  })

  it('scorePageComposite 零分输入返回 0', () => {
    expect(scoring.scorePageComposite(0, 0, 0)).toBe(0)
  })
})
