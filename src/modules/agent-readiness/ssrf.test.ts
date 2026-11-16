import { describe, expect, it } from 'vitest'
import { assertPublicHttpUrl, isBlockedIp, SsrfError } from './ssrf.js'

describe('isBlockedIp', () => {
  it('blocks loopback, private, link-local, and documentation ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
      '255.255.255.255',
      '224.0.0.1',
      '203.0.113.10',
      '198.51.100.2',
      '192.0.2.1',
      '::1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true)
    }
  })

  it('allows public addresses', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:4860:4860::8888']) {
      expect(isBlockedIp(ip), ip).toBe(false)
    }
  })
})

describe('assertPublicHttpUrl', () => {
  it('accepts a public https URL and normalizes the default port', () => {
    const url = assertPublicHttpUrl('https://example.com:443/docs')
    expect(url.hostname).toBe('example.com')
    expect(url.pathname).toBe('/docs')
  })

  it('rejects non-http schemes, credentials, odd ports, and private hosts', () => {
    const samples = [
      'file:///etc/passwd',
      'https://user:pass@example.com/',
      'http://example.com:8080/',
      'http://127.0.0.1/',
      'http://localhost/admin',
      'http://2130706433/',
      'http://0x7f000001/',
      'https://metadata.google.internal/',
      'http://10.0.0.8/',
      'http://app.internal/',
      'not a url',
    ]
    for (const sample of samples) {
      expect(() => assertPublicHttpUrl(sample), sample).toThrow(SsrfError)
    }
  })
})
