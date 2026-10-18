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

// ---------------------------------------------------------------------------
// M2 §3.3 rewriteForQuery：整页改写（带查询上下文），返回纯文本建议稿。
// 与 rewrite/rewriteBatch（JSON 原子输出）并存，互不影响。
// ---------------------------------------------------------------------------

describe('rewriteForQuery（M2 §3.3 整页改写）', () => {
  it('prompt 带 queryText 与 brand，并要求输出纯文本正文', async () => {
    const llm = mockLlm('这是改写后的整页正文')
    const rewriter = createRewriter(llm)

    const out = await rewriter.rewriteForQuery('原始整页内容', 'AI 设计工具哪个好', 'zoomer AI')
    expect(out).toBe('这是改写后的整页正文')

    const messages = (llm.chat as any).mock.calls[0][0]
    const prompt = messages.map((m: any) => m.content).join('\n')
    expect(prompt).toContain('AI 设计工具哪个好')
    expect(prompt).toContain('zoomer AI')
    expect(prompt).toContain('原始整页内容')
  })

  it('返回纯文本原样（不解析 JSON、不裁剪）', async () => {
    const llm = mockLlm('  多段\n\n正文  ')
    const rewriter = createRewriter(llm)
    const out = await rewriter.rewriteForQuery('原文', '查询', 'brand')
    expect(out).toBe('  多段\n\n正文  ')
  })

  it('LLM 抛错时向上抛（调用方捕获并把任务置 FAILED，不留半态）', async () => {
    const llm: any = {
      name: 'mock',
      chat: vi.fn().mockRejectedValue(new Error('LLM 503')),
      embed: vi.fn(),
    }
    const rewriter = createRewriter(llm as LlmProvider)
    await expect(rewriter.rewriteForQuery('原文', '查询', 'brand')).rejects.toThrow('LLM 503')
  })

  it('不影响既有 rewrite/rewriteBatch 接口', async () => {
    const llm = mockLlm(JSON.stringify({ text: 't', subject: 's', predicate: 'p', object: 'o', anchors: [] }))
    const rewriter = createRewriter(llm)
    expect(typeof rewriter.rewrite).toBe('function')
    expect(typeof rewriter.rewriteBatch).toBe('function')
  })
})
