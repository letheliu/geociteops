import { describe, expect, it } from 'vitest'
import { checkBotUserAgent, checkHttpAccess } from './access.js'

describe('access checks', () => {
  it('passes a fast 200 and warns on a slow response', () => {
    expect(checkHttpAccess({ status: 200, durationMs: 120, redirectCount: 1 }).status).toBe('pass')
    expect(checkHttpAccess({ status: 200, durationMs: 4200, redirectCount: 0 }).status).toBe('warn')
    expect(checkHttpAccess({ status: 404, durationMs: 80, redirectCount: 0 }).status).toBe('fail')
    expect(checkHttpAccess({ status: 0, durationMs: 8000, error: 'timeout' }).status).toBe('fail')
  })

  it('fails when an AI bot user-agent is challenged and the browser is not', () => {
    const check = checkBotUserAgent(
      { status: 200, durationMs: 100 },
      [
        { token: 'GPTBot', userAgent: 'GPTBot', status: 403, durationMs: 40 },
        { token: 'ClaudeBot', userAgent: 'ClaudeBot', status: 200, durationMs: 90 },
      ],
    )
    expect(check.status).toBe('fail')
    expect(check.explanation.en).toContain('GPTBot got HTTP 403')
  })

  it('passes when both bot probes match the browser', () => {
    const check = checkBotUserAgent(
      { status: 200, durationMs: 100 },
      [
        { token: 'GPTBot', userAgent: 'GPTBot', status: 200, durationMs: 110 },
        { token: 'ClaudeBot', userAgent: 'ClaudeBot', status: 200, durationMs: 130 },
      ],
    )
    expect(check.status).toBe('pass')
  })

  it('skips the comparison when the browser fetch failed', () => {
    const check = checkBotUserAgent(
      { status: 500, durationMs: 100 },
      [{ token: 'GPTBot', userAgent: 'GPTBot', status: 403, durationMs: 40 }],
    )
    expect(check.applicable).toBe(false)
  })
})
