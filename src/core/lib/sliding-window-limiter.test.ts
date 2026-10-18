import { describe, expect, it } from 'vitest'
import { createSlidingWindowLimiter } from './sliding-window-limiter.js'

// ---------------------------------------------------------------------------
// 共享滑窗限速器：登录限流与自助注册限流共用的唯一实现。
// 时钟注入（now）而非假时钟，便于同进程内两个窗口分别推进。
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

describe('createSlidingWindowLimiter（共享滑动窗口）', () => {
  it('窗口内达到 limit 次后放行，第 limit+1 次拒绝', () => {
    const clock = fakeClock(1000)
    const limiter = createSlidingWindowLimiter({ limit: 3, windowMs: 60_000, now: clock.now })
    expect(limiter.check('k')).toBe(true)
    expect(limiter.check('k')).toBe(true)
    expect(limiter.check('k')).toBe(true)
    expect(limiter.check('k')).toBe(false)
  })

  it('被拒的尝试不写入窗口（不延长封锁）：持续打满直到旧记录滑出才恢复', () => {
    const clock = fakeClock(0)
    const limiter = createSlidingWindowLimiter({ limit: 2, windowMs: 1000, now: clock.now })
    expect(limiter.check('k')).toBe(true)
    expect(limiter.check('k')).toBe(true)

    // 第 3~5 次全被拒；若被拒也写入窗口，窗口会被无限续期
    for (let i = 0; i < 3; i++) {
      clock.advance(100)
      expect(limiter.check('k')).toBe(false)
    }

    // 第一条记录在 t=0 写入，窗口起点 t-1000 > 0 的记录才有效：滑到 1000 后恢复
    clock.advance(900) // t = 1200，两条 t=0/t=100 的记录都滑出
    expect(limiter.check('k')).toBe(true)
    expect(limiter.check('k')).toBe(true)
    expect(limiter.check('k')).toBe(false)
  })

  it('部分滑走：窗口内只剩 1 条历史时立即恢复一次额度', () => {
    const clock = fakeClock(0)
    const limiter = createSlidingWindowLimiter({ limit: 2, windowMs: 1000, now: clock.now })
    expect(limiter.check('k')).toBe(true) // t=0
    clock.advance(600)
    expect(limiter.check('k')).toBe(true) // t=600
    expect(limiter.check('k')).toBe(false) // 超限
    // t=1000：t=0 的记录滑出（windowStart=0，记录 0 不满足 t > 0）
    clock.advance(400)
    expect(limiter.check('k')).toBe(true)
  })

  it('不同键互不影响', () => {
    const limiter = createSlidingWindowLimiter({ limit: 1, windowMs: 1000, now: fakeClock().now })
    expect(limiter.check('a')).toBe(true)
    expect(limiter.check('a')).toBe(false)
    expect(limiter.check('b')).toBe(true)
  })

  it('缺省时钟走系统时间（Date.now）', () => {
    const limiter = createSlidingWindowLimiter({ limit: 1, windowMs: 1 })
    expect(limiter.check('k')).toBe(true)
    expect(limiter.check('k')).toBe(false)
  })
})
