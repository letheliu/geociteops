import { createSlidingWindowLimiter } from '../../core/lib/sliding-window-limiter.js'
import type { SlidingWindowLimiter } from '../../core/lib/sliding-window-limiter.js'

// ---------------------------------------------------------------------------
// 自助注册服务（M2 §3.0 规格 §3/§4/§5）：
// - 防滥用：公开入口双限速；
// - 五件套开通（User/Organization/Workspace/Order+OrderItem/Subscription 单事务）；
// - 提交后 recompute（entitlement 机器），不嵌套事务、不走 order.activate worker。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// §4 限速与防滥用
//
// 公开入口必须双限速：
// - 每 IP 3 次 / 小时（3.6e6ms 滑窗）：挡住单 IP 脚本刷试用租户；
// - 全局 50 次 / 24h 滑窗：挡住换 IP 的分布式批量注册。
// 两个限速器都是进程内实现（与登录限流同款取舍）：多实例部署时限速会被稀释，
// 届时升级为共享存储。
// ---------------------------------------------------------------------------

/** 每 IP 窗口内允许的注册次数 */
export const REGISTRATION_IP_LIMIT = 3
/** 每 IP 滑窗长度（1 小时） */
export const REGISTRATION_IP_WINDOW_MS = 3_600_000
/** 全局窗口内允许的注册次数 */
export const REGISTRATION_GLOBAL_LIMIT = 50
/** 全局滑窗长度（24 小时） */
export const REGISTRATION_GLOBAL_WINDOW_MS = 86_400_000
/** 全局限速器的共享键（所有 IP 落在同一键上） */
const GLOBAL_KEY = '__registration_global__'

/** 限速拒绝的命中面：ip = 单 IP 超限，global = 全局总量超限 */
export type RateLimitScope = 'ip' | 'global'

export interface RegistrationRateLimiter {
  /** 放行返回 null；被拒返回命中面（供上层映射 TOO_MANY_REQUESTS 与文案） */
  check(ip: string): RateLimitScope | null
}

export interface RegistrationRateLimiterOptions {
  /** 时钟注入（毫秒），测试用假时钟推进两个窗口 */
  now?: () => number
  ipLimiter?: SlidingWindowLimiter
  globalLimiter?: SlidingWindowLimiter
}

export function createRegistrationRateLimiter(
  options: RegistrationRateLimiterOptions = {},
): RegistrationRateLimiter {
  const now = options.now ?? (() => Date.now())
  const ipLimiter =
    options.ipLimiter ??
    createSlidingWindowLimiter({
      limit: REGISTRATION_IP_LIMIT,
      windowMs: REGISTRATION_IP_WINDOW_MS,
      now,
      label: 'register-ip',
    })
  const globalLimiter =
    options.globalLimiter ??
    createSlidingWindowLimiter({
      limit: REGISTRATION_GLOBAL_LIMIT,
      windowMs: REGISTRATION_GLOBAL_WINDOW_MS,
      now,
      label: 'register-global',
    })

  return {
    check(ip: string): RateLimitScope | null {
      // 先 IP 面后全局面：命中层决定用户看到的文案，也避免被限的请求白白消耗
      // 全局配额（全局计数只应在两道都放行时前进）
      if (!ipLimiter.check(ip)) return 'ip'
      if (!globalLimiter.check(GLOBAL_KEY)) return 'global'
      return null
    },
  }
}
