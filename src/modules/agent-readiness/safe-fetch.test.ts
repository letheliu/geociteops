import { describe, expect, it, vi } from 'vitest'
import { safeFetch, type Transport } from './safe-fetch.js'

const publicLookup = vi.fn(async () => [{ address: '1.1.1.1', family: 4 }])

describe('safeFetch', () => {
  it('pins the connection to the resolved public address', async () => {
    const transport: Transport = vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'ok',
      truncated: false,
    }))
    const result = await safeFetch('https://example.com/robots.txt', { lookup: publicLookup, transport })
    expect(result.status).toBe(200)
    expect(result.body).toBe('ok')
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      connectAddress: '1.1.1.1',
      connectFamily: 4,
    }))
  })

  it('does not connect when DNS returns a private address', async () => {
    const transport: Transport = vi.fn()
    const result = await safeFetch('https://example.com/', {
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      transport,
    })
    expect(result.error).toBe('ssrf')
    expect(transport).not.toHaveBeenCalled()
  })

  it('treats a non-http redirect as an invalid URL, not a private-network block', async () => {
    const transport: Transport = vi.fn(async () => ({
      status: 302,
      headers: { location: 'ftp://example.com/file' },
      body: '',
      truncated: false,
    }))
    const result = await safeFetch('https://example.com/', { lookup: publicLookup, transport })
    expect(result.error).toBe('invalid-url')
  })

  it('rejects a redirect onto a literal private address before connecting', async () => {
    const transport: Transport = vi.fn(async () => ({
      status: 302,
      headers: { location: 'http://127.0.0.1/secret' },
      body: '',
      truncated: false,
    }))
    const result = await safeFetch('https://example.com/', { lookup: publicLookup, transport })
    expect(result.error).toBe('ssrf')
    expect(transport).toHaveBeenCalledTimes(1)
    expect(result.redirectChain).toEqual([{ url: 'https://example.com/', status: 302 }])
  })

  it('follows a redirect to another public host and switches 301 to GET', async () => {
    const methods: string[] = []
    const transport: Transport = vi.fn(async (req) => {
      methods.push(req.method)
      if (req.url.hostname === 'example.com') {
        return { status: 301, headers: { location: 'https://www.example.com/docs' }, body: '', truncated: false }
      }
      return { status: 200, headers: { 'content-type': 'text/html' }, body: 'page', truncated: true }
    })
    const result = await safeFetch('https://example.com/', {
      method: 'HEAD',
      lookup: publicLookup,
      transport,
    })
    expect(methods).toEqual(['HEAD', 'GET'])
    expect(result.status).toBe(200)
    expect(result.url).toBe('https://www.example.com/docs')
    expect(result.truncated).toBe(true)
    expect(result.redirectChain).toHaveLength(1)
  })

  it('stops on a redirect loop', async () => {
    const transport: Transport = vi.fn(async () => ({
      status: 302,
      headers: { location: 'https://example.com/' },
      body: '',
      truncated: false,
    }))
    const result = await safeFetch('https://example.com/', { lookup: publicLookup, transport, maxRedirects: 3 })
    expect(result.error).toBe('too-many-redirects')
  })

  it('maps a transport timeout', async () => {
    const transport: Transport = vi.fn(async () => {
      const err = new Error('timeout')
      err.name = 'TimeoutError'
      throw err
    })
    const result = await safeFetch('https://example.com/', { lookup: publicLookup, transport })
    expect(result.error).toBe('timeout')
  })
})
