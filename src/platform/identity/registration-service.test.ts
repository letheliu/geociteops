import { describe, expect, it } from 'vitest'
import {
  REGISTRATION_GLOBAL_LIMIT,
  REGISTRATION_IP_LIMIT,
  REGISTRATION_IP_WINDOW_MS,
  REGISTRATION_GLOBAL_WINDOW_MS,
  createRegistrationRateLimiter,
} from './registration-service.js'

// ---------------------------------------------------------------------------
// 注册限速（规格 §4）：每 IP 3 次/小时 + 全局 50 次/24h 双滑窗。
// 阈值常量一并钉住——它们是防滥用的产品决策值，改动应走评审而非随手调。
// ---------------------------------------------------------------------------

function fakeClock(start = 0) {
  let current = start
  return {
    now: () => current,
    advance(ms: number) {
      current += ms
    },
  }
}

describe('注册限速阈值常量', () => {
  it('每 IP 3 次 / 3.6e6ms；全局 50 次 / 24h', () => {
    expect(REGISTRATION_IP_LIMIT).toBe(3)
    expect(REGISTRATION_IP_WINDOW_MS).toBe(3_600_000)
    expect(REGISTRATION_GLOBAL_LIMIT).toBe(50)
    expect(REGISTRATION_GLOBAL_WINDOW_MS).toBe(86_400_000)
  })
})

describe('createRegistrationRateLimiter（每 IP 滑窗）', () => {
  it('同一 IP 前三次放行，第 4 次拒绝并标记 ip 面', () => {
    const clock = fakeClock()
    const limiter = createRegistrationRateLimiter({ now: clock.now })
    expect(limiter.check('1.1.1.1')).toBeNull()
    expect(limiter.check('1.1.1.1')).toBeNull()
    expect(limiter.check('1.1.1.1')).toBeNull()
    expect(limiter.check('1.1.1.1')).toBe('ip')
  })

  it('不同 IP 各自独立（同一时刻互不消耗额度）', () => {
    const limiter = createRegistrationRateLimiter({ now: fakeClock().now })
    expect(limiter.check('1.1.1.1')).toBeNull()
    expect(limiter.check('1.1.1.1')).toBeNull()
    expect(limiter.check('1.1.1.1')).toBeNull()
    expect(limiter.check('2.2.2.2')).toBeNull()
  })

  it('窗口滑走（> 1 小时）后同一 IP 恢复', () => {
    const clock = fakeClock(0)
    const limiter = createRegistrationRateLimiter({ now: clock.now })
    for (let i = 0; i < 3; i++) expect(limiter.check('1.1.1.1')).toBeNull()
    expect(limiter.check('1.1.1.1')).toBe('ip')
    clock.advance(REGISTRATION_IP_WINDOW_MS + 1)
    expect(limiter.check('1.1.1.1')).toBeNull()
  })
})

describe('createRegistrationRateLimiter（全局滑窗）', () => {
  it('换 IP 刷满 50 次后第 51 次拒绝，标记 global 面', () => {
    const limiter = createRegistrationRateLimiter({ now: fakeClock().now })
    for (let i = 0; i < REGISTRATION_GLOBAL_LIMIT; i++) {
      expect(limiter.check(`10.0.0.${i}`)).toBeNull()
    }
    // 第 51 次来自一个"全新"IP（未触 IP 面），命中的只能是全局窗口
    expect(limiter.check('203.0.113.1')).toBe('global')
  })

  it('全局窗口滑走（> 24h）后恢复', () => {
    const clock = fakeClock(0)
    const limiter = createRegistrationRateLimiter({ now: clock.now })
    for (let i = 0; i < REGISTRATION_GLOBAL_LIMIT; i++) limiter.check(`10.0.0.${i}`)
    expect(limiter.check('203.0.113.1')).toBe('global')
    clock.advance(REGISTRATION_GLOBAL_WINDOW_MS + 1)
    expect(limiter.check('203.0.113.1')).toBeNull()
  })

  it('被 IP 面拒绝的请求不消耗全局额度（先查 IP 后查全局）', () => {
    const limiter = createRegistrationRateLimiter({ now: fakeClock().now })
    for (let i = 0; i < 3; i++) limiter.check('1.1.1.1')
    // 该 IP 之后全部撞 IP 面
    for (let i = 0; i < 10; i++) expect(limiter.check('1.1.1.1')).toBe('ip')
    // 全局只应记了 3 次，其余 IP 仍可正常放行
    for (let i = 0; i < REGISTRATION_GLOBAL_LIMIT - 3; i++) {
      expect(limiter.check(`172.16.0.${i}`)).toBeNull()
    }
    expect(limiter.check('203.0.113.1')).toBe('global')
  })
})
