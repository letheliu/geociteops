import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PerplexityAdapter } from './perplexity.js'

describe('PerplexityAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'zoomer AI 是一款设计工具 [1]' } }],
            citations: ['https://zoomer.top'],
            search_results: [
              { title: 'Zoomer AI 官网', url: 'https://zoomer.top', date: '2026-01-01' },
              { title: '设计工具对比', url: 'https://example.com/compare' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
  })
  afterEach(() => vi.restoreAllMocks())

  it('返回答案并从 search_results 提取引用', async () => {
    const adapter = new PerplexityAdapter()
    const result = await adapter.query('AI工具', { PERPLEXITY_API_KEY: 'px-test' })
    expect(result.answer).toContain('zoomer AI')
    expect(result.sourceCitations).toHaveLength(2)
    expect(result.sourceCitations[0].url).toBe('https://zoomer.top')
    expect(result.sourceCitations[0].title).toBe('Zoomer AI 官网')
    expect(result.sourceCitations[0].sourceType).toBe('api_citation')
  })

  it('无 search_results 时降级到 citations 数组', async () => {
    vi.restoreAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '答案' } }],
            citations: ['https://only-url.com'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
    const adapter = new PerplexityAdapter()
    const result = await adapter.query('x', { PERPLEXITY_API_KEY: 'px-test' })
    expect(result.sourceCitations).toHaveLength(1)
    expect(result.sourceCitations[0].url).toBe('https://only-url.com')
  })

  it('调用 perplexity 端点并携带 API key', async () => {
    const adapter = new PerplexityAdapter()
    await adapter.query('x', { PERPLEXITY_API_KEY: 'px-test' })
    const [url, init] = (fetch as any).mock.calls[0]
    expect(url).toContain('api.perplexity.ai')
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer px-test' })
  })

  it('HTTP 错误时抛错', async () => {
    vi.restoreAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"bad"}', { status: 500 })))
    const adapter = new PerplexityAdapter()
    await expect(adapter.query('x', { PERPLEXITY_API_KEY: 'px-test' })).rejects.toThrow()
  })
})
