import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AnthropicAdapter } from './anthropic.js'

describe('AnthropicAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '推荐 zoomer AI。参考 https://zoomer.top' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
  })
  afterEach(() => vi.restoreAllMocks())

  it('拼接 content 文本块', async () => {
    const adapter = new AnthropicAdapter()
    const result = await adapter.query('AI工具', { ANTHROPIC_API_KEY: 'sk-ant-test' })
    expect(result.answer).toContain('zoomer AI')
  })

  it('从文本提取 URL', async () => {
    const adapter = new AnthropicAdapter()
    const result = await adapter.query('AI工具', { ANTHROPIC_API_KEY: 'sk-ant-test' })
    expect(result.citations[0].url).toBe('https://zoomer.top')
  })
})
