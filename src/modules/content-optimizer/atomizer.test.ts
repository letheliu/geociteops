import { describe, it, expect, vi } from 'vitest'
import { createAtomizer } from './atomizer.js'
import type { LlmProvider } from '../../core/llm/types.js'

function mockLlm(responseText: string): LlmProvider {
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({ text: responseText }),
    embed: vi.fn(),
  }
}

describe('ContentAtomizer', () => {
  it('解析 LLM 返回的合法 JSON', async () => {
    const llmResponse = JSON.stringify({
      atoms: [
        {
          text: 'zoomer AI 在 2024 年获得了 50 万用户',
          subject: 'zoomer AI',
          predicate: '获得了',
          object: '50 万用户',
          anchors: ['2024年', '50万'],
          definition: 'zoomer AI 是一款 AI 设计工具',
        },
      ],
    })
    const atomizer = createAtomizer(mockLlm(llmResponse))
    const atoms = await atomizer.atomize('原始内容')
    expect(atoms).toHaveLength(1)
    expect(atoms[0].subject).toBe('zoomer AI')
    expect(atoms[0].anchors).toContain('2024年')
  })

  it('LLM 返回非 JSON 时兜底按段落分割', async () => {
    const llmResponse = '这是第一段。\n\n这是第二段。'
    const atomizer = createAtomizer(mockLlm(llmResponse))
    const atoms = await atomizer.atomize('原始内容')
    expect(atoms).toHaveLength(2)
    expect(atoms[0].text).toBe('这是第一段。')
    expect(atoms[0].subject).toBe('')
    expect(atoms[1].text).toBe('这是第二段。')
  })

  it('空内容返回空数组', async () => {
    const atomizer = createAtomizer(mockLlm(JSON.stringify({ atoms: [] })))
    const atoms = await atomizer.atomize('')
    expect(atoms).toHaveLength(0)
  })

  it('使用 temperature: 0 调用 LLM', async () => {
    const llm = mockLlm(JSON.stringify({ atoms: [] }))
    const atomizer = createAtomizer(llm)
    await atomizer.atomize('test')
    expect(llm.chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ temperature: 0 }),
    )
  })
})
