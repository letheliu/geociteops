import { createSlidingWindowLimiter } from '../../core/lib/sliding-window-limiter.js'
import type { SlidingWindowLimiter } from '../../core/lib/sliding-window-limiter.js'

/**
 * 登录 IP 限流：进程内 Map 滑动窗口（默认 10 次/分钟）。
 *
 * 实现已提炼到 core/lib/sliding-window-limiter.ts（自助注册限流共用），
 * 本文件只保留登录侧阈值与命名，接口与行为不变。
 */
export interface LoginRateLimiter extends SlidingWindowLimiter {}

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
  return createSlidingWindowLimiter({
    limit: options.limit ?? DEFAULT_LIMIT,
    windowMs: options.windowMs ?? DEFAULT_WINDOW_MS,
    label: 'login',
  })
}
