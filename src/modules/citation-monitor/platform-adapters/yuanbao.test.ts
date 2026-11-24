import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { YuanbaoAdapter } from './yuanbao.js'
import { DEMO_OUTBOUND_BLOCKED } from '../../../core/demo/blocked-llm.js'
import { classifySampleError } from '../../diagnostic/executor.js'

const SEARCH_BODY = {
  choices: [{ message: { content: 'Acme Draw 是设计工具[1](@ref)' } }],
  search_info: {
    search_results: [
      { index: 1, title: 'Acme Draw 官网', url: 'https://acmedraw.example', text: 'Acme Draw' },
      { index: 2, title: '对比', url: 'https://example.com/compare', text: 'Example' },
    ],
  },
}

describe('YuanbaoAdapter', () => {
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

  it('从混元 search_info.search_results 提取引用', async () => {
    const result = await new YuanbaoAdapter().query('AI工具', { HUNYUAN_API_KEY: 'hy-test' })
    expect(result.answer).toContain('Acme Draw')
    expect(result.sourceCitations).toHaveLength(2)
    expect(result.sourceCitations[0]).toMatchObject({
      url: 'https://acmedraw.example',
      title: 'Acme Draw 官网',
      position: 1,
      sourceType: 'api_citation',
      providerMetadata: { siteName: 'Acme Draw' },
    })
  })

  it('兼容原生 SearchInfo.SearchResults 的 PascalCase', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '答案' } }],
            SearchInfo: { SearchResults: [{ Index: 3, Title: '官网', Url: 'https://acmedraw.example', Text: '站点' }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
    const result = await new YuanbaoAdapter().query('x', { HUNYUAN_API_KEY: 'hy-test' })
    expect(result.sourceCitations[0]).toMatchObject({
      url: 'https://acmedraw.example',
      title: '官网',
      position: 3,
      providerMetadata: { siteName: '站点' },
    })
  })

  it('没有 search_info 时从答案正文提取 URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: '见 https://only.example/a' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
    const result = await new YuanbaoAdapter().query('x', { HUNYUAN_API_KEY: 'hy-test' })
    expect(result.sourceCitations).toEqual([
      { url: 'https://only.example/a', position: 1, sourceType: 'answer_url' },
    ])
  })

  it('调用混元 OpenAI 兼容端点并打开搜索增强与引文', async () => {
    await new YuanbaoAdapter().query('x', { HUNYUAN_API_KEY: 'hy-test' })
    const [url, init] = (fetch as any).mock.calls[0]
    expect(url).toBe('https://api.hunyuan.cloud.tencent.com/v1/chat/completions')
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer hy-test' })
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.model).toBe('hunyuan-turbos-latest')
    expect(body.enable_enhancement).toBe(true)
    expect(body.search_info).toBe(true)
    expect(body.citation).toBe(true)
    expect(body).not.toHaveProperty('temperature')
  })

  it('尊重 HUNYUAN_BASE_URL 与 HUNYUAN_MODEL', async () => {
    await new YuanbaoAdapter().query('x', {
      HUNYUAN_API_KEY: 'hy-test',
      HUNYUAN_BASE_URL: 'https://api.hunyuan.cloud.tencent.com/v1/',
      HUNYUAN_MODEL: 'hunyuan-turbo',
    })
    const [url, init] = (fetch as any).mock.calls[0]
    expect(url).toBe('https://api.hunyuan.cloud.tencent.com/v1/chat/completions')
    expect(JSON.parse((init as RequestInit).body as string).model).toBe('hunyuan-turbo')
  })

  it('没有 choices 时抛错', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })),
    )
    await expect(new YuanbaoAdapter().query('x', { HUNYUAN_API_KEY: 'hy-test' })).rejects.toThrow(/invalid response/)
  })

  it('429 带 status，诊断采样归为 RATE_LIMITED', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('rate limit', { status: 429 })))
    const err = await new YuanbaoAdapter().query('x', { HUNYUAN_API_KEY: 'hy-test' }).catch((e) => e)
    expect(err.status).toBe(429)
    expect(classifySampleError(err)).toMatchObject({ code: 'RATE_LIMITED', retryable: true })
  })

  it('500 归为可重试的 PLATFORM_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })))
    const err = await new YuanbaoAdapter().query('x', { HUNYUAN_API_KEY: 'hy-test' }).catch((e) => e)
    expect(classifySampleError(err)).toMatchObject({ code: 'PLATFORM_ERROR', retryable: true })
  })

  it('缺少 HUNYUAN_API_KEY 时不发请求', async () => {
    const err = await new YuanbaoAdapter().query('x', {}).catch((e) => e)
    expect(err.message).toMatch(/missing HUNYUAN_API_KEY/)
    expect(err.status).toBe(401)
    expect(classifySampleError(err).code).toBe('CONFIGURATION_ERROR')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('DEMO_MODE 保持桩实现，不向外请求', async () => {
    vi.stubEnv('DEMO_MODE', 'on')
    await expect(new YuanbaoAdapter().query('x', { HUNYUAN_API_KEY: 'hy-test' })).rejects.toThrow(DEMO_OUTBOUND_BLOCKED)
    expect(fetch).not.toHaveBeenCalled()
  })
})
