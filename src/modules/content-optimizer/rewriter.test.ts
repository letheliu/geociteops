import { describe, it, expect, vi } from 'vitest'
import { createRewriter } from './rewriter.js'
import type { LlmProvider } from '../../core/llm/types.js'
import type { ScoredAtom } from './types.js'

function mockLlm(responseText: string): LlmProvider {
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({ text: responseText }),
    embed: vi.fn(),
  }
}

function makeScoredAtom(overrides: Partial<ScoredAtom> = {}): ScoredAtom {
  return {
    text: '原始文本',
    subject: 'zoomer AI',
    predicate: '是',
    object: '工具',
    anchors: [],
    score: {
      total: 40,
      hasNumericAnchor: false,
      hasEntityAnchor: false,
      isSelfContained: true,
      hasDefinition: false,
    },
    ...overrides,
  }
}

describe('LlmRewriter', () => {
  it('rewriteBatch 只重写不达标的 atom（score < threshold）', async () => {
    const rewrittenJson = JSON.stringify({
      text: 'zoomer AI 在 2024 年服务了 50 万设计师',
      subject: 'zoomer AI',
      predicate: '服务了',
      object: '50 万设计师',
      anchors: ['2024年', '50万', 'zoomer AI'],
      definition: 'zoomer AI 是一款 AI 设计工具',
    })
    const llm = mockLlm(rewrittenJson)
    const rewriter = createRewriter(llm)

    const lowScoreAtom = makeScoredAtom({
      text: 'a',
      score: { total: 40, hasNumericAnchor: false, hasEntityAnchor: false, isSelfContained: true, hasDefinition: false },
    })
    const highScoreAtom = makeScoredAtom({
      text: 'b',
      score: { total: 85, hasNumericAnchor: true, hasEntityAnchor: true, isSelfContained: true, hasDefinition: false },
    })

    const result = await rewriter.rewriteBatch([lowScoreAtom, highScoreAtom])
    expect(result).toHaveLength(2)

    // 低分的被重写了
    const rewritten = result.find((a) => a.text.includes('50 万设计师'))
    expect(rewritten).toBeDefined()
    expect(rewritten!.score.total).toBeGreaterThanOrEqual(70)

    // 高分的保持不变
    const unchanged = result.find((a) => a.text === 'b')
    expect(unchanged).toBeDefined()
    expect(unchanged!.score.total).toBe(85)
  })

  it('默认 threshold 为 70', async () => {
    const llm = mockLlm(JSON.stringify({
      text: '改写后',
      subject: 'x',
      predicate: 'y',
      object: 'z',
      anchors: ['123'],
      definition: 'x 是 z',
    }))
    const rewriter = createRewriter(llm)

    const atom = makeScoredAtom({
      score: { total: 69, hasNumericAnchor: false, hasEntityAnchor: false, isSelfContained: true, hasDefinition: false },
    })
    await rewriter.rewriteBatch([atom])
    expect(llm.chat).toHaveBeenCalled()
  })

  it('score 等于 threshold 时不重写', async () => {
    const llm = mockLlm('{}')
    const rewriter = createRewriter(llm)

    const atom = makeScoredAtom({
      score: { total: 70, hasNumericAnchor: true, hasEntityAnchor: true, isSelfContained: true, hasDefinition: false },
    })
    await rewriter.rewriteBatch([atom])
    expect(llm.chat).not.toHaveBeenCalled()
  })

  it('rewrite 单个 atom', async () => {
    const rewrittenJson = JSON.stringify({
      text: '改写后内容 2024',
      subject: 'zoomer AI',
      predicate: '是',
      object: '工具',
      anchors: ['2024', 'zoomer AI'],
      definition: 'zoomer AI 是工具',
    })
    const llm = mockLlm(rewrittenJson)
    const rewriter = createRewriter(llm)

    const atom = makeScoredAtom()
    const result = await rewriter.rewrite(atom, atom.score)
    expect(result.text).toBe('改写后内容 2024')
    expect(result.anchors).toContain('2024')
  })

  it('LLM 返回非 JSON 时保留原文', async () => {
    const llm = mockLlm('这不是JSON')
    const rewriter = createRewriter(llm)

    const atom = makeScoredAtom({ text: '原始' })
    const result = await rewriter.rewrite(atom, atom.score)
    expect(result.text).toBe('原始')
  })
})
