import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenAiProvider } from './openai-provider.js'

describe('OpenAiProvider', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test')
    vi.stubEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('chat 调用 chat completions 并返回文本', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Hello GEO' } }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const provider = new OpenAiProvider()
    const res = await provider.chat([{ role: 'user', content: 'hi' }])

    expect(res.text).toBe('Hello GEO')
    expect(res.usage?.completionTokens).toBe(3)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.messages[0].content).toBe('hi')
  })

  it('embed 调用 embeddings 并返回向量数组', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ embedding: Array(1536).fill(0.1) }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const provider = new OpenAiProvider()
    const vec = await provider.embed('some text')
    expect(vec).toHaveLength(1536)
  })

  it('embedBatch 以数组 input 一次请求并保持返回顺序', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { embedding: Array(1536).fill(0.1) },
            { embedding: Array(1536).fill(0.2) },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const provider = new OpenAiProvider()
    const vecs = await provider.embedBatch(['a', 'b'])
    expect(vecs).toHaveLength(2)
    expect(vecs[0]).toHaveLength(1536)
    expect(vecs[1][0]).toBe(0.2)
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.input).toEqual(['a', 'b'])
  })

  it('embedBatch 空输入直接返回空数组且不发请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OpenAiProvider()
    const vecs = await provider.embedBatch([])
    expect(vecs).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('chat 失败时抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('{"error":"bad"}', { status: 500 }),
    ))
    const provider = new OpenAiProvider()
    await expect(provider.chat([{ role: 'user', content: 'x' }])).rejects.toThrow()
  })
})
