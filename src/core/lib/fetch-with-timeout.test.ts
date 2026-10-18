import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchWithTimeout, TimeoutError, DEFAULT_FETCH_TIMEOUT_MS } from './fetch-with-timeout.js'

describe('fetchWithTimeout', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete process.env.CITATION_FETCH_TIMEOUT_MS
  })

  /** 永挂起的 fetch：只在 signal 被 abort 时 reject，模拟平台不返回 */
  function hangingFetch() {
    return vi.fn((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('This operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      }),
    )
  }

  it('挂起请求在超时后抛 TimeoutError', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    await expect(fetchWithTimeout('https://api.example.com/chat', {}, 30)).rejects.toThrow(TimeoutError)
  })

  it('超时后 signal 被置为 aborted（真正中断底层请求）', async () => {
    const fetchMock = hangingFetch()
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchWithTimeout('https://api.example.com/chat', {}, 30)).rejects.toThrow(TimeoutError)

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal?.aborted).toBe(true)
  })

  it('TimeoutError 携带 URL 与超时时长，便于 failureReason 定位', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const err = await fetchWithTimeout('https://api.example.com/chat', {}, 30).catch((e) => e)
    expect(err).toBeInstanceOf(TimeoutError)
    expect(err.name).toBe('TimeoutError')
    expect(err.message).toContain('api.example.com')
    expect(err.message).toContain('30')
  })

  it('默认超时 30s', () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(30000)
  })

  it('未显式传参时读环境变量 CITATION_FETCH_TIMEOUT_MS', async () => {
    process.env.CITATION_FETCH_TIMEOUT_MS = '40'
    vi.stubGlobal('fetch', hangingFetch())
    await expect(fetchWithTimeout('https://api.example.com/chat')).rejects.toThrow(TimeoutError)
  })

  it('显式传参优先于环境变量', async () => {
    process.env.CITATION_FETCH_TIMEOUT_MS = '40'
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    // 环境变量是 40ms，但显式给了 2000ms；60ms 后才返回 → 不应超时
    const res = await fetchWithTimeout('https://api.example.com/chat', {}, 2000)
    expect(res.status).toBe(200)

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal?.aborted).toBe(false)
  })

  it('默认 30s 内返回的请求正常透传', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await fetchWithTimeout('https://api.example.com/chat')
    expect(res.status).toBe(200)
  })

  it('透传 method/headers/body，并补上 signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchWithTimeout('https://api.example.com/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x' }),
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/chat')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'content-type': 'application/json' })
    expect(init.body).toBe(JSON.stringify({ model: 'x' }))
    expect(init.signal).toBeDefined()
  })

  it('外部 signal 中止时同样中止（调用方取消 → 底层请求也停）', async () => {
    const fetchMock = hangingFetch()
    vi.stubGlobal('fetch', fetchMock)
    const outer = new AbortController()

    const promise = fetchWithTimeout('https://api.example.com/chat', { signal: outer.signal }, 5000)
    outer.abort()

    await expect(promise).rejects.toThrow()
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal?.aborted).toBe(true)
  })

  it('非超时的网络错误原样透传，不被误报成 TimeoutError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const err = await fetchWithTimeout('https://api.example.com/chat', {}, 1000).catch((e) => e)
    expect(err).not.toBeInstanceOf(TimeoutError)
    expect(err.message).toBe('ECONNREFUSED')
  })
})
