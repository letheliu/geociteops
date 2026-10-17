/**
 * 登录 IP 限流：进程内 Map 滑动窗口（默认 10 次/分钟）。
 *
 * - `check(ip)` 返回 boolean：true = 放行（并记录本次尝试），false = 超限拒绝；
 *   被拒绝的尝试不写入窗口（不延长封锁，攻击者持续打满时窗口自然滑走）。
 * - 每个键至多保留 limit 个时间戳，单键内存有界；键数量随不同 IP 增长，
 *   P0 单实例内存实现可接受（多实例部署需换 Redis 等共享存储，见计划）。
 */
export interface LoginRateLimiter {
  check(ip: string): boolean
}

export interface LoginRateLimiterOptions {
  /** 窗口内允许的最大尝试次数，默认 10 */
  limit?: number
  /** 窗口长度（毫秒），默认 60_000 */
  windowMs?: number
}

const DEFAULT_LIMIT = 10
const DEFAULT_WINDOW_MS = 60_000

export function createLoginRateLimiter(
  options: LoginRateLimiterOptions = {},
): LoginRateLimiter {
  const limit = options.limit ?? DEFAULT_LIMIT
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const hits = new Map<string, number[]>()

  return {
    check(ip: string): boolean {
      const now = Date.now()
      const windowStart = now - windowMs
      const recent = (hits.get(ip) ?? []).filter((t) => t > windowStart)
      if (recent.length >= limit) {
        hits.set(ip, recent)
        return false
      }
      recent.push(now)
      hits.set(ip, recent)
      return true
    },
  }
}
