import http from 'node:http'
import https from 'node:https'
import { lookup as dnsLookup } from 'node:dns/promises'
import { assertPublicHttpUrl, isBlockedIp, SsrfError } from './ssrf.js'

export type FetchErrorCode = 'ssrf' | 'timeout' | 'network' | 'too-many-redirects' | 'invalid-url' | 'dns'

export interface FetchOutcome {
  /** Last URL requested (or the URL that was rejected). */
  url: string
  status: number
  headers: Record<string, string>
  body: string
  truncated: boolean
  redirectChain: { url: string; status: number }[]
  durationMs: number
  error?: FetchErrorCode
  errorMessage?: string
}

export interface TransportRequest {
  url: URL
  method: 'GET' | 'HEAD'
  headers: Record<string, string>
  timeoutMs: number
  maxBytes: number
  /** Public address already checked. The transport must connect here, not re-resolve. */
  connectAddress: string
  connectFamily: 4 | 6
}

export interface TransportResponse {
  status: number
  headers: Record<string, string>
  body: string
  truncated: boolean
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>

export type DnsLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>

export interface SafeFetchInit {
  method?: 'GET' | 'HEAD'
  headers?: Record<string, string>
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  lookup?: DnsLookup
  transport?: Transport
}

const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_MAX_BYTES = 512_000
const DEFAULT_MAX_REDIRECTS = 5

export const defaultLookup: DnsLookup = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true })
  return records.map((r) => ({ address: r.address, family: r.family }))
}

function emptyOutcome(url: string, error: FetchErrorCode, errorMessage: string, started: number): FetchOutcome {
  return {
    url,
    status: 0,
    headers: {},
    body: '',
    truncated: false,
    redirectChain: [],
    durationMs: Date.now() - started,
    error,
    errorMessage,
  }
}

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

export const nodeTransport: Transport = (req) => new Promise((resolve, reject) => {
  const lib = req.url.protocol === 'https:' ? https : http
  let settled = false
  const finish = (fn: () => void) => {
    if (settled) return
    settled = true
    fn()
  }

  const request = lib.request({
    protocol: req.url.protocol,
    hostname: req.url.hostname,
    port: req.url.port || (req.url.protocol === 'https:' ? 443 : 80),
    path: `${req.url.pathname}${req.url.search}` || '/',
    method: req.method,
    headers: {
      ...req.headers,
      'accept-encoding': 'identity',
      host: req.url.host,
    },
    servername: req.url.hostname,
    lookup: (_hostname, options, callback) => {
      const cb = typeof options === 'function' ? options : callback
      const all = typeof options === 'object' && options != null && 'all' in options && options.all
      if (all) cb(null, [{ address: req.connectAddress, family: req.connectFamily }])
      else cb(null, req.connectAddress, req.connectFamily)
    },
  }, (res) => {
    const chunks: Buffer[] = []
    let size = 0
    let truncated = false
    const done = () => finish(() => resolve({
      status: res.statusCode ?? 0,
      headers: flattenHeaders(res.headers),
      body: Buffer.concat(chunks).toString('utf8'),
      truncated,
    }))
    res.on('data', (chunk: Buffer) => {
      if (truncated || size >= req.maxBytes) {
        truncated = true
        res.destroy()
        return
      }
      const remaining = req.maxBytes - size
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining))
        size += remaining
        truncated = true
        res.destroy()
        return
      }
      chunks.push(chunk)
      size += chunk.length
    })
    res.on('end', done)
    res.on('error', () => done())
  })

  request.setTimeout(req.timeoutMs, () => {
    const err = new Error('timeout')
    err.name = 'TimeoutError'
    request.destroy(err)
  })
  request.on('error', (err) => {
    finish(() => reject(err))
  })
  request.end()
})

async function resolveConnectAddress(hostname: string, lookup: DnsLookup): Promise<{ address: string; family: 4 | 6 }> {
  const literal = hostname.replace(/^\[|\]$/g, '')
  if (isBlockedIp(literal) && (literal.includes(':') || literal.split('.').length === 4)) {
    // Literal IPs are already rejected by assertPublicHttpUrl. Defense in depth.
    throw new SsrfError('目标地址被拒绝（本机、内网或云元数据地址）')
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(literal) || literal.includes(':')) {
    const family = literal.includes(':') ? 6 : 4
    if (isBlockedIp(literal)) throw new SsrfError('目标地址被拒绝（本机、内网或云元数据地址）')
    return { address: literal, family }
  }
  let records: Array<{ address: string; family: number }>
  try {
    records = await lookup(hostname)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'dns lookup failed'
    const wrapped = new SsrfError(`无法解析主机名：${hostname}`)
    wrapped.cause = err
    ;(wrapped as Error & { dnsMessage?: string }).dnsMessage = message
    throw wrapped
  }
  if (records.length === 0) throw new SsrfError(`无法解析主机名：${hostname}`)
  if (records.some((r) => isBlockedIp(r.address))) {
    throw new SsrfError('目标解析到内网或本机地址，已拒绝')
  }
  const first = records[0]
  return { address: first.address, family: first.family === 6 ? 6 : 4 }
}

function isTimeout(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = (err as { name?: string }).name
  const code = (err as { code?: string }).code
  return name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT'
}

/**
 * Fetch one URL with timeouts, a body cap, manual redirects, and SSRF checks
 * on every hop. DNS answers are pinned: the socket connects to the address
 * that was checked, so a rebinding response cannot swap in a private IP.
 */
export async function safeFetch(rawUrl: string, init: SafeFetchInit = {}): Promise<FetchOutcome> {
  const started = Date.now()
  const lookup = init.lookup ?? defaultLookup
  const transport = init.transport ?? nodeTransport
  const maxRedirects = init.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = init.maxBytes ?? DEFAULT_MAX_BYTES
  let method: 'GET' | 'HEAD' = init.method ?? 'GET'
  const headers = { ...(init.headers ?? {}) }
  const redirectChain: { url: string; status: number }[] = []
  const seen = new Set<string>()
  let current = rawUrl

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (seen.has(current)) {
      return { ...emptyOutcome(current, 'too-many-redirects', '重定向循环', started), redirectChain }
    }
    seen.add(current)

    let url: URL
    try {
      url = assertPublicHttpUrl(current)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'URL 被拒绝'
      // 语法/端口/协议问题不是「解析到了内网」。只有明确拒绝的地址才记为 ssrf，
      // 避免一条坏的 sitemap loc 把整次审计打成失败。
      const blocked = /内网|本机|元数据|被拒绝/.test(message)
      return { ...emptyOutcome(current, blocked ? 'ssrf' : 'invalid-url', message, started), redirectChain }
    }

    let connect: { address: string; family: 4 | 6 }
    try {
      connect = await resolveConnectAddress(url.hostname, lookup)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'DNS 被拒绝'
      const code: FetchErrorCode = err instanceof SsrfError && message.startsWith('无法解析') ? 'dns' : 'ssrf'
      return { ...emptyOutcome(url.toString(), code, message, started), redirectChain }
    }

    let res: TransportResponse
    try {
      res = await transport({
        url,
        method,
        headers,
        timeoutMs,
        maxBytes,
        connectAddress: connect.address,
        connectFamily: connect.family,
      })
    } catch (err) {
      if (isTimeout(err)) {
        return { ...emptyOutcome(url.toString(), 'timeout', '请求超时', started), redirectChain }
      }
      const message = err instanceof Error ? err.message : '网络错误'
      return { ...emptyOutcome(url.toString(), 'network', message, started), redirectChain }
    }

    const location = res.headers.location
    const isRedirect = res.status >= 300 && res.status < 400 && location
    if (isRedirect && hop < maxRedirects) {
      redirectChain.push({ url: url.toString(), status: res.status })
      try {
        current = new URL(location, url).toString()
      } catch {
        return {
          ...emptyOutcome(url.toString(), 'network', '重定向地址无效', started),
          redirectChain,
          status: res.status,
          headers: res.headers,
        }
      }
      if (res.status === 301 || res.status === 302 || res.status === 303) method = 'GET'
      continue
    }
    if (isRedirect && hop >= maxRedirects) {
      redirectChain.push({ url: url.toString(), status: res.status })
      return { ...emptyOutcome(url.toString(), 'too-many-redirects', '重定向次数过多', started), redirectChain }
    }

    return {
      url: url.toString(),
      status: res.status,
      headers: res.headers,
      body: res.body,
      truncated: res.truncated,
      redirectChain,
      durationMs: Date.now() - started,
    }
  }

  return { ...emptyOutcome(current, 'too-many-redirects', '重定向次数过多', started), redirectChain }
}
