import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ChatGptSearchAdapter } from './chatgpt.js'

describe('ChatGptSearchAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: 'zoomer AI 是设计工具。详见 https://zoomer.top',
                annotations: [
                  { type: 'url_citation', url_citation: { url: 'https://zoomer.top', title: 'Zoomer AI' } },
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

  it('返回答案并从 annotations 提取引用', async () => {
    const adapter = new ChatGptSearchAdapter()
    const result = await adapter.query('AI工具', { OPENAI_API_KEY: 'sk-test' })
    expect(result.answer).toContain('zoomer AI')
    expect(result.sourceCitations).toHaveLength(1)
    expect(result.sourceCitations[0].url).toBe('https://zoomer.top')
    expect(result.sourceCitations[0].title).toBe('Zoomer AI')
  })

  it('无 annotations 时降级正则提 URL', async () => {
    vi.restoreAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '推荐访问 https://example.com/page' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
    const adapter = new ChatGptSearchAdapter()
    const result = await adapter.query('x', { OPENAI_API_KEY: 'sk-test' })
    expect(result.sourceCitations).toHaveLength(1)
    expect(result.sourceCitations[0].url).toBe('https://example.com/page')
  })

  it('调用配置的 base url 与 search model', async () => {
    const adapter = new ChatGptSearchAdapter()
    await adapter.query('x', { OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: 'https://custom.api/v1', OPENAI_SEARCH_MODEL: 'gpt-4o-search-preview' })
    const [url, init] = (fetch as any).mock.calls[0]
    expect(url).toBe('https://custom.api/v1/chat/completions')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.model).toBe('gpt-4o-search-preview')
  })

  it('HTTP 错误时抛错', async () => {
    vi.restoreAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('err', { status: 429 })))
    const adapter = new ChatGptSearchAdapter()
    await expect(adapter.query('x', { OPENAI_API_KEY: 'sk-test' })).rejects.toThrow()
  })
})
