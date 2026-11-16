import net from 'node:net'

export class SsrfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsrfError'
  }
}

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.internal',
])

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = (value << 8) | n
  }
  return value >>> 0
}

function inCidr(ip: string, base: string, bits: number): boolean {
  const a = ipv4ToInt(ip)
  const b = ipv4ToInt(base)
  if (a == null || b == null) return false
  if (bits === 0) return true
  const mask = bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0
  return (a & mask) === (b & mask)
}

export function isBlockedIp(raw: string): boolean {
  let ip = raw.trim().toLowerCase().replace(/^\[|\]$/g, '')
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isBlockedIp(mapped[1])
  if (ip.startsWith('::ffff:')) {
    const hex = ip.slice('::ffff:'.length)
    const parts = hex.split(':')
    if (parts.length === 2 && parts.every((p) => /^[0-9a-f]{1,4}$/.test(p))) {
      const hi = parseInt(parts[0], 16)
      const lo = parseInt(parts[1], 16)
      const v4 = [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.')
      return isBlockedIp(v4)
    }
  }

  const kind = net.isIP(ip)
  if (kind === 4) {
    if (ip === '255.255.255.255') return true
    return (
      inCidr(ip, '0.0.0.0', 8) ||
      inCidr(ip, '10.0.0.0', 8) ||
      inCidr(ip, '100.64.0.0', 10) ||
      inCidr(ip, '127.0.0.0', 8) ||
      inCidr(ip, '169.254.0.0', 16) ||
      inCidr(ip, '172.16.0.0', 12) ||
      inCidr(ip, '192.0.0.0', 24) ||
      inCidr(ip, '192.0.2.0', 24) ||
      inCidr(ip, '192.168.0.0', 16) ||
      inCidr(ip, '198.18.0.0', 15) ||
      inCidr(ip, '198.51.100.0', 24) ||
      inCidr(ip, '203.0.113.0', 24) ||
      inCidr(ip, '224.0.0.0', 4) ||
      inCidr(ip, '240.0.0.0', 4)
    )
  }
  if (kind === 6) {
    if (ip === '::' || ip === '::1') return true
    const first = ip.split(':').find((p) => p.length > 0) ?? '0'
    const head = parseInt(first.slice(0, 4).padEnd(4, '0'), 16)
    if (Number.isNaN(head)) return true
    // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast
    if ((head & 0xfe00) === 0xfc00) return true
    if ((head & 0xffc0) === 0xfe80) return true
    if ((head & 0xff00) === 0xff00) return true
    // 2001:db8::/32 documentation
    if (ip.startsWith('2001:db8:')) return true
    return false
  }
  return true
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host) return true
  if (BLOCKED_HOSTS.has(host)) return true
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  if (net.isIP(host)) return isBlockedIp(host)
  // Decimal or hex IP obfuscation (http://2130706433, http://0x7f000001).
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true
  // Dotted junk that is not a real public IPv4 (http://127.1).
  if (/^[\d.]+$/.test(host)) return true
  return false
}

/**
 * Syntactic public-URL check (scheme, credentials, port, literal addresses).
 * DNS resolution is enforced later, at connect time, so a public name that
 * resolves to a private address is still rejected.
 */
export function assertPublicHttpUrl(raw: string): URL {
  if (!raw || raw.length > 2048) {
    throw new SsrfError('URL 无效或过长')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SsrfError('URL 无效')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('仅允许 http 或 https')
  }
  if (url.username || url.password) {
    throw new SsrfError('URL 不能包含用户名或密码')
  }
  const port = url.port
  const allowedPort = url.protocol === 'https:' ? '443' : '80'
  if (port && port !== allowedPort) {
    throw new SsrfError('仅允许默认端口（http 80 / https 443）')
  }
  if (isBlockedHostname(url.hostname)) {
    throw new SsrfError('目标地址被拒绝（本机、内网或云元数据地址）')
  }
  return url
}
