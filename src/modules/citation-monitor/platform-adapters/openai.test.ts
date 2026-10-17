import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenAiAdapter } from './openai.js'

describe('OpenAiAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '推荐 zoomer AI 和 Figma。详情见 https://zoomer.top',
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
  })
  afterEach(() => vi.restoreAllMocks())

  it('返回答案文本', async () => {
    const adapter = new OpenAiAdapter()
    const result = await adapter.query('AI设计工具', {
      OPENAI_API_KEY: 'sk-test',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
    })
    expect(result.answer).toContain('zoomer AI')
  })

  it('从答案提取 URL 作为 sourceCitations（answer_url 类型）', async () => {
    const adapter = new OpenAiAdapter()
    const result = await adapter.query('AI设计工具', { OPENAI_API_KEY: 'sk-test' })
    expect(result.sourceCitations.length).toBeGreaterThan(0)
    expect(result.sourceCitations[0]).toMatchObject({
      url: 'https://zoomer.top',
      sourceType: 'answer_url',
    })
  })
})
