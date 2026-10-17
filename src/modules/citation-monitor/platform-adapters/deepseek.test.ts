import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DeepSeekAdapter } from './deepseek.js'

describe('DeepSeekAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'zoomer AI。https://zoomer.top' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
  })
  afterEach(() => vi.restoreAllMocks())

  it('返回答案并提取 URL', async () => {
    const adapter = new DeepSeekAdapter()
    const result = await adapter.query('AI工具', { DEEPSEEK_API_KEY: 'ds-test' })
    expect(result.answer).toContain('zoomer AI')
    expect(result.citations[0].url).toBe('https://zoomer.top')
  })

  it('使用 DeepSeek base url', async () => {
    const adapter = new DeepSeekAdapter()
    await adapter.query('x', { DEEPSEEK_API_KEY: 'ds-test' })
    const calledUrl = (fetch as any).mock.calls[0][0] as string
    expect(calledUrl).toContain('deepseek.com')
  })
})
