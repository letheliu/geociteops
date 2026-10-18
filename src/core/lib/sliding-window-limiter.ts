/**
 * 共享滑动窗口限速器（进程内实现）。
 *
 * - `check(key)` 返回 boolean：true = 放行（并记录本次尝试），false = 超限拒绝；
 *   **被拒绝的尝试不写入窗口**（不延长封锁，攻击者持续打满时窗口自然滑走）。
 * - 每个键至多保留 limit 个时间戳，单键内存有界；键数量随不同 IP/键增长，
 *   P0 单实例内存实现可接受（多实例部署需换 Redis 等共享存储，与登录限流同款取舍）。
 *
 * 从 identity/rate-limiter.ts（登录限流）提炼而来：登录与自助注册共用同一实现，
 * 差别只在阈值（窗口长度与次数），不再各写一份滑窗算法。
 */
export interface SlidingWindowLimiter {
  /** 放行返回 true 并计入窗口；超限返回 false 且不计入窗口 */
  check(key: string): boolean
}

export interface SlidingWindowOptions {
  /** 窗口内允许的最大次数 */
  limit: number
  /** 窗口长度（毫秒） */
  windowMs: number
  /** 时钟注入（毫秒），缺省 Date.now；测试用假时钟推进窗口 */
  now?: () => number
  /** 日志标签（便于多限速器共存时定位） */
  label?: string
}

export function createSlidingWindowLimiter(options: SlidingWindowOptions): SlidingWindowLimiter {
  const { limit, windowMs } = options
  const now = options.now ?? (() => Date.now())
  const hits = new Map<string, number[]>()

  return {
    check(key: string): boolean {
      const at = now()
      const windowStart = at - windowMs
      const recent = (hits.get(key) ?? []).filter((t) => t > windowStart)
      if (recent.length >= limit) {
        hits.set(key, recent)
        return false
      }
      recent.push(at)
      hits.set(key, recent)
      return true
    },
  }
}
