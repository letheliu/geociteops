import { describe, it, expect, vi } from 'vitest'
import { createEntityExtractor } from './entity-extractor.js'
import type { LlmProvider } from '../llm/types.js'

function mockLlm(responseText: string): LlmProvider {
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({ text: responseText }),
    embed: vi.fn(),
  }
}

describe('EntityExtractor', () => {
  it('解析 LLM 返回的合法 JSON', async () => {
    const llmResponse = JSON.stringify({
      entities: [
        { name: 'zoomer AI', rawType: 'AI 设计工具', properties: { url: 'https://x.com' } },
      ],
      relations: [{ fromName: 'zoomer AI', toName: 'Notion', relationType: 'competitor' }],
    })
    const extractor = createEntityExtractor(mockLlm(llmResponse))
    const result = await extractor.extract('zoomer AI 是 AI 设计工具')
    expect(result.entities).toHaveLength(1)
    expect(result.entities[0].name).toBe('zoomer AI')
    expect(result.relations[0].relationType).toBe('competitor')
  })

  it('LLM 返回非 JSON 时兜底返回空结果', async () => {
    const extractor = createEntityExtractor(mockLlm('这不是 JSON'))
    const result = await extractor.extract('content')
    expect(result.entities).toEqual([])
    expect(result.relations).toEqual([])
    expect(result.extractionNotes).toBe('parse_failed')
  })

  it('JSON 缺少 entities 字段时兜底返回空数组', async () => {
    const extractor = createEntityExtractor(mockLlm(JSON.stringify({ wrong: 'shape' })))
    const result = await extractor.extract('content')
    expect(result.entities).toEqual([])
    expect(result.relations).toEqual([])
    expect(result.extractionNotes).toBe('parse_failed')
  })

  it('使用 temperature: 0 调用 LLM', async () => {
    const llm = mockLlm(JSON.stringify({ entities: [], relations: [] }))
    const extractor = createEntityExtractor(llm)
    await extractor.extract('test')
    expect(llm.chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ temperature: 0 }),
    )
  })

  it('空内容不调用 LLM，直接返回空结果', async () => {
    const llm = mockLlm('')
    const extractor = createEntityExtractor(llm)
    const result = await extractor.extract('')
    expect(result.entities).toEqual([])
    expect(result.relations).toEqual([])
    expect(llm.chat).not.toHaveBeenCalled()
  })
})
