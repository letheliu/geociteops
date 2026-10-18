import { describe, it, expect } from 'vitest'
import { sanitizeMessage } from './sanitize-message.js'

describe('sanitizeMessage', () => {
  it('遮蔽长 API key（sk- 前缀的长令牌）', () => {
    const msg = 'Auth failed for key sk-abcdefghijklmnopqrstuvwxyz123456'
    const out = sanitizeMessage(msg)
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456')
    expect(out).toContain('[REDACTED]')
  })

  it('遮蔽 URL 路径里的长令牌段', () => {
    const msg = 'POST https://api.example.com/v1/tokens/ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 failed'
    const out = sanitizeMessage(msg)
    expect(out).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')
    expect(out).toContain('[REDACTED]')
  })

  it('短消息与中文原样保留（只遮蔽 ≥20 字符的字母数字串）', () => {
    expect(sanitizeMessage('连接被拒绝')).toBe('连接被拒绝')
    expect(sanitizeMessage('ETIMEDOUT')).toBe('ETIMEDOUT')
    expect(sanitizeMessage('rate limit 429')).toBe('rate limit 429')
  })

  it('19 字符不遮蔽、20 字符遮蔽（阈值边界）', () => {
    const n19 = 'a'.repeat(19)
    const n20 = 'b'.repeat(20)
    expect(sanitizeMessage(n19)).toBe(n19)
    expect(sanitizeMessage(n20)).toBe('[REDACTED]')
  })

  it('截断到 500 字符', () => {
    // 用空格分隔的短词，避免整串本身就是一个 ≥20 字符的令牌而被先遮蔽
    const out = sanitizeMessage('word '.repeat(300))
    expect(out.length).toBe(500)
  })

  it('先遮蔽后截断（长密钥不会被截断漏出）', () => {
    const key = `sk-${'k'.repeat(40)}`
    const out = sanitizeMessage(`${key}` + ' word '.repeat(300))
    expect(out).toContain('[REDACTED]')
    expect(out).not.toContain(key)
    expect(out.length).toBe(500)
  })

  it('接受 Error 对象（取 message）', () => {
    expect(sanitizeMessage(new Error('boom'))).toBe('boom')
    expect(sanitizeMessage(new Error(`sk-${'z'.repeat(25)}`))).toBe('[REDACTED]')
  })

  it('无 message 的异常对象退化为 String(err)', () => {
    expect(sanitizeMessage({ code: 'X' } as unknown)).toBe('[object Object]')
  })
})
