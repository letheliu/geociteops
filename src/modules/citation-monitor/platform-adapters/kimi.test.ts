import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { KimiAdapter } from './kimi.js'
import { DEMO_OUTBOUND_BLOCKED } from '../../../core/demo/blocked-llm.js'
import { classifySampleError } from '../../diagnostic/executor.js'

const SEARCH_BODY = {
  output_text: 'Acme Draw 是一款设计工具。',
  output: [
    {
      type: 'web_search_call',
      status: 'completed',
      action: {
        type: 'search',
        query: 'AI工具',
        sources: [
          { type: 'url', url: 'https://acmedraw.example', title: 'Acme Draw 官网' },
          { type: 'url', url: 'https://example.com/compare', title: '设计工具对比' },
          { type: 'url', url: 'https://acmedraw.example', title: '重复' },
        ],
      },
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Acme Draw 是一款设计工具。' }],
    },
  ],
}

describe('KimiAdapter', () => {
  beforeEach(() => {
    vi.stubEnv('DEMO_MODE', 'off')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(SEARCH_BODY), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('从 Responses web_search_call.action.sources 提取引用并去重', async () => {
    const adapter = new KimiAdapter()
    const result = await adapter.query('AI工具', { MOONSHOT_API_KEY: 'sk-moon' })
    expect(result.answer).toContain('Acme Draw')
    expect(result.sourceCitations).toHaveLength(2)
    expect(result.sourceCitations[0]).toMatchObject({
      url: 'https://acmedraw.example',
      title: 'Acme Draw 官网',
      position: 1,
      sourceType: 'api_citation',
    })
    expect(result.sourceCitations[1].url).toBe('https://example.com/compare')
  })

  it('没有 sources 时从答案正文提取 URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            output: [{ type: 'message', content: [{ type: 'output_text', text: '见 https://only.example/page' }] }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
    const result = await new KimiAdapter().query('x', { MOONSHOT_API_KEY: 'sk-moon' })
    expect(result.sourceCitations).toEqual([
      { url: 'https://only.example/page', position: 1, sourceType: 'answer_url' },
    ])
  })

  it('调用 api.moonshot.cn/v1/responses，携带 web_search 与 API key', async () => {
    await new KimiAdapter().query('x', { MOONSHOT_API_KEY: 'sk-moon' })
    const [url, init] = (fetch as any).mock.calls[0]
    expect(url).toBe('https://api.moonshot.cn/v1/responses')
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer sk-moon' })
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.model).toBe('kimi-k3')
    expect(body.tools).toEqual([{ type: 'web_search' }])
    expect(body.include).toEqual(['web_search_call.action.sources'])
    expect(body).not.toHaveProperty('temperature')
  })

  it('尊重 MOONSHOT_BASE_URL 与 MOONSHOT_MODEL', async () => {
    await new KimiAdapter().query('x', {
      MOONSHOT_API_KEY: 'sk-moon',
      MOONSHOT_BASE_URL: 'https://api.moonshot.cn/v1/',
      MOONSHOT_MODEL: 'kimi-k3.1-pro',
    })
    const [url, init] = (fetch as any).mock.calls[0]
    expect(url).toBe('https://api.moonshot.cn/v1/responses')
    expect(JSON.parse((init as RequestInit).body as string).model).toBe('kimi-k3.1-pro')
  })

  it('响应体不是 Responses 形状时抛错', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })),
    )
    await expect(new KimiAdapter().query('x', { MOONSHOT_API_KEY: 'sk-moon' })).rejects.toThrow(/invalid response/)
  })

  it('429 带 status，诊断采样归为 RATE_LIMITED', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":{"type":"rate_limited"}}', { status: 429 })))
    const err = await new KimiAdapter().query('x', { MOONSHOT_API_KEY: 'sk-moon' }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(429)
    expect(classifySampleError(err)).toMatchObject({ code: 'RATE_LIMITED', retryable: true })
  })

  it('缺少 MOONSHOT_API_KEY 时不发请求', async () => {
    await expect(new KimiAdapter().query('x', {})).rejects.toThrow(/missing MOONSHOT_API_KEY/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('DEMO_MODE 保持桩实现，不向外请求', async () => {
    vi.stubEnv('DEMO_MODE', 'on')
    await expect(new KimiAdapter().query('x', { MOONSHOT_API_KEY: 'sk-moon' })).rejects.toThrow(DEMO_OUTBOUND_BLOCKED)
    expect(fetch).not.toHaveBeenCalled()
  })
})
