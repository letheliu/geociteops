import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GeminiAdapter } from './gemini.js'

describe('GeminiAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [{
              content: { parts: [{ text: 'zoomer AI ' }, { text: '是设计工具' }] },
              groundingMetadata: {
                groundingChunks: [
                  { web: { uri: 'https://zoomer.top', title: 'Zoomer AI 官网' } },
                  { web: { uri: 'https://example.com', title: '设计工具' } },
                ],
              },
            }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
  })
  afterEach(() => vi.restoreAllMocks())

  it('拼接答案并从 groundingChunks 提取引用', async () => {
    const adapter = new GeminiAdapter()
    const result = await adapter.query('AI工具', { GEMINI_API_KEY: 'gem-test' })
    expect(result.answer).toBe('zoomer AI 是设计工具')
    expect(result.sourceCitations).toHaveLength(2)
    expect(result.sourceCitations[0].url).toBe('https://zoomer.top')
    expect(result.sourceCitations[0].title).toBe('Zoomer AI 官网')
    expect(result.sourceCitations[0].sourceType).toBe('grounding')
  })

  it('无 groundingMetadata 时返回空引用', async () => {
    vi.restoreAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '纯文本答案' }] } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
    const adapter = new GeminiAdapter()
    const result = await adapter.query('x', { GEMINI_API_KEY: 'gem-test' })
    expect(result.answer).toBe('纯文本答案')
    expect(result.sourceCitations).toEqual([])
  })

  it('调用 gemini 端点并在 query 携带 API key', async () => {
    const adapter = new GeminiAdapter()
    await adapter.query('x', { GEMINI_API_KEY: 'gem-test' })
    const url = (fetch as any).mock.calls[0][0] as string
    expect(url).toContain('generativelanguage.googleapis.com')
    expect(url).toContain('key=gem-test')
  })

  it('HTTP 错误时抛错', async () => {
    vi.restoreAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('err', { status: 400 })))
    const adapter = new GeminiAdapter()
    await expect(adapter.query('x', { GEMINI_API_KEY: 'gem-test' })).rejects.toThrow()
  })
})
